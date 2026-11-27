//! Bounded, access-controlled aggregations over configured records.
use axum::{
    Extension, Json, Router,
    extract::{RawQuery, State},
    routing::get,
};
use kernel::extract::Path;
use kernel::{AppError, AppResult, AppState, ErrorCode, viewer::Viewer};
use records::{
    query,
    registry::{EntityDefinition, EntityRegistry, ReadAccess},
};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row};
use std::{collections::HashSet, sync::Arc};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

struct StatsQuery {
    metric: String,
    group: Option<String>,
    from: OffsetDateTime,
    to: OffsetDateTime,
    list: query::ListQuery,
}

fn has_type(prop: &Value, kind: &str) -> bool {
    prop["type"] == kind
        || prop["type"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == kind))
}

fn only_types(prop: &Value, allowed: &[&str]) -> bool {
    let kinds: Vec<&str> = match &prop["type"] {
        Value::String(kind) => vec![kind],
        Value::Array(kinds) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => return false,
    };
    !kinds.is_empty()
        && kinds
            .iter()
            .all(|kind| *kind == "null" || allowed.contains(kind))
}

fn parse(raw: Option<&str>, def: &EntityDefinition, now: OffsetDateTime) -> AppResult<StatsQuery> {
    let raw = raw.unwrap_or("");
    if raw.len() > 8192 {
        return Err(query::query_error("", "Please enter a valid value."));
    }
    let mut seen = HashSet::new();
    let (mut metric, mut group, mut from, mut to) = (None, None, None, None);
    let mut list_parts = Vec::new();
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        // Reject malformed percent escapes instead of accepting lossy decoding.
        let bytes = pair.as_bytes();
        for (i, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit())
            {
                let key = pair.split_once('=').map_or(pair, |(key, _)| key);
                let key = url::form_urlencoded::parse(format!("{key}=").as_bytes())
                    .next()
                    .map(|(key, _)| key.into_owned())
                    .unwrap_or_default();
                return Err(query::query_error(&key, "Please enter a valid value."));
            }
        }
        let (key, value) = url::form_urlencoded::parse(pair.as_bytes())
            .next()
            .ok_or_else(|| query::query_error("", "Please enter a valid value."))?;
        if !seen.insert(key.to_string()) {
            return Err(query::query_error(&key, "Please enter this only once."));
        }
        if value.len() > 2048 {
            return Err(query::query_error(&key, "This value is too long."));
        }
        match key.as_ref() {
            "metric" => metric = Some(value.into_owned()),
            "groupBy" => group = Some(value.into_owned()),
            "from" => {
                from = Some(
                    OffsetDateTime::parse(&value, &Rfc3339)
                        .map_err(|_| query::query_error("from", "Please enter a valid value."))?,
                )
            }
            "to" => {
                to = Some(
                    OffsetDateTime::parse(&value, &Rfc3339)
                        .map_err(|_| query::query_error("to", "Please enter a valid value."))?,
                )
            }
            "scope" | "teamId" => list_parts.push(pair),
            k if k.starts_with("filter[") && k.ends_with(']') => list_parts.push(pair),
            _ => return Err(query::query_error(&key, "This field isn't allowed.")),
        }
    }
    let metric = metric.ok_or_else(|| query::query_error("metric", "This field is required."))?;
    if metric != "count" {
        let (op, field) = metric
            .split_once(':')
            .ok_or_else(|| query::query_error("metric", "Please enter a valid value."))?;
        let prop = &def.schema["properties"][field];
        if !matches!(op, "sum" | "avg" | "min" | "max")
            || !(has_type(prop, "integer") || has_type(prop, "number"))
            || !only_types(prop, &["integer", "number"])
        {
            return Err(query::query_error("metric", "Please enter a valid value."));
        }
    }
    if let Some(g) = &group {
        if let Some((field, bucket)) = g.split_once(':') {
            let prop = &def.schema["properties"][field];
            if !matches!(bucket, "day" | "week" | "month")
                || !(field == "createdAt"
                    || (has_type(prop, "string")
                        && only_types(prop, &["string"])
                        && prop["format"] == "date-time"))
            {
                return Err(query::query_error("groupBy", "Please enter a valid value."));
            }
        } else if !def.filterable.iter().any(|s| s == g)
            || !only_types(
                &def.schema["properties"][g],
                &["string", "number", "integer", "boolean"],
            )
        {
            return Err(query::query_error("groupBy", "Please enter a valid value."));
        }
    }
    let to = to.unwrap_or(now);
    let from = from.unwrap_or(to - Duration::days(30));
    if from >= to || to - from > Duration::days(366) {
        return Err(query::query_error(
            "from",
            "Please enter a valid date window.",
        ));
    }
    let list = query::parse(Some(&list_parts.join("&")), def)?;
    Ok(StatsQuery {
        metric,
        group,
        from,
        to,
        list,
    })
}

async fn aggregate(
    state: &AppState,
    name: &str,
    def: &EntityDefinition,
    viewer: Option<&Viewer>,
    q: StatsQuery,
) -> AppResult<Value> {
    match q.list.scope.as_str() {
        "mine" if viewer.is_none() => return Err(AppError::unauthenticated()),
        "all" if !viewer.is_some_and(Viewer::is_admin) => return Err(AppError::forbidden()),
        "public" if !def.allow_public && def.read != ReadAccess::Public => {
            return Err(query::query_error(
                "scope",
                "Public scope is not available.",
            ));
        }
        _ => {}
    }
    if let Some(team) = q.list.team_id {
        teams::require_role(
            &state.db,
            team,
            viewer.ok_or_else(AppError::unauthenticated)?,
            teams::TeamRole::Viewer,
        )
        .await?;
    }
    let mut b = QueryBuilder::<Postgres>::new("select ");
    if let Some(group) = &q.group {
        if let Some((field, bucket)) = group.split_once(':') {
            b.push("to_jsonb(to_char(date_trunc(")
                .push_bind(bucket)
                .push(", ");
            if field == "createdAt" {
                b.push("r.created_at");
            } else {
                b.push("(r.data ->> ")
                    .push_bind(field)
                    .push(")::timestamptz");
            }
            b.push(" AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))");
        } else {
            b.push("coalesce(r.data -> ")
                .push_bind(group)
                .push(", 'null'::jsonb)");
        }
    } else {
        b.push("'null'::jsonb");
    }
    b.push(" as key, ");
    if q.metric == "count" {
        b.push("to_jsonb(count(*))");
    } else {
        let (op, field) = q
            .metric
            .split_once(':')
            .ok_or_else(|| AppError::internal("invalid metric"))?;
        b.push(match op {
            "sum" => "to_jsonb(sum(",
            "avg" => "to_jsonb(avg(",
            "min" => "to_jsonb(min(",
            "max" => "to_jsonb(max(",
            _ => return Err(AppError::internal("invalid aggregate")),
        });
        b.push("(r.data ->> ").push_bind(field).push(")::numeric))");
    }
    b.push(" as value from records r join users u on u.id=r.owner_id where r.deleted_at is null and u.deleted_at is null and r.entity=").push_bind(name)
        .push(" and r.created_at >= ").push_bind(q.from).push(" and r.created_at < ").push_bind(q.to);
    if let Some(team) = q.list.team_id {
        b.push(" and r.team_id=").push_bind(team);
        b.push(" and exists (select 1 from team_members tm join teams t on t.id=tm.team_id join users member on member.id=tm.user_id where tm.team_id=r.team_id and tm.user_id=").push_bind(viewer.map(|v| v.id)).push(" and t.deleted_at is null and member.deleted_at is null)");
    } else {
        b.push(" and r.team_id is null");
    }
    if q.list.scope == "public" {
        b.push(" and r.admin_hidden_at is null");
    } else if q.list.team_id.is_some() && !viewer.is_some_and(Viewer::is_admin) {
        // Same rule as records: a hidden record is visible only to its owner and global admins.
        b.push(" and (r.admin_hidden_at is null or r.owner_id=")
            .push_bind(viewer.map(|v| v.id))
            .push(")");
    }
    match q.list.scope.as_str() {
        "mine" => {
            b.push(" and r.owner_id=").push_bind(viewer.map(|v| v.id));
        }
        "public" if def.read != ReadAccess::Public => {
            b.push(" and r.visibility='public'");
        }
        _ => {}
    }
    for (field, value) in &q.list.filters {
        b.push(" and r.data -> ")
            .push_bind(field)
            .push(" = ")
            .push_bind(value);
    }
    if q.group.is_some() {
        b.push(" group by 1 order by 1 limit 201");
    }
    let rows = b.build().fetch_all(&state.db).await?;
    if rows.len() > 200 {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            "Too many groups. Narrow your query.",
        ));
    }
    let mut data = Vec::with_capacity(rows.len());
    for row in rows {
        let key: Option<Value> = row.try_get("key")?;
        let value: Option<Value> = row.try_get("value")?;
        data.push(json!({"key":key,"value":value}));
    }
    Ok(json!({"data":data,"meta":{"metric":q.metric,"groupBy":q.group}}))
}
async fn stats(
    State(state): State<AppState>,
    Extension(registry): Extension<Arc<EntityRegistry>>,
    Path(entity): Path<String>,
    RawQuery(raw): RawQuery,
    viewer: Option<Viewer>,
) -> AppResult<Json<Value>> {
    let def = registry.definition(&entity)?;
    let q = parse(raw.as_deref(), def, OffsetDateTime::now_utc())?;
    Ok(Json(
        aggregate(&state, &entity, def, viewer.as_ref(), q).await?,
    ))
}
pub fn router() -> Router<AppState> {
    Router::new().route("/entities/{entity}/stats", get(stats))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use kernel::{config::Config, email::LogSender, viewer::Role};
    use sqlx::PgPool;
    use uuid::Uuid;

    fn registry() -> EntityRegistry {
        EntityRegistry::from_json(&json!({"items":{"label":"Item","read":"owner","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":1000,"sortable":[],"filterable":["amount","category","flag"],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{"amount":{"type":["number","null"]},"category":{"type":"string","maxLength":100},"flag":{"type":"boolean"},"when":{"type":"string","format":"date-time","maxLength":40}}}}}).to_string()).unwrap()
    }
    fn viewer(id: Uuid, admin: bool) -> Viewer {
        Viewer {
            id,
            session_id: Uuid::new_v4(),
            email: String::new(),
            display_name: String::new(),
            role: if admin { Role::Admin } else { Role::User },
            via_cookie: false,
        }
    }
    fn state(db: PgPool) -> AppState {
        AppState {
            db,
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
    async fn run(
        s: &AppState,
        d: &EntityDefinition,
        v: Option<&Viewer>,
        query: &str,
    ) -> AppResult<Value> {
        aggregate(
            s,
            "items",
            d,
            v,
            parse(Some(query), d, OffsetDateTime::now_utc())?,
        )
        .await
    }
    #[test]
    fn query_errors_identify_the_parameter() {
        let registry = registry();
        let definition = registry.definition("items").unwrap();
        for (query, path) in [
            ("metric=count&filter[flag]=yes", "filter.flag"),
            ("metric=count&filter[category]=%xx", "filter.category"),
            ("metric=count&extra=x", "extra"),
            ("metric=count&from=invalid", "from"),
        ] {
            let error = match parse(Some(query), definition, OffsetDateTime::now_utc()) {
                Ok(_) => panic!("invalid query accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code, ErrorCode::ValidationFailed);
            assert_eq!(error.details.unwrap()[0]["path"], path);
        }
    }
    #[test]
    fn rejects_invalid_query() {
        let r = registry();
        let d = r.definition("items").unwrap();
        let now = OffsetDateTime::now_utc();
        for q in [
            "",
            "metric=count&metric=count",
            "metric=count&x=1",
            "metric=sum:category",
            "metric=sum:amount%29%3Bdrop",
            "metric=count&groupBy=when:year",
            "metric=count&filter[flag]=yes",
            "metric=count&scope=mine&scope=public",
            "metric=count&from=2020-01-01T00:00:00Z&to=2022-01-01T00:00:00Z",
            "metric=count&filter[category]=%xx",
        ] {
            assert!(parse(Some(q), d, now).is_err(), "{q}");
        }
        assert!(
            parse(
                Some("metric=count&groupBy=when:week&filter[flag]=true"),
                d,
                now
            )
            .is_ok()
        );
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn access_aggregates_and_limits(db: PgPool) {
        let s = state(db.clone());
        let reg = registry();
        let d = reg.definition("items").unwrap();
        let a: Uuid =
            sqlx::query_scalar("insert into users(email) values('a@example.com') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let b: Uuid =
            sqlx::query_scalar("insert into users(email) values('b@example.com') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let gone: Uuid = sqlx::query_scalar(
            "insert into users(email,deleted_at) values('gone@example.com',now()) returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        for (owner, data, visibility, deleted) in [
            (
                a,
                json!({"amount":2,"category":"x","flag":true}),
                "private",
                false,
            ),
            (
                a,
                json!({"amount":null,"category":"x","flag":false}),
                "public",
                false,
            ),
            (
                b,
                json!({"amount":8,"category":"y","flag":true}),
                "public",
                false,
            ),
            (b, json!({"amount":100,"category":"z"}), "private", true),
            (gone, json!({"amount":500,"category":"z"}), "public", false),
        ] {
            sqlx::query("insert into records(entity,owner_id,data,visibility,deleted_at) values('items',$1,$2,$3,case when $4 then now() else null end)").bind(owner).bind(data).bind(visibility).bind(deleted).execute(&db).await.unwrap();
        }
        sqlx::query("insert into records(entity,owner_id,data,visibility,admin_hidden_at) values('items',$1,$2,'public',now())").bind(a).bind(json!({"amount":50,"category":"hidden"})).execute(&db).await.unwrap();
        let user = viewer(a, false);
        let admin = viewer(a, true);
        assert_eq!(
            run(
                &s,
                d,
                None,
                "metric=count&scope=public&filter[category]=hidden"
            )
            .await
            .unwrap()["data"][0]["value"],
            0
        );
        assert_eq!(
            run(
                &s,
                d,
                Some(&user),
                "metric=count&scope=mine&filter[category]=hidden"
            )
            .await
            .unwrap()["data"][0]["value"],
            1
        );
        sqlx::query("delete from records where entity='items' and admin_hidden_at is not null")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            run(&s, d, Some(&user), "metric=count").await.unwrap()["data"][0]["value"],
            2
        );
        assert_eq!(
            run(&s, d, None, "metric=count&scope=public").await.unwrap()["data"][0]["value"],
            2
        );
        assert!(
            run(&s, d, Some(&user), "metric=count&scope=all")
                .await
                .is_err()
        );
        assert_eq!(
            run(
                &s,
                d,
                Some(&admin),
                "metric=sum:amount&scope=all&filter[flag]=true"
            )
            .await
            .unwrap()["data"][0]["value"],
            10
        );
        assert_eq!(
            run(&s, d, Some(&user), "metric=avg:amount").await.unwrap()["data"][0]["value"],
            2.0
        );
        assert_eq!(
            run(
                &s,
                d,
                Some(&user),
                "metric=count&filter[category]=%27%20OR%20true--"
            )
            .await
            .unwrap()["data"][0]["value"],
            0
        );
        sqlx::query("insert into records(entity,owner_id,data) select 'items',$1,jsonb_build_object('category',i::text) from generate_series(1,201) i").bind(a).execute(&db).await.unwrap();
        assert_eq!(
            run(&s, d, Some(&user), "metric=count&groupBy=category")
                .await
                .unwrap_err()
                .code,
            ErrorCode::LimitReached
        );
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn team_aggregates_are_isolated_and_revocable(db: PgPool) {
        let s = state(db.clone());
        let reg = registry();
        let def = reg.definition("items").unwrap();
        let a: Uuid = sqlx::query_scalar(
            "insert into users(email) values('team-a@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let b: Uuid = sqlx::query_scalar(
            "insert into users(email) values('team-b@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let ta: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('A','team-a',$1) returning id",
        )
        .bind(a)
        .fetch_one(&db)
        .await
        .unwrap();
        let tb: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('B','team-b',$1) returning id",
        )
        .bind(b)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query(
            "insert into team_members(team_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",
        )
        .bind(ta)
        .bind(a)
        .bind(tb)
        .bind(b)
        .execute(&db)
        .await
        .unwrap();
        for (owner, team, amount) in [(a, None, 1), (a, Some(ta), 3), (b, Some(tb), 7)] {
            sqlx::query("insert into records(entity,owner_id,team_id,data,visibility) values('items',$1,$2,$3,'private')").bind(owner).bind(team).bind(json!({"amount":amount,"category":"x"})).execute(&db).await.unwrap();
        }
        let user = viewer(a, false);
        let admin = viewer(a, true);
        let outsider = viewer(b, false);
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'viewer')")
            .bind(ta)
            .bind(b)
            .execute(&db)
            .await
            .unwrap();
        let grouped = run(
            &s,
            def,
            Some(&outsider),
            &format!(
                "metric=sum:amount&groupBy=category&filter[category]=x&scope=team&teamId={ta}"
            ),
        )
        .await
        .unwrap();
        assert_eq!(grouped["data"].as_array().unwrap().len(), 1);
        assert_eq!(grouped["data"][0]["value"], 3.0);
        for query in [
            format!("metric=count&scope=team&teamId={tb}"),
            format!("metric=count&scope=mine&teamId={ta}"),
            "metric=count&scope=team".to_owned(),
            format!("metric=count&scope=team&teamId={ta}&teamId={tb}"),
        ] {
            assert!(run(&s, def, Some(&user), &query).await.is_err(), "{query}");
        }
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(ta)
            .bind(b)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            run(
                &s,
                def,
                Some(&outsider),
                &format!("metric=count&scope=team&teamId={ta}")
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::NotFound
        );
        assert!(
            run(
                &s,
                def,
                Some(&outsider),
                &format!("metric=count&scope=mine&teamId={ta}")
            )
            .await
            .is_err()
        );
        for metric in [
            "count",
            "sum:amount",
            "avg:amount",
            "min:amount",
            "max:amount",
        ] {
            let personal = format!("metric={metric}&scope=all");
            assert_eq!(
                run(&s, def, Some(&admin), &personal).await.unwrap()["data"][0]["value"].as_f64(),
                Some(1.0)
            );
            let team = format!("metric={metric}&scope=team&teamId={ta}");
            let expected = if metric == "count" { 1.0 } else { 3.0 };
            assert_eq!(
                run(&s, def, Some(&user), &team).await.unwrap()["data"][0]["value"].as_f64(),
                Some(expected)
            );
        }
        assert!(
            run(
                &s,
                def,
                Some(&admin),
                &format!("metric=count&scope=team&teamId={tb}")
            )
            .await
            .is_err()
        );
        assert_eq!(
            run(&s, def, None, "metric=count&scope=public")
                .await
                .unwrap()["data"][0]["value"],
            0
        );
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(ta)
            .bind(a)
            .execute(&db)
            .await
            .unwrap();
        assert!(
            run(
                &s,
                def,
                Some(&user),
                &format!("metric=count&scope=team&teamId={ta}")
            )
            .await
            .is_err()
        );
    }
    fn posts_registry() -> EntityRegistry {
        EntityRegistry::from_json(&json!({"posts":{"label":"Post","read":"public","create":"authenticated","write":"owner","allowPublic":true,"maxPerOwner":1000,"sortable":[],"filterable":[],"searchable":[],"schema":{"type":"object","additionalProperties":false,"properties":{"amount":{"type":"number"}}}}}).to_string()).unwrap()
    }
    async fn user_id(db: &PgPool, email: &str) -> Uuid {
        sqlx::query_scalar("insert into users(email) values($1) returning id")
            .bind(email)
            .fetch_one(db)
            .await
            .unwrap()
    }
    async fn value_of(
        s: &AppState,
        entity: &str,
        def: &EntityDefinition,
        v: Option<&Viewer>,
        query: &str,
    ) -> Value {
        aggregate(
            s,
            entity,
            def,
            v,
            parse(Some(query), def, OffsetDateTime::now_utc()).unwrap(),
        )
        .await
        .unwrap()
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn hidden_records_are_excluded_from_public_and_team_views(db: PgPool) {
        let s = state(db.clone());
        let reg = registry();
        let items = reg.definition("items").unwrap();
        let posts_reg = posts_registry();
        let posts = posts_reg.definition("posts").unwrap();
        let a = user_id(&db, "hide-a@example.com").await;
        let b = user_id(&db, "hide-b@example.com").await;
        for (entity, owner, data, visibility, hidden) in [
            (
                "items",
                a,
                json!({"amount":2,"category":"x","flag":true}),
                "public",
                false,
            ),
            (
                "items",
                b,
                json!({"amount":8,"category":"x","flag":true}),
                "public",
                false,
            ),
            (
                "items",
                a,
                json!({"amount":50,"category":"x","flag":true}),
                "public",
                true,
            ),
            (
                "items",
                b,
                json!({"amount":1,"category":"y","flag":false}),
                "private",
                false,
            ),
            ("posts", a, json!({"amount":3}), "private", false),
            ("posts", a, json!({"amount":40}), "public", true),
        ] {
            sqlx::query("insert into records(entity,owner_id,data,visibility,admin_hidden_at) values($1,$2,$3,$4,case when $5 then now() else null end)")
                .bind(entity)
                .bind(owner)
                .bind(data)
                .bind(visibility)
                .bind(hidden)
                .execute(&db)
                .await
                .unwrap();
        }
        let owner_a = viewer(a, false);
        let member_b = viewer(b, false);
        let admin_b = viewer(b, true);
        let value = |body: &Value| body["data"][0]["value"].as_f64();

        // Public views never include a moderated row, not even for its owner.
        for v in [None, Some(&owner_a)] {
            let count = value_of(&s, "items", items, v, "metric=count&scope=public").await;
            assert_eq!(value(&count), Some(2.0));
            let sum = value_of(&s, "items", items, v, "metric=sum:amount&scope=public").await;
            assert_eq!(value(&sum), Some(10.0));
            let max = value_of(&s, "items", items, v, "metric=max:amount&scope=public").await;
            assert_eq!(value(&max), Some(8.0));
            let flagged = value_of(
                &s,
                "items",
                items,
                v,
                "metric=count&scope=public&filter[flag]=true",
            )
            .await;
            assert_eq!(value(&flagged), Some(2.0));
        }
        let grouped = value_of(
            &s,
            "items",
            items,
            None,
            "metric=count&scope=public&groupBy=category",
        )
        .await;
        assert_eq!(grouped["data"], json!([{"key":"x","value":2}]));

        // The owner counts their own hidden row in personal scope.
        let mine = value_of(
            &s,
            "items",
            items,
            Some(&owner_a),
            "metric=count&scope=mine&groupBy=category",
        )
        .await;
        assert_eq!(mine["data"], json!([{"key":"x","value":2}]));
        let mine_sum = value_of(
            &s,
            "items",
            items,
            Some(&owner_a),
            "metric=sum:amount&scope=mine",
        )
        .await;
        assert_eq!(value(&mine_sum), Some(52.0));
        // Global admins see everything.
        let all = value_of(
            &s,
            "items",
            items,
            Some(&admin_b),
            "metric=sum:amount&scope=all",
        )
        .await;
        assert_eq!(value(&all), Some(61.0));

        // Public-read entities: the hidden row is still excluded, the private row is public there.
        let posts_public = value_of(&s, "posts", posts, None, "metric=count&scope=public").await;
        assert_eq!(value(&posts_public), Some(1.0));
        let posts_sum = value_of(&s, "posts", posts, None, "metric=sum:amount&scope=public").await;
        assert_eq!(value(&posts_sum), Some(3.0));
        let posts_mine = value_of(
            &s,
            "posts",
            posts,
            Some(&owner_a),
            "metric=count&scope=mine",
        )
        .await;
        assert_eq!(value(&posts_mine), Some(2.0));

        // Team scope follows the records rule: hidden team rows show only to owner and admins.
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Hidden','hidden-team',$1) returning id",
        )
        .bind(a)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query(
            "insert into team_members(team_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer')",
        )
        .bind(team)
        .bind(a)
        .bind(b)
        .execute(&db)
        .await
        .unwrap();
        for (amount, hidden) in [(5, true), (7, false)] {
            sqlx::query("insert into records(entity,owner_id,team_id,data,visibility,admin_hidden_at) values('items',$1,$2,$3,'private',case when $4 then now() else null end)")
                .bind(a)
                .bind(team)
                .bind(json!({"amount":amount,"category":"team"}))
                .bind(hidden)
                .execute(&db)
                .await
                .unwrap();
        }
        let team_query = format!("metric=sum:amount&scope=team&teamId={team}");
        let member_team = value_of(&s, "items", items, Some(&member_b), &team_query).await;
        assert_eq!(value(&member_team), Some(7.0));
        let owner_team = value_of(&s, "items", items, Some(&owner_a), &team_query).await;
        assert_eq!(value(&owner_team), Some(12.0));
        let admin_team = value_of(&s, "items", items, Some(&admin_b), &team_query).await;
        assert_eq!(value(&admin_team), Some(12.0));
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn buckets_use_utc_across_dst(db: PgPool) {
        let s = state(db.clone());
        let reg = registry();
        let d = reg.definition("items").unwrap();
        let id: Uuid =
            sqlx::query_scalar("insert into users(email) values('utc@example.com') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        sqlx::query("insert into records(entity,owner_id,data,created_at) values('items',$1,$2,'2026-03-08T01:30:00-05:00')").bind(id).bind(json!({"when":"2026-03-08T23:30:00-07:00"})).execute(&db).await.unwrap();
        let user = viewer(id, false);
        for (group, expected) in [
            ("createdAt:day", "2026-03-08T00:00:00Z"),
            ("createdAt:week", "2026-03-02T00:00:00Z"),
            ("createdAt:month", "2026-03-01T00:00:00Z"),
            ("when:day", "2026-03-09T00:00:00Z"),
        ] {
            let query = format!(
                "metric=count&groupBy={group}&from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z"
            );
            assert_eq!(
                run(&s, d, Some(&user), &query).await.unwrap()["data"][0]["key"],
                expected
            );
        }
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn router_http_contract(db: PgPool) {
        use axum::{
            extract::Request,
            middleware::{self, Next},
            response::Response,
        };

        async fn inject(mut request: Request, next: Next) -> Response {
            if let Some(id) = request
                .headers()
                .get("x-test-viewer")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| Uuid::parse_str(v).ok())
            {
                request.extensions_mut().insert(viewer(id, false));
            }
            next.run(request).await
        }
        let a: Uuid = sqlx::query_scalar(
            "insert into users(email) values('http-a@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let b: Uuid = sqlx::query_scalar(
            "insert into users(email) values('http-b@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        for (owner, data) in [
            (a, json!({"amount":2,"category":"x"})),
            (a, json!({"amount":4,"category":"x"})),
            (a, json!({"amount":null,"category":"y"})),
            (a, json!({})),
            (b, json!({"amount":100,"category":"other"})),
        ] {
            sqlx::query("insert into records(entity,owner_id,data) values('items',$1,$2)")
                .bind(owner)
                .bind(data)
                .execute(&db)
                .await
                .unwrap();
        }
        let app = router()
            .layer(Extension(Arc::new(registry())))
            .layer(middleware::from_fn(inject))
            .with_state(state(db));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let base = format!("http://{addr}/entities/items/stats");
        for (query, expected) in [
            ("count", json!(4)),
            ("sum:amount", json!(6)),
            ("avg:amount", json!(3.0)),
            ("min:amount", json!(2)),
            ("max:amount", json!(4)),
        ] {
            let body: Value = client
                .get(format!("{base}?metric={query}"))
                .header("x-test-viewer", a.to_string())
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                body["data"],
                json!([{"key":null,"value":expected}]),
                "{query}"
            );
        }
        for metric in ["sum", "avg", "min", "max"] {
            let body: Value = client
                .get(format!("{base}?metric={metric}:amount&filter[category]=y"))
                .header("x-test-viewer", a.to_string())
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(body["data"], json!([{"key":null,"value":null}]));
        }
        let body: Value = client
            .get(format!("{base}?metric=count&groupBy=category"))
            .header("x-test-viewer", a.to_string())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            body["data"],
            json!([{"key":null,"value":1},{"key":"x","value":2},{"key":"y","value":1}])
        );
        for (query, authenticated, status, code) in [
            ("metric=count", false, 401, "UNAUTHENTICATED"),
            ("metric=count&scope=all", true, 403, "FORBIDDEN"),
            ("metric=count&unknown=x", true, 400, "VALIDATION_FAILED"),
            ("metric=count&metric=count", true, 400, "VALIDATION_FAILED"),
            (
                "metric=sum:amount%29%3Bdrop",
                true,
                400,
                "VALIDATION_FAILED",
            ),
            (
                "metric=count&groupBy=category%29%3Bdrop",
                true,
                400,
                "VALIDATION_FAILED",
            ),
        ] {
            let mut req = client.get(format!("{base}?{query}"));
            if authenticated {
                req = req.header("x-test-viewer", a.to_string());
            }
            let response = req.send().await.unwrap();
            assert_eq!(response.status().as_u16(), status, "{query}");
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["error"]["code"], code);
        }
        let response = client
            .get(format!("http://{addr}/entities/%FF/stats?metric=count"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 404);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "NOT_FOUND");
        server.abort();
    }

    #[test]
    fn rejects_unsafe_schema_unions() {
        let mut def: EntityDefinition = serde_json::from_value(json!({"label":"Item","read":"owner","create":"authenticated","write":"owner","allowPublic":false,"maxPerOwner":1,"sortable":[],"filterable":["mixed"],"searchable":[],"schema":{"type":"object","properties":{"mixed":{"type":["number","string"],"format":"date-time"}}}})).unwrap();
        let now = OffsetDateTime::now_utc();
        assert!(parse(Some("metric=sum:mixed"), &def, now).is_err());
        assert!(parse(Some("metric=count&groupBy=mixed:day"), &def, now).is_err());
        def.schema["properties"]["mixed"]["type"] = json!(["string", "array"]);
        assert!(parse(Some("metric=count&groupBy=mixed"), &def, now).is_err());
    }
}
