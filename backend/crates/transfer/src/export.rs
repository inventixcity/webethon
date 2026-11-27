//! Stream schema-shaped records with the same scope rules as the records list.
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Extension, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures::stream;
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    extract::{Path, Query},
    request::RequestMeta,
    security::{self, AuditEntry, limits},
    viewer::Viewer,
};
use records::EntityRegistry;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use std::{io, sync::Arc};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const MAX_EXPORT_ROWS: i64 = 50_000;
const PAGE: i64 = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportQuery {
    format: String,
    scope: String,
    team_id: Option<Uuid>,
}

fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(ErrorCode::ValidationFailed, "Invalid value.")
        .with_details(json!([{"path":path,"message":message}]))
}

/// Mount under the API base path with an `Arc<EntityRegistry>` extension.
pub fn router() -> Router<AppState> {
    Router::new().route("/entities/{entity}/export", get(export))
}

#[derive(Clone)]
struct Filter {
    entity: String,
    user: Uuid,
    team: Option<Uuid>,
    admin: bool,
    session: Option<Uuid>,
    ceiling: OffsetDateTime,
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    data: Value,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

// All inputs are values, and the membership predicate is re-evaluated for every page.
const PREDICATE: &str = "r.entity=$1 and r.deleted_at is null and u.deleted_at is null and r.created_at <= $5 and exists (select 1 from users vu where vu.id=$2 and vu.deleted_at is null and vu.status <> 'suspended') and ($6::uuid is null or exists (select 1 from sessions vs where vs.id=$6 and vs.user_id=$2 and vs.revoked_at is null and vs.expires_at > now())) and (($3::uuid is null and r.team_id is null and r.owner_id=$2) or ($3::uuid is not null and r.team_id=$3 and ($4 or exists (select 1 from users au where au.id=$2 and au.role='admin' and au.deleted_at is null) or r.admin_hidden_at is null or r.owner_id=$2) and exists (select 1 from team_members tm join teams t on t.id=tm.team_id join users mu on mu.id=tm.user_id where tm.team_id=r.team_id and tm.user_id=$2 and t.deleted_at is null and mu.deleted_at is null)))";

async fn snapshot(db: &PgPool, f: &Filter) -> AppResult<Vec<Uuid>> {
    let mut tx = db.begin().await?;
    sqlx::query("set local statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    let sql = format!(
        "select r.id from records r join users u on u.id=r.owner_id where {PREDICATE} order by r.created_at,r.id limit 50001"
    );
    let ids = sqlx::query_scalar(&sql)
        .bind(&f.entity)
        .bind(f.user)
        .bind(f.team)
        .bind(f.admin)
        .bind(f.ceiling)
        .bind(f.session)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ids)
}
async fn page(db: &PgPool, f: &Filter, ids: &[Uuid]) -> AppResult<Vec<Row>> {
    let mut tx = db.begin().await?;
    sqlx::query("set local statement_timeout = '10s'")
        .execute(&mut *tx)
        .await?;
    let sql = format!(
        "select r.id,r.data,r.created_at,r.updated_at from records r join users u on u.id=r.owner_id where {PREDICATE} and r.id = any($7) order by r.created_at,r.id"
    );
    let rows = sqlx::query_as::<_, Row>(&sql)
        .bind(&f.entity)
        .bind(f.user)
        .bind(f.team)
        .bind(f.admin)
        .bind(f.ceiling)
        .bind(f.session)
        .bind(ids)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(rows)
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    }
}
fn csv_record(fields: impl IntoIterator<Item = String>) -> Result<Vec<u8>, csv::Error> {
    let mut w = csv::WriterBuilder::new()
        .terminator(csv::Terminator::CRLF)
        .from_writer(Vec::new());
    w.write_record(fields)?;
    w.into_inner().map_err(|e| e.into_error().into())
}
fn row_value(row: &Row, fields: &[String]) -> AppResult<Value> {
    let data: serde_json::Map<String, Value> = fields
        .iter()
        .filter_map(|name| row.data.get(name).map(|v| (name.clone(), v.clone())))
        .collect();
    Ok(
        json!({"data": data, "id": row.id, "createdAt": row.created_at.format(&Rfc3339).map_err(AppError::internal)?, "updatedAt": row.updated_at.format(&Rfc3339).map_err(AppError::internal)?}),
    )
}

struct StreamState {
    db: PgPool,
    filter: Filter,
    fields: Vec<String>,
    csv: bool,
    ids: Vec<Uuid>,
    offset: usize,
    started: bool,
    finished: bool,
    first: bool,
}
async fn next(mut s: StreamState) -> Option<(Result<Bytes, io::Error>, StreamState)> {
    if !s.started {
        s.started = true;
        let result = if s.csv {
            let mut bytes = vec![0xef, 0xbb, 0xbf];
            match csv_record(s.fields.iter().map(|name| crate::csv_header(name)).chain([
                "__transfer.meta.id".into(),
                "__transfer.meta.createdAt".into(),
                "__transfer.meta.updatedAt".into(),
            ])) {
                Ok(header) => {
                    bytes.extend(header);
                    Ok(Bytes::from(bytes))
                }
                Err(_) => Err(io::Error::other("Export interrupted.")),
            }
        } else {
            Ok(Bytes::from_static(b"{\"version\":1,\"records\":["))
        };
        return Some((result, s));
    }
    if s.finished {
        return None;
    }
    if s.offset >= s.ids.len() {
        s.finished = true;
        return if s.csv {
            None
        } else {
            Some((Ok(Bytes::from_static(b"]}")), s))
        };
    }
    let end = (s.offset + PAGE as usize).min(s.ids.len());
    let rows = match page(&s.db, &s.filter, &s.ids[s.offset..end]).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = ?e, "export page failed");
            s.finished = true;
            return Some((Err(io::Error::other("Export interrupted.")), s));
        }
    };
    s.offset = end;
    let mut chunk = Vec::new();
    for row in rows {
        let value = match row_value(&row, &s.fields) {
            Ok(v) => v,
            Err(_) => {
                s.finished = true;
                return Some((Err(io::Error::other("Export interrupted.")), s));
            }
        };
        if s.csv {
            let values = s
                .fields
                .iter()
                .map(|name| crate::csv_value(row.data.get(name)))
                .chain([
                    value_text(value.get("id")),
                    value_text(value.get("createdAt")),
                    value_text(value.get("updatedAt")),
                ]);
            match csv_record(values) {
                Ok(line) => chunk.extend(line),
                Err(_) => {
                    s.finished = true;
                    return Some((Err(io::Error::other("Export interrupted.")), s));
                }
            }
        } else {
            if !s.first {
                chunk.push(b',');
            }
            s.first = false;
            match serde_json::to_vec(&value) {
                Ok(line) => chunk.extend(line),
                Err(_) => {
                    s.finished = true;
                    return Some((Err(io::Error::other("Export interrupted.")), s));
                }
            }
        }
    }
    Some((Ok(Bytes::from(chunk)), s))
}

pub async fn export(
    State(state): State<AppState>,
    Extension(reg): Extension<Arc<EntityRegistry>>,
    Path(entity): Path<String>,
    Query(q): Query<ExportQuery>,
    viewer: Viewer,
    meta: RequestMeta,
) -> AppResult<Response> {
    let def = reg.definition(&entity)?;
    if !matches!(q.format.as_str(), "csv" | "json") {
        return Err(invalid("format", "Choose csv or json."));
    }
    if !matches!(q.scope.as_str(), "mine" | "team") {
        return Err(invalid("scope", "Choose mine or team."));
    }
    if (q.scope == "team") != q.team_id.is_some() {
        return Err(invalid("teamId", "Use a team ID with team scope."));
    }
    if let Some(team) = q.team_id {
        teams::require_role(&state.db, team, &viewer, teams::TeamRole::Viewer).await?;
    }
    let fields = def.schema["properties"]
        .as_object()
        .ok_or_else(|| AppError::internal("entity schema has no properties"))?
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    security::enforce_rate_limit(
        &state.db,
        &format!("transfer:export:user:{}", viewer.id),
        limits::API_READ_PER_SUBJECT,
    )
    .await?;
    let filter = Filter {
        entity: entity.clone(),
        user: viewer.id,
        team: q.team_id,
        admin: state
            .config
            .admin_emails
            .contains(&viewer.email.to_ascii_lowercase()),
        session: Some(viewer.session_id),
        ceiling: OffsetDateTime::now_utc(),
    };
    let ids = snapshot(&state.db, &filter).await?;
    let rows = ids.len();
    if rows > MAX_EXPORT_ROWS as usize {
        let mut response =
            AppError::new(ErrorCode::LimitReached, "Export at most 50,000 rows.").into_response();
        response.headers_mut().insert(
            "x-export-row-limit",
            axum::http::HeaderValue::from_static("50000"),
        );
        return Ok(response);
    }
    security::audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "transfer.export",
            actor_id: Some(viewer.id),
            target_type: Some("entity"),
            target_id: Some(entity.clone()),
            meta: json!({"format":q.format,"scope":q.scope,"teamId":q.team_id,"rows":rows}),
        },
    )
    .await;
    let csv = q.format == "csv";
    let body = Body::from_stream(stream::unfold(
        StreamState {
            db: state.db,
            filter,
            fields,
            csv,
            ids,
            offset: 0,
            started: false,
            finished: false,
            first: true,
        },
        next,
    ));
    // The entity name is a registry key; keep only plain characters so it is always a safe filename.
    let file_stem: String = entity
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let extension = if csv { "csv" } else { "json" };
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            if csv {
                "text/csv; charset=utf-8"
            } else {
                "application/json"
            },
        )
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{file_stem}.{extension}\""),
        )
        .header("x-export-row-limit", "50000")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(body)
        .map_err(AppError::internal)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[test]
    fn csv_quotes_and_escapes_formulas() {
        let bytes = csv_record(vec![
            crate::csv_value(Some(&json!("=2+2"))),
            "hello, world".into(),
            "[\"a\"]".into(),
        ])
        .unwrap();
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_reader(bytes.as_slice());
        let row = reader.records().next().unwrap().unwrap();
        assert_eq!(&row[0], "'=2+2");
        assert_eq!(&row[1], "hello, world");
        assert_eq!(&row[2], "[\"a\"]");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn snapshot_stops_at_limit_plus_one(db: PgPool) {
        let user: Uuid =
            sqlx::query_scalar("insert into users(email) values ('cap@test.test') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        sqlx::query("insert into records(entity,owner_id,data) select 'notes',$1,'{}'::jsonb from generate_series(1,50002)").bind(user).execute(&db).await.unwrap();
        let filter = Filter {
            entity: "notes".into(),
            user,
            team: None,
            admin: false,
            session: None,
            ceiling: OffsetDateTime::now_utc(),
        };
        assert_eq!(snapshot(&db, &filter).await.unwrap().len(), 50001);
        use axum::{body::to_bytes, http::Request};
        use kernel::{config::Config, email::LogSender, session};
        use tower::ServiceExt;
        let config = Arc::new(Config::from_env().unwrap());
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: String::new(),
        };
        let (token, _) = session::create(&db, &config, user, &meta).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config,
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let defs = std::fs::read_to_string("../../config/entities.json").unwrap();
        let reg = Arc::new(EntityRegistry::from_json(&defs).unwrap());
        let app = router().layer(Extension(reg)).with_state(state);
        let session_id: Uuid = sqlx::query_scalar("select id from sessions where user_id=$1")
            .bind(user)
            .fetch_one(&db)
            .await
            .unwrap();
        let mut current = filter.clone();
        current.session = Some(session_id);
        let ids = snapshot(&db, &current).await.unwrap();
        assert_eq!(page(&db, &current, &ids[..1]).await.unwrap().len(), 1);
        sqlx::query("update sessions set revoked_at=now() where id=$1")
            .bind(session_id)
            .execute(&db)
            .await
            .unwrap();
        assert!(page(&db, &current, &ids[..1]).await.unwrap().is_empty());
        sqlx::query("update sessions set revoked_at=null where id=$1")
            .bind(session_id)
            .execute(&db)
            .await
            .unwrap();

        let request = || {
            Request::get("/entities/notes/export?format=json&scope=mine")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(response.headers()["x-export-row-limit"], "50000");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 10000).await.unwrap()).unwrap();
        assert_eq!(body["error"]["code"], "LIMIT_REACHED");
        sqlx::query("delete from records where owner_id=$1")
            .bind(user)
            .execute(&db)
            .await
            .unwrap();
        let response = app.oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-export-row-limit"], "50000");
        assert!(
            response.headers()[header::CONTENT_DISPOSITION]
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn streams_and_enforces_membership_and_visibility(db: PgPool) {
        let owner: Uuid =
            sqlx::query_scalar("insert into users(email) values ('owner@test.test') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let viewer: Uuid =
            sqlx::query_scalar("insert into users(email) values ('viewer@test.test') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let team: Uuid =
            sqlx::query_scalar("insert into teams(name,slug) values ('Team','team') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        sqlx::query("insert into team_members(team_id,user_id,role) values ($1,$2,'viewer')")
            .bind(team)
            .bind(viewer)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into records(entity,owner_id,team_id,data) values ('notes',$1,$2,$3)")
            .bind(owner)
            .bind(team)
            .bind(json!({"title":"=2+2","tags":["a"]}))
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into records(entity,owner_id,team_id,data,admin_hidden_at) values ('notes',$1,$2,'{}',now())").bind(owner).bind(team).execute(&db).await.unwrap();
        sqlx::query("insert into records(entity,owner_id,data) values ('notes',$1,'{}')")
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        let f = Filter {
            entity: "notes".into(),
            user: viewer,
            team: Some(team),
            admin: false,
            session: None,
            ceiling: OffsetDateTime::now_utc(),
        };
        let ids = snapshot(&db, &f).await.unwrap();
        assert_eq!(ids.len(), 1);
        for csv in [true, false] {
            let s = StreamState {
                db: db.clone(),
                filter: f.clone(),
                fields: vec!["title".into(), "tags".into()],
                csv,
                ids: ids.clone(),
                offset: 0,
                started: false,
                finished: false,
                first: true,
            };
            let chunks: Vec<_> = stream::unfold(s, next).collect().await;
            let bytes: Vec<u8> = chunks
                .into_iter()
                .flat_map(|c| c.unwrap().to_vec())
                .collect();
            if csv {
                assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]));
                let mut reader = csv::Reader::from_reader(&bytes[3..]);
                let row = reader.records().next().unwrap().unwrap();
                assert_eq!(&row[0], "'=2+2");
                assert_eq!(&row[1], "[\"a\"]");
            } else {
                let data: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(data["records"].as_array().unwrap().len(), 1);
                assert_eq!(data["records"][0]["data"]["title"], "=2+2");
            }
        }
        // A backdated insert after the snapshot must never enter its ID set.
        let added: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,team_id,data,created_at) values ('notes',$1,$2,'{}',now() - interval '1 day') returning id")
            .bind(owner).bind(team).fetch_one(&db).await.unwrap();
        assert!(!ids.contains(&added));
        assert_eq!(page(&db, &f, &ids).await.unwrap().len(), 1);
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(viewer)
            .execute(&db)
            .await
            .unwrap();
        assert!(page(&db, &f, &ids).await.unwrap().is_empty());
        let mine = Filter {
            team: None,
            user: viewer,
            ..f
        };
        assert!(page(&db, &mine, &ids).await.unwrap().is_empty());
    }
}
