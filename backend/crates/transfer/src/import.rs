use crate::{MAX_FILE_BYTES, MAX_ROWS, ParsedRows, RowError, parse_csv};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Extension, Multipart, State},
    routing::post,
};
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    extract::{Path, Query},
    request::RequestMeta,
    security::{self, Limit},
    viewer::Viewer,
};
use records::EntityRegistry;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportQuery {
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    atomic: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/entities/{entity}/import", post(import))
        .layer(DefaultBodyLimit::max(MAX_FILE_BYTES + 65536))
}
fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::ValidationFailed, "Invalid file.")
        .with_details(json!([{"path":"file","message":message}]))
}
fn multipart_error(error: axum::extract::multipart::MultipartError) -> AppError {
    if error.status().as_u16() == 413 {
        AppError::new(ErrorCode::PayloadTooLarge, "File is too large.")
    } else {
        AppError::bad_request("We couldn't read that file.")
    }
}
fn parse_json(bytes: &[u8], schema: &Value) -> AppResult<ParsedRows> {
    let input: Value =
        serde_json::from_slice(bytes).map_err(|_| invalid("Enter a valid JSON array."))?;
    let export = input.as_object().filter(|obj| {
        obj.len() == 2 && obj.get("version") == Some(&json!(1)) && obj.get("records").is_some()
    });
    let rows = if let Some(obj) = export {
        obj.get("records").and_then(Value::as_array)
    } else {
        input.as_array()
    }
    .ok_or_else(|| invalid("Enter a valid JSON array or export."))?;
    if rows.len() > MAX_ROWS {
        return Err(invalid("File has too many rows."));
    }
    let properties = schema["properties"]
        .as_object()
        .ok_or_else(|| AppError::internal("Invalid entity schema"))?;
    let mut result = ParsedRows {
        rows: Vec::new(),
        failed: Vec::new(),
    };
    for (index, entry) in rows.iter().enumerate() {
        let row = if export.is_some() {
            entry
                .as_object()
                .and_then(|o| o.get("data"))
                .filter(|v| v.is_object())
                .ok_or_else(|| invalid("Invalid export record."))?
        } else {
            entry
        };
        let unknown = row
            .as_object()
            .is_some_and(|object| object.keys().any(|key| !properties.contains_key(key)));
        if unknown {
            result.failed.push(RowError {
                row: index + 1,
                errors: vec![json!({"path":"file","message":"A column is not allowed."})],
            });
        } else {
            result.rows.push((index + 1, row.clone()));
        }
    }
    Ok(result)
}

fn row_details(error: AppError) -> Vec<Value> {
    let mut details = error
        .details
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if details.is_empty() {
        details.push(json!({"path":"file","message":error.message}));
    }
    for detail in &mut details {
        if let Some(object) = detail.as_object_mut() {
            let path = object.get("path").and_then(Value::as_str).unwrap_or("");
            let path = if path.is_empty() {
                "file".to_owned()
            } else if path.starts_with('/') {
                path.trim_start_matches('/')
                    .replace('/', ".")
                    .replace("~1", "/")
                    .replace("~0", "~")
            } else {
                path.to_owned()
            };
            object.insert("path".into(), Value::String(path));
        }
    }
    details
}

async fn import(
    State(state): State<AppState>,
    Extension(reg): Extension<Arc<EntityRegistry>>,
    Path(entity): Path<String>,
    Query(query): Query<ImportQuery>,
    viewer: Viewer,
    meta: RequestMeta,
    multipart: Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> AppResult<Json<Value>> {
    records::api::check_create_access(&reg, &viewer, &entity)?;
    security::enforce_rate_limit(
        &state.db,
        &format!("transfer:import:user:{}", viewer.id),
        Limit {
            limit: 10,
            window: Duration::from_secs(3600),
        },
    )
    .await?;
    let schema = &reg.definition(&entity)?.schema;
    let mut multipart = multipart.map_err(|_| {
        AppError::new(
            ErrorCode::UnsupportedMediaType,
            "Please send a multipart file.",
        )
    })?;
    let mut file = None;
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        if field.name() != Some("file") || file.is_some() {
            return Err(invalid("Send one file."));
        }
        let mime = field
            .content_type()
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let filename = field.file_name().unwrap_or("").to_ascii_lowercase();
        let json_file = mime == "application/json"
            || (mime == "application/octet-stream" && filename.ends_with(".json"));
        let csv_file = mime == "text/csv"
            || mime == "application/csv"
            || (mime == "application/octet-stream" && filename.ends_with(".csv"));
        if !json_file && !csv_file {
            return Err(AppError::new(
                ErrorCode::UnsupportedMediaType,
                "Please send a CSV or JSON file.",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_FILE_BYTES {
                return Err(AppError::new(
                    ErrorCode::PayloadTooLarge,
                    "File is too large.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        file = Some((json_file, bytes));
    }
    let (json_file, bytes) = file.ok_or_else(|| invalid("Send one file."))?;
    let parsed = if json_file {
        parse_json(&bytes, schema)?
    } else {
        parse_csv(&bytes, schema).map_err(invalid)?
    };
    // One budget unit represents up to 100 rows, including rejected rows.
    let total = parsed.rows.len() + parsed.failed.len();
    for _ in 0..total.div_ceil(100) {
        security::enforce_rate_limit(
            &state.db,
            &format!("transfer:import:rows:{}", viewer.id),
            Limit {
                limit: 100,
                window: Duration::from_secs(3600),
            },
        )
        .await?;
    }
    let mut failed = parsed.failed;
    let capacity = records::api::personal_capacity(&state.db, &reg, &viewer, &entity).await?;
    let mut ready = Vec::new();
    for (row, data) in parsed.rows {
        match records::api::prepare_create_data(&reg, &viewer, &entity, data) {
            Ok(data) => {
                if capacity.is_some_and(|limit| ready.len() >= limit) {
                    failed.push(RowError {
                        row,
                        errors: vec![
                            json!({"path":"file","message":"You have reached the limit."}),
                        ],
                    });
                } else {
                    ready.push((row, data));
                }
            }
            Err(error) if error.code == ErrorCode::ValidationFailed => {
                failed.push(RowError {
                    row,
                    errors: row_details(error),
                });
            }
            Err(error) => return Err(error),
        }
    }
    let mut created = 0usize;
    if !query.dry_run && !(query.atomic && !failed.is_empty()) {
        if query.atomic {
            let mut tx = state.db.begin().await?;
            for chunk in ready.chunks(100) {
                let values = chunk.iter().map(|(_, data)| data.clone()).collect();
                match records::api::create_many_in_tx(
                    &mut tx, &reg, &viewer, &meta, &entity, values, None,
                )
                .await
                {
                    Ok(_) => created += chunk.len(),
                    Err(error) if error.code == ErrorCode::LimitReached => {
                        for (row, _) in chunk {
                            failed.push(RowError {
                                row: *row,
                                errors: vec![
                                    json!({"path":"file","message":"You have reached the limit."}),
                                ],
                            });
                        }
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
            if failed.is_empty() {
                tx.commit().await?;
            } else {
                tx.rollback().await?;
                created = 0;
            }
        } else {
            for chunk in ready.chunks(100) {
                let mut offset = 0;
                {
                    let mut tx = state.db.begin().await?;
                    let values = chunk[offset..]
                        .iter()
                        .map(|(_, data)| data.clone())
                        .collect();
                    match records::api::create_many_in_tx(
                        &mut tx, &reg, &viewer, &meta, &entity, values, None,
                    )
                    .await
                    {
                        Ok(_) => {
                            tx.commit().await?;
                            created += chunk.len() - offset;
                        }
                        Err(error) if error.code == ErrorCode::LimitReached => {
                            tx.rollback().await?;
                            let available =
                                records::api::personal_capacity(&state.db, &reg, &viewer, &entity)
                                    .await?
                                    .unwrap_or(0)
                                    .min(chunk.len() - offset);
                            if available > 0 {
                                let mut tx = state.db.begin().await?;
                                let values = chunk[offset..offset + available]
                                    .iter()
                                    .map(|(_, data)| data.clone())
                                    .collect();
                                match records::api::create_many_in_tx(
                                    &mut tx, &reg, &viewer, &meta, &entity, values, None,
                                )
                                .await
                                {
                                    Ok(_) => {
                                        tx.commit().await?;
                                        created += available;
                                        offset += available;
                                    }
                                    Err(error) if error.code == ErrorCode::LimitReached => {
                                        tx.rollback().await?;
                                    }
                                    Err(error) => return Err(error),
                                }
                            }
                            for (row, _) in &chunk[offset..] {
                                failed.push(RowError { row: *row, errors: vec![json!({"path":"file","message":"You have reached the limit."})] });
                            }
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
        }
    }
    failed.sort_by_key(|item| item.row);
    let failed: Vec<Value> = failed
        .into_iter()
        .map(|item| json!({"row":item.row,"errors":item.errors}))
        .collect();
    Ok(Json(json!({"data":{"created":created,"failed":failed}})))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use kernel::{config::Config, email::LogSender, session};
    use sqlx::PgPool;
    use tower::ServiceExt;

    #[sqlx::test(migrations = "../../migrations")]
    async fn imports_follow_create_policy_and_roll_back(db: PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let id: uuid::Uuid = sqlx::query_scalar(
            "insert into users(email) values('import@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: String::new(),
        };
        let (token, _) = session::create(&db, &config, id, &meta).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config,
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let mut defs: Value =
            serde_json::from_str(&std::fs::read_to_string("../../config/entities.json").unwrap())
                .unwrap();
        defs["notes"]["maxPerOwner"] = json!(1);
        defs["secret"] = defs["notes"].clone();
        defs["secret"]["create"] = json!("admin");
        let reg = Arc::new(EntityRegistry::from_json(&defs.to_string()).unwrap());
        let app = router().layer(Extension(reg)).with_state(state);
        let request = Request::post("/entities/secret/import")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "multipart/form-data; boundary=boundary")
            .body(Body::from("--boundary--\r\n"))
            .unwrap();
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 403);
        let body = format!(
            "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"data.json\"\r\nContent-Type: application/json\r\n\r\n{}\r\n--boundary--\r\n",
            "x".repeat(MAX_FILE_BYTES + 1)
        );
        let request = Request::post("/entities/notes/import")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "multipart/form-data; boundary=boundary")
            .body(Body::from(body))
            .unwrap();
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 413);
        async fn send(app: &Router, token: &str, query: &str, input: &str) -> Value {
            let body = format!(
                "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"data.json\"\r\nContent-Type: application/json\r\n\r\n{input}\r\n--boundary--\r\n"
            );
            let request = Request::post(format!("/entities/notes/import{query}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "multipart/form-data; boundary=boundary")
                .body(Body::from(body))
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), 200);
            serde_json::from_slice(&to_bytes(response.into_body(), 100_000).await.unwrap()).unwrap()
        }
        sqlx::raw_sql("create function reject_import_insert() returns trigger language plpgsql as $$ begin raise exception 'unexpected insert'; end $$; create trigger reject_import before insert on records for each statement execute function reject_import_insert()")
            .execute(&db).await.unwrap();
        let result = send(&app, &token, "?dryRun=true", r#"[{"title":"test"}]"#).await;
        sqlx::raw_sql(
            "drop trigger reject_import on records; drop function reject_import_insert()",
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(result["data"]["created"], 0);
        let result = send(&app, &token, "?atomic=true", r#"[{"title":"test"},{}]"#).await;
        assert_eq!(result["data"]["created"], 0);
        assert_eq!(result["data"]["failed"][0]["row"], 2);
        let count: i64 = sqlx::query_scalar("select count(*) from records")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let result = send(&app, &token, "", r#"[{"title":"test"},{"title":"two"}]"#).await;
        assert_eq!(result["data"]["created"], 1);
        assert_eq!(result["data"]["failed"][0]["row"], 2);
        let data: Value = sqlx::query_scalar("select data from records")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(data["pinned"], false);
        sqlx::query("delete from records")
            .execute(&db)
            .await
            .unwrap();
        let (a, b) = tokio::join!(
            send(&app, &token, "", r#"[{"title":"one"}]"#),
            send(&app, &token, "", r#"[{"title":"two"}]"#)
        );
        assert_eq!(
            a["data"]["created"].as_u64().unwrap() + b["data"]["created"].as_u64().unwrap(),
            1
        );
        assert_eq!(
            a["data"]["failed"].as_array().unwrap().len()
                + b["data"]["failed"].as_array().unwrap().len(),
            1
        );
        let count: i64 = sqlx::query_scalar("select count(*) from records")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn chunk_failure_commits_only_non_atomic_prior_chunks(db: PgPool) {
        let config = Arc::new(Config::from_env().unwrap());
        let id: uuid::Uuid = sqlx::query_scalar(
            "insert into users(email) values('chunks@example.com') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let meta = RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: String::new(),
            request_id: String::new(),
        };
        let (token, _) = session::create(&db, &config, id, &meta).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config,
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let mut defs: Value =
            serde_json::from_str(&std::fs::read_to_string("../../config/entities.json").unwrap())
                .unwrap();
        defs["notes"]["maxPerOwner"] = json!(500);
        let app = router()
            .layer(Extension(Arc::new(
                EntityRegistry::from_json(&defs.to_string()).unwrap(),
            )))
            .with_state(state);
        sqlx::raw_sql("create function fail_last_import() returns trigger language plpgsql as $$ begin if new.data->>'title' = 'fail' then raise exception 'test failure'; end if; return new; end $$; create trigger fail_last before insert on records for each row execute function fail_last_import() ").execute(&db).await.unwrap();
        let mut rows = vec![json!({"title":"ok"}); 100];
        rows.push(json!({"title":"fail"}));
        let input = serde_json::to_string(&rows).unwrap();
        for (query, expected) in [("?atomic=true", 0_i64), ("", 100_i64)] {
            let body = format!(
                "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"data.json\"\r\nContent-Type: application/json\r\n\r\n{input}\r\n--boundary--\r\n"
            );
            let request = Request::post(format!("/entities/notes/import{query}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "multipart/form-data; boundary=boundary")
                .body(Body::from(body))
                .unwrap();
            assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 500);
            let count: i64 = sqlx::query_scalar("select count(*) from records")
                .fetch_one(&db)
                .await
                .unwrap();
            assert_eq!(count, expected);
        }
    }

    #[test]
    fn json_raw_id_and_versioned_export_are_distinct() {
        let schema = json!({"properties":{"id":{"type":"string"},"data.id":{"type":"string"}}});
        let data = json!({"id":"field", "data.id":"nested name"});
        let raw = serde_json::to_vec(&json!([data])).unwrap();
        assert_eq!(parse_json(&raw, &schema).unwrap().rows[0].1, data);
        let envelope =
            serde_json::to_vec(&json!({"version":1,"records":[{"id":"metadata", "data":data}]}))
                .unwrap();
        assert_eq!(parse_json(&envelope, &schema).unwrap().rows[0].1, data);
    }

    #[test]
    fn json_limits_and_unknown_columns() {
        let schema = json!({"properties":{"title":{"type":"string"}}});
        assert!(parse_json(b"{}", &schema).is_err());
        let parsed = parse_json(br#"[{"extra":1}]"#, &schema).unwrap();
        assert_eq!(parsed.failed[0].row, 1);
        let too_many = serde_json::to_vec(&vec![json!({}); MAX_ROWS + 1]).unwrap();
        assert!(parse_json(&too_many, &schema).is_err());
    }
}
