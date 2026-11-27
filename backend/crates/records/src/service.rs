use crate::{
    cursor::{self, Cursor},
    query::ListQuery,
    registry::{EntityDefinition, ReadAccess, WriteAccess},
};
use kernel::viewer::Viewer;
use kernel::{AppError, AppResult, ErrorCode};
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, QueryBuilder};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(FromRow)]
pub struct Record {
    pub id: Uuid,
    pub entity: String,
    pub owner_id: Uuid,
    pub team_id: Option<Uuid>,
    pub admin_hidden_at: Option<OffsetDateTime>,
    pub data: Value,
    pub visibility: String,
    pub version: i32,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}
impl Record {
    pub fn json(&self) -> AppResult<Value> {
        Ok(
            serde_json::json!({"id":self.id,"entity":self.entity,"ownerId":self.owner_id,"teamId":self.team_id,"moderationHidden":self.admin_hidden_at.is_some(),"data":self.data,"visibility":self.visibility,"version":self.version,"createdAt":self.created_at.format(&Rfc3339).map_err(AppError::internal)?,"updatedAt":self.updated_at.format(&Rfc3339).map_err(AppError::internal)?}),
        )
    }
    /// A hidden record is visible only to its owner and global admins, whatever its schema or
    /// visibility says. Used for personal and team records alike.
    pub fn hidden_visible(&self, viewer: Option<&Viewer>) -> bool {
        self.admin_hidden_at.is_none()
            || viewer.is_some_and(|v| v.is_admin() || v.id == self.owner_id)
    }
    pub fn readable(&self, d: &EntityDefinition, viewer: Option<&Viewer>) -> bool {
        self.team_id.is_none() && self.is_personally_readable(d, viewer)
    }
    pub fn is_personally_readable(&self, d: &EntityDefinition, viewer: Option<&Viewer>) -> bool {
        if self.team_id.is_some() || !self.hidden_visible(viewer) {
            return false;
        }
        let privileged = viewer.is_some_and(|v| v.is_admin() || v.id == self.owner_id);
        privileged
            || d.read == ReadAccess::Public
            || d.read == ReadAccess::Authenticated && viewer.is_some()
            || self.visibility == "public" && (d.allow_public || d.read == ReadAccess::Public)
    }
    pub fn writable(&self, d: &EntityDefinition, viewer: &Viewer) -> bool {
        self.team_id.is_none()
            && (viewer.is_admin() || d.write == WriteAccess::Owner && viewer.id == self.owner_id)
    }
    pub async fn can_read(
        &self,
        db: &PgPool,
        d: &EntityDefinition,
        viewer: Option<&Viewer>,
    ) -> AppResult<bool> {
        match (self.team_id, viewer) {
            (Some(team), Some(v)) => {
                if !self.hidden_visible(viewer) {
                    return Ok(false);
                }
                Ok(teams::role_of(db, team, v.id).await?.is_some())
            }
            (Some(_), None) => Ok(false),
            (None, _) => Ok(self.readable(d, viewer)),
        }
    }
    pub async fn can_write(
        &self,
        db: &PgPool,
        d: &EntityDefinition,
        viewer: &Viewer,
    ) -> AppResult<bool> {
        if let Some(team) = self.team_id {
            if !self.hidden_visible(Some(viewer)) {
                return Ok(false);
            }
            let role = teams::role_of(db, team, viewer.id).await?;
            Ok(role.is_some_and(|r| {
                r >= teams::TeamRole::Admin
                    || r >= teams::TeamRole::Member && viewer.id == self.owner_id
            }))
        } else {
            Ok(self.writable(d, viewer))
        }
    }
}
pub async fn get(db: &PgPool, entity: &str, id: Uuid) -> AppResult<Record> {
    sqlx::query_as::<_, Record>("select r.id,r.entity,r.owner_id,r.team_id,r.admin_hidden_at,r.data,r.visibility,r.version,r.created_at,r.updated_at from records r join users u on u.id=r.owner_id where r.entity=$1 and r.id=$2 and r.deleted_at is null and u.deleted_at is null")
        .bind(entity).bind(id).fetch_optional(db).await?.ok_or_else(AppError::not_found)
}
/// The sort key for a field. Stored rows can hold another JSON type after a schema change, so only
/// values of the declared type sort; any other value sorts as null (last) instead of failing a cast.
fn sort_expr<'a>(b: &mut QueryBuilder<'a, Postgres>, field: &'a str, kind: &str) {
    match field {
        "createdAt" => {
            b.push("r.created_at");
        }
        "updatedAt" => {
            b.push("r.updated_at");
        }
        _ => {
            let (json_type, cast) = match kind {
                "number" | "integer" => ("number", "::numeric"),
                "boolean" => ("boolean", "::boolean"),
                _ => ("string", ""),
            };
            b.push("(case when jsonb_typeof(r.data -> ")
                .push_bind(field)
                .push(") = '")
                .push(json_type)
                .push("' then (r.data ->> ")
                .push_bind(field)
                .push(")")
                .push(cast)
                .push(" end)");
        }
    }
}

/// The value a row's cursor carries for `field`. Must match `sort_expr`: other JSON types are null.
fn sort_value(data: &Value, field: &str, kind: &str) -> Value {
    let Some(value) = data.get(field) else {
        return Value::Null;
    };
    let fits = match kind {
        "number" | "integer" => value.is_number(),
        "boolean" => value.is_boolean(),
        _ => value.is_string(),
    };
    if fits { value.clone() } else { Value::Null }
}
fn search_rank<'a>(b: &mut QueryBuilder<'a, Postgres>, fields: &'a [String], search: &'a str) {
    b.push("ts_rank(records_search_vector(r.data, ")
        .push_bind(fields)
        .push("::text[]), websearch_to_tsquery('english'::regconfig, ")
        .push_bind(search)
        .push("))");
}
pub async fn list(
    db: &PgPool,
    entity: &str,
    d: &EntityDefinition,
    viewer: Option<&Viewer>,
    q: ListQuery,
) -> AppResult<Value> {
    if q.scope == "mine" && viewer.is_none() {
        return Err(AppError::unauthenticated());
    }
    if q.scope == "all" && !viewer.is_some_and(Viewer::is_admin) {
        return Err(AppError::forbidden());
    }
    if q.scope == "public" && !d.allow_public && d.read != ReadAccess::Public {
        return Err(AppError::bad_request("Public scope is not available."));
    }
    if !matches!(q.scope.as_str(), "mine" | "public" | "all" | "team") {
        return Err(AppError::bad_request("Invalid scope."));
    }
    if (q.scope == "team") != q.team_id.is_some() {
        return Err(AppError::bad_request(
            "Team ID must be used with team scope.",
        ));
    }
    if let Some(team) = q.team_id {
        let v = viewer.ok_or_else(AppError::unauthenticated)?;
        teams::require_role(db, team, v, teams::TeamRole::Viewer).await?;
    }
    let field = q.sort.strip_prefix('-').unwrap_or(&q.sort);
    let ty = &d.schema["properties"][field]["type"];
    let kind = ty
        .as_str()
        .or_else(|| {
            ty.as_array()
                .and_then(|a| a.iter().filter_map(Value::as_str).find(|s| *s != "null"))
        })
        .unwrap_or("string");
    let full_search = q.q.as_deref().filter(|s| s.chars().count() >= 3);
    let mut filters = q.filters.clone();
    filters.sort_by(|a, b| a.0.cmp(&b.0));
    let cursor_sort = serde_json::to_string(&(
        entity,
        &q.scope,
        q.team_id,
        viewer.map(|v| v.id),
        &q.sort,
        &q.q,
        &d.searchable,
        filters,
    ))
    .map_err(AppError::internal)?;
    let cur = q
        .cursor
        .as_deref()
        .map(|s| cursor::decode(s, &cursor_sort))
        .transpose()?;
    if let Some(c) = &cur
        && !c.v.is_null()
    {
        let valid = if full_search.is_some() {
            c.v.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0)
        } else if matches!(field, "createdAt" | "updatedAt") {
            c.v.as_str()
                .is_some_and(|s| OffsetDateTime::parse(s, &Rfc3339).is_ok())
        } else {
            match kind {
                "integer" | "number" => c.v.is_number(),
                "boolean" => c.v.is_boolean(),
                _ => c.v.is_string(),
            }
        };
        if !valid {
            return Err(AppError::bad_request("Invalid cursor."));
        }
    }
    let mut b = QueryBuilder::<Postgres>::new(
        "select r.id,r.entity,r.owner_id,r.team_id,r.admin_hidden_at,r.data,r.visibility,r.version,r.created_at,r.updated_at from records r join users u on u.id=r.owner_id where r.deleted_at is null and u.deleted_at is null and r.entity=",
    );
    b.push_bind(entity);
    if let Some(team) = q.team_id {
        b.push(" and r.team_id=").push_bind(team);
        b.push(" and exists (select 1 from team_members tm join teams t on t.id=tm.team_id join users member_user on member_user.id=tm.user_id where tm.team_id=r.team_id and tm.user_id=").push_bind(viewer.map(|v| v.id)).push(" and t.deleted_at is null and member_user.deleted_at is null)");
        // Same rule as `can_read`: hidden team records show only to their owner and global admins.
        if !viewer.is_some_and(Viewer::is_admin) {
            b.push(" and (r.admin_hidden_at is null or r.owner_id=")
                .push_bind(viewer.map(|v| v.id))
                .push(")");
        }
    } else {
        b.push(" and r.team_id is null");
    }
    if q.scope == "public" {
        b.push(" and r.admin_hidden_at is null");
    }
    match q.scope.as_str() {
        "mine" => {
            b.push(" and r.owner_id=").push_bind(viewer.map(|v| v.id));
        }
        "public" if d.read != ReadAccess::Public => {
            b.push(" and r.visibility='public'");
        }
        _ => {}
    }
    for (name, value) in &q.filters {
        b.push(" and r.data -> ")
            .push_bind(name)
            .push(" = ")
            .push_bind(value);
    }
    if let Some(search) = full_search {
        b.push(" and records_search_vector(r.data, ")
            .push_bind(&d.searchable)
            .push("::text[]) @@ websearch_to_tsquery('english'::regconfig, ")
            .push_bind(search)
            .push(")");
    } else if let Some(search) = &q.q {
        b.push(" and (");
        for (i, name) in d.searchable.iter().enumerate() {
            if i > 0 {
                b.push(" or ");
            }
            b.push("r.data ->> ")
                .push_bind(name)
                .push(" ilike ")
                .push_bind(format!("%{}%", crate::query::escape(search)))
                .push(" escape '\\'");
        }
        b.push(")");
    }
    if let (Some(c), Some(search)) = (&cur, full_search) {
        let rank =
            c.v.as_f64()
                .ok_or_else(|| AppError::bad_request("Invalid cursor."))? as f32;
        b.push(" and (");
        search_rank(&mut b, &d.searchable, search);
        b.push(" < ").push_bind(rank).push(" or (");
        search_rank(&mut b, &d.searchable, search);
        b.push(" = ")
            .push_bind(rank)
            .push(" and r.id < ")
            .push_bind(c.id)
            .push("))");
    } else if let Some(c) = &cur {
        b.push(" and (");
        sort_expr(&mut b, field, kind);
        if c.v.is_null() {
            b.push(" is null and r.id ")
                .push(if q.sort.starts_with('-') { "<" } else { ">" })
                .push_bind(c.id);
        } else {
            b.push(" is null or ");
            sort_expr(&mut b, field, kind);
            b.push(if q.sort.starts_with('-') {
                " < "
            } else {
                " > "
            });
            let val = if let Some(s) = c.v.as_str() {
                s.to_owned()
            } else {
                c.v.to_string()
            };
            b.push_bind(val.clone());
            if matches!(field, "createdAt" | "updatedAt") {
                b.push("::timestamptz");
            } else if matches!(kind, "integer" | "number") {
                b.push("::numeric");
            } else if kind == "boolean" {
                b.push("::boolean");
            }
            b.push(" or (");
            sort_expr(&mut b, field, kind);
            b.push(" = ").push_bind(val);
            if matches!(field, "createdAt" | "updatedAt") {
                b.push("::timestamptz");
            } else if matches!(kind, "integer" | "number") {
                b.push("::numeric");
            } else if kind == "boolean" {
                b.push("::boolean");
            }
            b.push(" and r.id ")
                .push(if q.sort.starts_with('-') { "<" } else { ">" })
                .push_bind(c.id)
                .push(")");
        }
        b.push(")");
    }
    b.push(" order by ");
    if let Some(search) = full_search {
        search_rank(&mut b, &d.searchable, search);
        b.push(" desc, r.id desc");
    } else {
        sort_expr(&mut b, field, kind);
        b.push(if q.sort.starts_with('-') {
            " desc nulls last, r.id desc"
        } else {
            " asc nulls last, r.id asc"
        });
    }
    b.push(" limit ").push_bind(q.limit + 1);
    let mut rows = b.build_query_as::<Record>().fetch_all(db).await?;
    let more = rows.len() > q.limit as usize;
    if more {
        rows.pop();
    }
    let next = if more {
        let last = rows
            .last()
            .ok_or_else(|| AppError::internal("missing cursor row"))?;
        let v = if let Some(search) = full_search {
            let rank: f32 = sqlx::query_scalar("select ts_rank(records_search_vector($1, $2::text[]), websearch_to_tsquery('english'::regconfig, $3))")
                .bind(&last.data).bind(&d.searchable).bind(search).fetch_one(db).await?;
            serde_json::json!(rank)
        } else {
            match field {
                "createdAt" => Value::String(
                    last.created_at
                        .format(&Rfc3339)
                        .map_err(AppError::internal)?,
                ),
                "updatedAt" => Value::String(
                    last.updated_at
                        .format(&Rfc3339)
                        .map_err(AppError::internal)?,
                ),
                _ => sort_value(&last.data, field, kind),
            }
        };
        Some(cursor::encode(&Cursor {
            v,
            id: last.id,
            s: cursor_sort,
        })?)
    } else {
        None
    };
    let items: Vec<Value> = rows.iter().map(Record::json).collect::<AppResult<_>>()?;
    Ok(serde_json::json!({"data":items,"meta":{"nextCursor":next}}))
}
fn field_path(pointer: &str) -> String {
    pointer
        .split('/')
        .skip(1)
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect::<Vec<_>>()
        .join(".")
}

fn child_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_owned()
    } else {
        format!("{parent}.{child}")
    }
}

fn type_message(kind: &jsonschema::error::TypeKind) -> &'static str {
    use jsonschema::{JsonType, error::TypeKind};
    let has = |ty| match kind {
        TypeKind::Single(actual) => *actual == ty,
        TypeKind::Multiple(actual) => actual.contains(ty),
    };
    let types = [
        JsonType::String,
        JsonType::Integer,
        JsonType::Number,
        JsonType::Boolean,
        JsonType::Array,
        JsonType::Object,
    ];
    let count = types.iter().filter(|&&ty| has(ty)).count();
    if count == 1 {
        if has(JsonType::String) {
            "Must be text."
        } else if has(JsonType::Integer) {
            "Must be a whole number."
        } else if has(JsonType::Number) {
            "Must be a number."
        } else if has(JsonType::Boolean) {
            "Must be true or false."
        } else if has(JsonType::Array) {
            "Must be a list."
        } else {
            "Must be an object."
        }
    } else if count == 2 && has(JsonType::Integer) && has(JsonType::Number) {
        "Must be a number."
    } else {
        "This value has the wrong type."
    }
}

/// `touched` is set for a PATCH: at the root, only the keys the request names are checked for
/// unknown fields. Other root keys are legacy keys that a schema change left behind.
fn validation_details(
    error: &jsonschema::ValidationError<'_>,
    touched: Option<&[String]>,
) -> Vec<Value> {
    use jsonschema::error::ValidationErrorKind as K;
    let path = field_path(&error.instance_path().to_string());
    let detail = |path: String, message: String| serde_json::json!({"path":path,"message":message});
    match error.kind() {
        K::Required { property } => vec![detail(
            child_path(&path, property.as_str().unwrap_or("")),
            "This field is required.".into(),
        )],
        K::AdditionalProperties { unexpected } | K::UnevaluatedProperties { unexpected } => {
            unexpected
                .iter()
                .filter(|name| match touched {
                    Some(keys) if path.is_empty() => keys.iter().any(|key| key == *name),
                    _ => true,
                })
                .map(|name| detail(child_path(&path, name), "This field isn't allowed.".into()))
                .collect()
        }
        kind => {
            let message = match kind {
                K::Type { kind } => type_message(kind).to_owned(),
                K::MinLength { limit: 1 } => "This field cannot be empty.".into(),
                K::MinLength { limit } => format!("Use at least {limit} characters."),
                K::MaxLength { limit } => format!("Use at most {limit} characters."),
                K::Minimum { limit } => format!("Must be at least {limit}."),
                K::Maximum { limit } => format!("Must be at most {limit}."),
                K::ExclusiveMinimum { limit } => format!("Must be greater than {limit}."),
                K::ExclusiveMaximum { limit } => format!("Must be less than {limit}."),
                K::MultipleOf { multiple_of } => format!("Must be a multiple of {multiple_of}."),
                K::MinItems { limit } | K::MinContains { limit } => {
                    format!("Use at least {limit} items.")
                }
                K::MaxItems { limit } | K::MaxContains { limit } => {
                    format!("Use at most {limit} items.")
                }
                K::MinProperties { limit } => format!("Provide at least {limit} fields."),
                K::MaxProperties { limit } => format!("Provide at most {limit} fields."),
                K::UniqueItems => "Items must be unique.".into(),
                K::Enum { options } => {
                    let choices = options
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    format!("Choose one of: {choices}")
                }
                K::Constant { .. } => "This value is not allowed.".into(),
                K::Format { format } => match format.as_str() {
                    "date-time" => "Enter a valid date and time.",
                    "date" => "Enter a valid date.",
                    "time" => "Enter a valid time.",
                    "email" | "idn-email" => "Enter a valid email address.",
                    "uri" | "uri-reference" | "iri" | "iri-reference" => "Enter a valid URL.",
                    _ => "Enter a valid value.",
                }
                .into(),
                K::Pattern { .. } | K::BacktrackLimitExceeded { .. } => {
                    "Use the expected format.".into()
                }
                K::AdditionalItems { limit } => format!("Use at most {limit} items."),
                K::ContentEncoding { .. } | K::ContentMediaType { .. } | K::FromUtf8 { .. } => {
                    "Enter valid content.".into()
                }
                K::PropertyNames { .. } => "A field name is not allowed.".into(),
                _ => "This value is not valid.".into(),
            };
            vec![detail(path, message)]
        }
    }
}

/// Strict validation of a whole record. Used for creates.
pub(crate) fn validate(d: &crate::registry::Entity, data: &Value) -> AppResult<()> {
    check(d.validator.iter_errors(data), None)
}

/// Validation for a PATCH of the whole merged record. It checks the keys the request names
/// (`touched`) and the required fields. Other stored keys are accepted as saved, so one legacy key
/// that a schema change removed does not block every edit to the record.
pub(crate) fn validate_patch(
    d: &crate::registry::Entity,
    data: &Value,
    touched: &[String],
) -> AppResult<()> {
    check(
        d.validator
            .iter_errors(data)
            .filter(|error| patch_checks(error, touched)),
        Some(touched),
    )
}

fn check<'a>(
    errors: impl Iterator<Item = jsonschema::ValidationError<'a>>,
    touched: Option<&[String]>,
) -> AppResult<()> {
    let errors: Vec<Value> = errors
        .flat_map(|e| validation_details(&e, touched))
        .take(20)
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::ValidationFailed,
            "Please check the highlighted fields.",
        )
        .with_details(Value::Array(errors)))
    }
}

/// Whether a schema error belongs to a PATCH that touches `touched` root keys.
fn patch_checks(error: &jsonschema::ValidationError<'_>, touched: &[String]) -> bool {
    use jsonschema::error::ValidationErrorKind as K;
    let pointer = error.instance_path().to_string();
    if pointer.is_empty() {
        return match error.kind() {
            // Required fields are checked even when the request does not touch them.
            K::Required { .. } => true,
            K::AdditionalProperties { unexpected } | K::UnevaluatedProperties { unexpected } => {
                unexpected
                    .iter()
                    .any(|name| touched.iter().any(|t| t == name))
            }
            // Whole-object rules (field counts) apply only when the request changes something.
            _ => !touched.is_empty(),
        };
    }
    top_key(&pointer).is_some_and(|key| touched.contains(&key))
}

/// The top-level key a JSON Pointer such as `/tags/2` sits under.
fn top_key(pointer: &str) -> Option<String> {
    let first = pointer.strip_prefix('/')?.split('/').next()?;
    Some(first.replace("~1", "/").replace("~0", "~"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod validation_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn friendly_schema_errors_and_nested_paths() {
        let config = json!({"x":{"label":"X","read":"owner","create":"authenticated","write":"owner","allowPublic":false,"maxPerOwner":2,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"required":["name"],"properties":{
            "name":{"type":"string","maxLength":5},
            "tags":{"type":"array","minItems":1,"maxItems":2,"items":{"type":"string","maxLength":3}},
            "age":{"type":"integer","minimum":1,"maximum":5},
            "choice":{"type":"string","maxLength":10,"enum":["a","b"]},
            "email":{"type":"string","maxLength":50,"format":"email"},
            "date":{"type":"string","maxLength":50,"format":"date-time"},
            "url":{"type":"string","maxLength":50,"format":"uri"}
        }}}});
        let registry = crate::registry::parse_registry(&config.to_string()).unwrap();
        let entity = &registry.entities["x"];
        for (data, path, message) in [
            (json!({}), "name", "This field is required."),
            (json!({"name":""}), "name", "This field cannot be empty."),
            (json!({"name":5}), "name", "Must be text."),
            (
                json!({"name":"abcdef"}),
                "name",
                "Use at most 5 characters.",
            ),
            (
                json!({"name":"x","tags":["a","b","long"]}),
                "tags.2",
                "Use at most 3 characters.",
            ),
            (
                json!({"name":"x","tags":[]}),
                "tags",
                "Use at least 1 items.",
            ),
            (json!({"name":"x","age":0}), "age", "Must be at least 1."),
            (json!({"name":"x","age":6}), "age", "Must be at most 5."),
            (
                json!({"name":"x","choice":"c"}),
                "choice",
                "Choose one of: a, b",
            ),
            (
                json!({"name":"x","email":"bad"}),
                "email",
                "Enter a valid email address.",
            ),
            (
                json!({"name":"x","date":"bad"}),
                "date",
                "Enter a valid date and time.",
            ),
            (json!({"name":"x","url":"bad"}), "url", "Enter a valid URL."),
            (
                json!({"name":"x","extra":1}),
                "extra",
                "This field isn't allowed.",
            ),
        ] {
            let error = validate(entity, &data).unwrap_err();
            assert_eq!(error.message, "Please check the highlighted fields.");
            let details = error.details.unwrap();
            assert!(
                details
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|d| d["path"] == path && d["message"] == message),
                "{data}: {details}"
            );
        }
    }

    #[test]
    fn top_key_decodes_pointer_escapes() {
        assert_eq!(top_key("/tags/2").as_deref(), Some("tags"));
        assert_eq!(top_key("/a~1b/c~0d").as_deref(), Some("a/b"));
        assert_eq!(top_key(""), None);
    }

    #[test]
    fn sort_value_keeps_only_the_declared_type() {
        let data = json!({"n":3,"s":"x","b":true,"z":null});
        assert_eq!(sort_value(&data, "n", "integer"), json!(3));
        assert_eq!(sort_value(&data, "s", "integer"), Value::Null);
        assert_eq!(sort_value(&data, "b", "boolean"), json!(true));
        assert_eq!(sort_value(&data, "s", "string"), json!("x"));
        assert_eq!(sort_value(&data, "n", "string"), Value::Null);
        assert_eq!(sort_value(&data, "missing", "string"), Value::Null);
    }
}
