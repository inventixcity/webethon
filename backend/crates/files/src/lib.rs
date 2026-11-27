use kernel::extract::{Json, Path, Query};
mod images;
mod storage;
pub use storage::{Storage, storage_from_env};

use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, Extension, Multipart, State, multipart::MultipartRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, crypto,
    request::RequestMeta,
    security::{self, AuditEntry, Limit},
    viewer::Viewer,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use time::OffsetDateTime;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/files",
            post(upload)
                .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
                .get(list),
        )
        .route("/files/{id}", get(metadata).patch(update).delete(delete))
        .route("/files/{id}/content", get(content))
}

#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileRow {
    id: Uuid,
    #[serde(skip)]
    owner_id: Uuid,
    #[serde(skip)]
    key: String,
    content_type: String,
    size_bytes: i64,
    #[serde(skip)]
    sha256: Vec<u8>,
    width: Option<i32>,
    height: Option<i32>,
    original_name: Option<String>,
    visibility: String,
    created_at: OffsetDateTime,
}
impl FileRow {
    fn value(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        v["url"] = json!(format!("/api/v1/files/{}/content", self.id));
        v
    }
}
const COLUMNS: &str = "id, owner_id, key, content_type, size_bytes, sha256, width, height, original_name, visibility, created_at";
fn image_permits() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static PERMITS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    PERMITS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)))
}
fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{ "path": path, "message": message }]))
}
fn multipart_error(e: impl std::fmt::Display, status: StatusCode) -> AppError {
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        AppError::new(ErrorCode::PayloadTooLarge, "The upload is too large.")
    } else if status == StatusCode::UNSUPPORTED_MEDIA_TYPE {
        AppError::new(
            ErrorCode::UnsupportedMediaType,
            "Please send a valid upload.",
        )
    } else {
        let _ = e;
        AppError::bad_request("Please provide a valid upload.")
    }
}
async fn audit(state: &AppState, meta: &RequestMeta, actor: Uuid, id: Uuid, action: &str) {
    security::audit(
        &state.db,
        meta,
        AuditEntry {
            action,
            actor_id: Some(actor),
            target_type: Some("file"),
            target_id: Some(id.to_string()),
            meta: json!({}),
        },
    )
    .await;
}
async fn upload(
    State(state): State<AppState>,
    Extension(storage): Extension<Arc<dyn Storage>>,
    viewer: Viewer,
    meta: RequestMeta,
    headers: HeaderMap,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<Response, AppError> {
    security::enforce_rate_limit(
        &state.db,
        &format!("files.upload:{}", viewer.id),
        Limit {
            limit: 30,
            window: Duration::from_secs(600),
        },
    )
    .await?;
    let mut multipart = multipart.map_err(|e| {
        let is_multipart = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("multipart/form-data"));
        if !is_multipart && e.status() != StatusCode::PAYLOAD_TOO_LARGE {
            AppError::new(
                ErrorCode::UnsupportedMediaType,
                "Please send a multipart upload.",
            )
        } else {
            multipart_error(&e, e.status())
        }
    })?;
    let field = multipart
        .next_field()
        .await
        .map_err(|e| multipart_error(&e, e.status()))?
        .ok_or_else(|| invalid("file", "Choose a file."))?;
    if field.name() != Some("file") {
        return Err(invalid("file", "Choose one file."));
    }
    let name = field.file_name().and_then(images::sanitize_filename);
    let bytes = field
        .bytes()
        .await
        .map_err(|e| multipart_error(&e, e.status()))?;
    if multipart
        .next_field()
        .await
        .map_err(|e| multipart_error(&e, e.status()))?
        .is_some()
    {
        return Err(invalid("file", "Choose one file."));
    }
    let kind = images::detect(&bytes).ok_or_else(|| {
        AppError::new(
            ErrorCode::UnsupportedMediaType,
            "This file type is not supported.",
        )
    })?;
    // Decoding can take ~64 MiB per image, so only a couple run at once per process (the pod has
    // 256 MiB). Others wait their turn instead of exhausting memory.
    let permit = image_permits()
        .clone()
        .acquire_owned()
        .await
        .map_err(AppError::internal)?;
    let processed = match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        images::process(bytes.to_vec(), kind)
    })
    .await
    .map_err(AppError::internal)?
    {
        Ok(p) => p,
        Err(_) => {
            return Ok((
                StatusCode::UNPROCESSABLE_ENTITY,
                invalid(
                    "file",
                    "We couldn't read that file. It may be damaged or too large.",
                ),
            )
                .into_response());
        }
    };
    let size = i64::try_from(processed.bytes.len()).map_err(AppError::internal)?;
    let hash = crypto::sha256(&processed.bytes);
    let id = Uuid::new_v4();
    let key = format!("u/{}/{id}.{}", viewer.id, processed.ext);
    let mut tx = state.db.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("files:{}", viewer.id))
        .execute(&mut *tx)
        .await?;
    let (count, total): (i64, i64) = sqlx::query_as("select count(*), coalesce(sum(size_bytes), 0)::bigint from files where owner_id = $1 and deleted_at is null").bind(viewer.id).fetch_one(&mut *tx).await?;
    if count >= 200 || total.saturating_add(size) > 200 * 1024 * 1024 {
        return Err(AppError::new(
            ErrorCode::LimitReached,
            "Your file storage is full.",
        ));
    }
    storage
        .put(&key, processed.bytes.into())
        .await
        .map_err(AppError::internal)?;
    let query = format!(
        "insert into files (id, owner_id, key, content_type, size_bytes, sha256, width, height, original_name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning {COLUMNS}"
    );
    let row = sqlx::query_as::<_, FileRow>(&query)
        .bind(id)
        .bind(viewer.id)
        .bind(&key)
        .bind(processed.content_type)
        .bind(size)
        .bind(hash.as_slice())
        .bind(processed.width)
        .bind(processed.height)
        .bind(name)
        .fetch_one(&mut *tx)
        .await;
    let row = match row {
        Ok(row) => row,
        Err(e) => {
            let _ = storage.delete(&key).await;
            return Err(e.into());
        }
    };
    if let Err(e) = tx.commit().await {
        let _ = storage.delete(&key).await;
        return Err(e.into());
    }
    audit(&state, &meta, viewer.id, id, "file.upload").await;
    Ok((StatusCode::CREATED, Json(json!({"data": row.value()}))).into_response())
}

async fn find(state: &AppState, id: Uuid, viewer: Option<&Viewer>) -> AppResult<FileRow> {
    // A deleted account's files disappear with it, even public ones.
    let query = format!(
        "select {COLUMNS} from files where id = $1 and deleted_at is null          and exists (select 1 from users u where u.id = files.owner_id and u.deleted_at is null)"
    );
    let row = sqlx::query_as::<_, FileRow>(&query)
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(AppError::not_found)?;
    if row.visibility != "public" && !viewer.is_some_and(|v| v.id == row.owner_id || v.is_admin()) {
        return Err(AppError::not_found());
    }
    Ok(row)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}
async fn list(
    State(state): State<AppState>,
    viewer: Viewer,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit", "Use a limit between 1 and 100."));
    }
    let cursor = query
        .cursor
        .map(|v| Uuid::parse_str(&v).map_err(|_| invalid("cursor", "Invalid cursor.")))
        .transpose()?;
    let query = format!(
        "select {COLUMNS} from files where owner_id=$1 and deleted_at is null and ($2::uuid is null or (created_at,id) < (select created_at,id from files where id=$2 and owner_id=$1 and deleted_at is null)) order by created_at desc,id desc limit $3"
    );
    let rows = sqlx::query_as::<_, FileRow>(&query)
        .bind(viewer.id)
        .bind(cursor)
        .bind(i64::from(limit) + 1)
        .fetch_all(&state.db)
        .await?;
    let next = if rows.len() > limit as usize {
        rows.get(limit as usize - 1).map(|r| r.id.to_string())
    } else {
        None
    };
    Ok(Json(
        json!({"data": rows.iter().take(limit as usize).map(FileRow::value).collect::<Vec<_>>(), "meta": {"nextCursor": next}}),
    ))
}
async fn metadata(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    viewer: Option<Viewer>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"data": find(&state,id,viewer.as_ref()).await?.value()}),
    ))
}
async fn content(
    State(state): State<AppState>,
    Extension(storage): Extension<Arc<dyn Storage>>,
    Path(id): Path<Uuid>,
    viewer: Option<Viewer>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let row = find(&state, id, viewer.as_ref()).await?;
    let etag = format!("\"{}\"", hex::encode(&row.sha256));
    let matches = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',').any(|tag| {
                let tag = tag.trim();
                tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
            })
        });
    let mut response = if matches {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let stream = match crate::storage::open(storage.as_ref(), &row.key).await {
            Ok(stream) => stream,
            Err(crate::storage::ReadError::Missing) => {
                // The row survived but its bytes did not. That is a missing file, not a server bug.
                tracing::warn!(file_id = %row.id, "stored file is missing");
                return Err(AppError::new(
                    ErrorCode::NotFound,
                    "This file is no longer available.",
                ));
            }
            Err(crate::storage::ReadError::Failed(error)) => {
                return Err(AppError::internal(error));
            }
        };
        Response::new(Body::from_stream(stream))
    };
    let h = response.headers_mut();
    h.insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(AppError::internal)?,
    );
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&row.content_type).map_err(AppError::internal)?,
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if row.visibility == "public" {
            "public, max-age=3600"
        } else {
            "private, max-age=300"
        }),
    );
    let name = row.original_name.as_deref().unwrap_or("file");
    let encoded: String = name
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if row.content_type == "application/pdf" {
            "attachment"
        } else {
            "inline"
        },
        encoded
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).map_err(AppError::internal)?,
    );
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    visibility: String,
}
async fn update(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    viewer: Viewer,
    Json(input): Json<Update>,
) -> AppResult<Json<Value>> {
    if !matches!(input.visibility.as_str(), "private" | "public") {
        return Err(invalid("visibility", "Choose private or public."));
    }
    let query = format!(
        "update files set visibility=$1 where id=$2 and owner_id=$3 and deleted_at is null returning {COLUMNS}"
    );
    let row = sqlx::query_as::<_, FileRow>(&query)
        .bind(input.visibility)
        .bind(id)
        .bind(viewer.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok(Json(json!({"data": row.value()})))
}
async fn delete(
    State(state): State<AppState>,
    Extension(storage): Extension<Arc<dyn Storage>>,
    Path(id): Path<Uuid>,
    viewer: Viewer,
    meta: RequestMeta,
) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    let query = format!(
        "select {COLUMNS} from files where id=$1 and deleted_at is null and (owner_id=$2 or $3) for update"
    );
    let row = sqlx::query_as::<_, FileRow>(&query)
        .bind(id)
        .bind(viewer.id)
        .bind(viewer.is_admin())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;
    storage.delete(&row.key).await.map_err(AppError::internal)?;
    sqlx::query("update files set deleted_at=now() where id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit(&state, &meta, viewer.id, id, "file.delete").await;
    Ok(Json(json!({"data": {"id": id}})))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod integration_tests {
    use super::*;
    use async_trait::async_trait;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use kernel::{config::Config, email::LogSender, viewer::Role};
    use tower::ServiceExt;

    /// A backend that fails every read with a cause that must never reach the client.
    struct BrokenStorage;
    #[async_trait]
    impl Storage for BrokenStorage {
        async fn put(&self, _key: &str, _bytes: bytes::Bytes) -> anyhow::Result<()> {
            anyhow::bail!("unused in this test")
        }
        async fn get(&self, _key: &str) -> anyhow::Result<storage::ObjectStream> {
            anyhow::bail!("permission denied: /secret/storage/root/u/file.png")
        }
        async fn delete(&self, _key: &str) -> anyhow::Result<()> {
            anyhow::bail!("unused in this test")
        }
    }

    async fn setup(db: sqlx::PgPool) -> (Router, Viewer, Viewer, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("files-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (app, owner, other) = setup_with(db, storage::test_local(&dir)).await;
        (app, owner, other, dir)
    }

    async fn setup_with(db: sqlx::PgPool, storage: Arc<dyn Storage>) -> (Router, Viewer, Viewer) {
        let config = Config::from_env().unwrap();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let mut viewers = Vec::new();
        for _ in 0..2 {
            let id = Uuid::new_v4();
            sqlx::query("insert into users (id,email) values ($1,$2)")
                .bind(id)
                .bind(format!("{id}@example.com"))
                .execute(&db)
                .await
                .unwrap();
            viewers.push(Viewer {
                id,
                session_id: Uuid::new_v4(),
                email: format!("{id}@example.com"),
                display_name: String::new(),
                role: Role::User,
                via_cookie: false,
            });
        }
        let app = router().layer(Extension(storage)).with_state(state);
        (app, viewers.remove(0), viewers.remove(0))
    }
    async fn body_json(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 100_000).await.unwrap()).unwrap()
    }
    fn request(method: &str, uri: &str, viewer: &Viewer, body: Body) -> Request<Body> {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .body(body)
            .unwrap();
        req.extensions_mut().insert(viewer.clone());
        req
    }
    fn multipart(data: &[u8]) -> Vec<u8> {
        let mut out = b"--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
        out.extend_from_slice(data);
        out.extend_from_slice(b"\r\n--boundary--\r\n");
        out
    }
    async fn upload(app: &Router, viewer: &Viewer, data: &[u8]) -> Response {
        let mut req = request("POST", "/files", viewer, Body::from(multipart(data)));
        req.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("multipart/form-data; boundary=boundary"),
        );
        app.clone().oneshot(req).await.unwrap()
    }
    fn png() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn upload_media_type_and_boundary_errors(db: sqlx::PgPool) {
        let (app, owner, _, dir) = setup(db).await;
        for (content_type, expected) in [
            (None, StatusCode::UNSUPPORTED_MEDIA_TYPE),
            (Some("text/plain"), StatusCode::UNSUPPORTED_MEDIA_TYPE),
            (Some("multipart/form-data"), StatusCode::BAD_REQUEST),
            (
                Some("multipart/form-data; boundary=broken"),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let mut req = request("POST", "/files", &owner, Body::from("invalid body"));
            if let Some(value) = content_type {
                req.headers_mut()
                    .insert(header::CONTENT_TYPE, HeaderValue::from_static(value));
            }
            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), expected, "{content_type:?}");
        }
        let req = Request::builder()
            .method("POST")
            .uri("/files")
            .header(header::CONTENT_TYPE, "text/plain")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(req).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn upload_fetch_delete(db: sqlx::PgPool) {
        let (app, owner, other, dir) = setup(db).await;
        let response = upload(&app, &owner, &png()).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 100_000).await.unwrap())
                .unwrap();
        let uri = format!("/files/{}", value["data"]["id"].as_str().unwrap());
        assert_eq!(
            app.clone()
                .oneshot(request("GET", &uri, &other, Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "GET",
                    &format!("{uri}/content"),
                    &owner,
                    Body::empty()
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(request("DELETE", &uri, &owner, Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.clone()
                .oneshot(request("GET", &uri, &owner, Body::empty()))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn size_quota_and_bomb(db: sqlx::PgPool) {
        let (app, owner, _, dir) = setup(db.clone()).await;
        assert_eq!(
            upload(&app, &owner, &vec![0; 4 * 1024 * 1024])
                .await
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let mut bomb = png();
        bomb[16..20].copy_from_slice(&30000u32.to_be_bytes());
        bomb[20..24].copy_from_slice(&30000u32.to_be_bytes());
        let mut crc = !0u32;
        for byte in &bomb[12..29] {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1)));
            }
        }
        bomb[29..33].copy_from_slice(&(!crc).to_be_bytes());
        assert_eq!(
            upload(&app, &owner, &bomb).await.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        sqlx::query("insert into files (id,owner_id,key,content_type,size_bytes,sha256) select gen_random_uuid(),$1,gen_random_uuid()::text,'image/png',1,decode(repeat('00',32),'hex') from generate_series(1,200)").bind(owner.id).execute(&db).await.unwrap();
        assert_eq!(
            upload(&app, &owner, &png()).await.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        sqlx::query("delete from files where owner_id=$1")
            .bind(owner.id)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into files (id,owner_id,key,content_type,size_bytes,sha256) values (gen_random_uuid(),$1,gen_random_uuid()::text,'image/png', $2, decode(repeat('00',32),'hex'))").bind(owner.id).bind(200_i64 * 1024 * 1024).execute(&db).await.unwrap();
        assert_eq!(
            upload(&app, &owner, &png()).await.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn missing_stored_bytes_are_404(db: sqlx::PgPool) {
        let (app, owner, _, dir) = setup(db).await;
        let response = upload(&app, &owner, &png()).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let value = body_json(response).await;
        let id = value["data"]["id"].as_str().unwrap();
        // The row stays while the bytes go: what a lost volume or a changed STORAGE_DIR looks like.
        std::fs::remove_dir_all(dir.join("u")).unwrap();
        let response = app
            .clone()
            .oneshot(request(
                "GET",
                &format!("/files/{id}/content"),
                &owner,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "NOT_FOUND");
        assert_eq!(
            body["error"]["message"],
            "This file is no longer available."
        );
        assert!(body["error"]["requestId"].is_string());
        // The metadata row is intact, so the file still shows up; only its bytes are gone.
        assert_eq!(
            app.oneshot(request(
                "GET",
                &format!("/files/{id}"),
                &owner,
                Body::empty()
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::OK
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn backend_failure_is_500_without_internals(db: sqlx::PgPool) {
        let (app, owner, _) = setup_with(db.clone(), Arc::new(BrokenStorage)).await;
        let id = Uuid::new_v4();
        sqlx::query("insert into files (id,owner_id,key,content_type,size_bytes,sha256) values ($1,$2,'u/test/file.png','image/png',1,decode(repeat('00',32),'hex'))")
            .bind(id)
            .bind(owner.id)
            .execute(&db)
            .await
            .unwrap();
        let response = app
            .oneshot(request(
                "GET",
                &format!("/files/{id}/content"),
                &owner,
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "INTERNAL");
        let text = body.to_string();
        assert!(!text.contains("secret"), "{text}");
        assert!(!text.contains("permission denied"), "{text}");
    }
}
