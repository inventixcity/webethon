//! Feature flags. Mount `router()` under `/api/v1`.
use axum::{
    Router,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, header},
    routing::get,
};
use kernel::{
    AppError, AppResult, AppState, ErrorCode, Viewer, crypto,
    extract::{Json, Path, ResponseJson},
    request::RequestMeta,
    security::{enforce_rate_limit, limits},
    session,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;

const COOKIE: &str = "flag_id";
const MAX_FLAGS: i64 = 1000;
#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    key: String,
    description: String,
    enabled: bool,
    rollout: i16,
    allow_emails: Vec<String>,
    allow_teams: Vec<Uuid>,
    value: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    description: String,
    enabled: bool,
    rollout: i16,
    #[serde(default)]
    allow_emails: Vec<String>,
    #[serde(default)]
    allow_teams: Vec<String>,
    value: Option<Value>,
}
struct AdminViewer(Viewer);
impl FromRequestParts<AppState> for AdminViewer {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let viewer = Viewer::from_request_parts(parts, state).await?;
        viewer.require_admin()?;
        Ok(Self(viewer))
    }
}
fn invalid(path: &str, message: &str) -> AppError {
    AppError::new(
        ErrorCode::ValidationFailed,
        "Please check the highlighted fields.",
    )
    .with_details(json!([{ "path": path, "message": message }]))
}
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.as_bytes()[0].is_ascii_lowercase()
        && key.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'-' | b'.')
        })
}
fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim().to_lowercase();
    let mut parts = email.split('@');
    let first = parts.next()?;
    let second = parts.next()?;
    if !(3..=254).contains(&email.len())
        || first.is_empty()
        || second.is_empty()
        || parts.next().is_some()
        || email.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    Some(email)
}
fn validate(key: String, input: Input) -> AppResult<Flag> {
    if !valid_key(&key) {
        return Err(invalid(
            "key",
            "Use up to 64 lowercase letters, numbers, dots, hyphens or underscores.",
        ));
    }
    if input.description.chars().count() > 500 {
        return Err(invalid("description", "Use at most 500 characters."));
    }
    if !(0..=100).contains(&input.rollout) {
        return Err(invalid("rollout", "Use a number from 0 to 100."));
    }
    if input.allow_emails.len() > 100 {
        return Err(invalid("allowEmails", "Use at most 100 emails."));
    }
    if input.allow_teams.len() > 100 {
        return Err(invalid("allowTeams", "Use at most 100 teams."));
    }
    let mut emails = Vec::new();
    for (i, email) in input.allow_emails.iter().enumerate() {
        emails.push(
            normalize_email(email)
                .ok_or_else(|| invalid(&format!("allowEmails.{i}"), "Enter a valid email."))?,
        );
    }
    let mut teams = Vec::new();
    for (i, team) in input.allow_teams.iter().enumerate() {
        teams.push(
            Uuid::parse_str(team)
                .map_err(|_| invalid(&format!("allowTeams.{i}"), "Enter a valid team ID."))?,
        );
    }
    if input
        .value
        .as_ref()
        .is_some_and(|v| serde_json::to_vec(v).map_or(true, |v| v.len() > 8192))
    {
        return Err(invalid("value", "Use at most 8 KiB of JSON."));
    }
    Ok(Flag {
        key,
        description: input.description,
        enabled: input.enabled,
        rollout: input.rollout,
        allow_emails: emails,
        allow_teams: teams,
        value: input.value,
    })
}

// Cache only definitions; membership is always read live. The database identity prevents test and
// multi-database pools from sharing definitions. Generation prevents an in-flight read restoring stale data.
type Cache = HashMap<String, (Instant, u64, Vec<Flag>)>;
static CACHE: OnceLock<Mutex<(u64, Cache)>> = OnceLock::new();
fn cache() -> &'static Mutex<(u64, Cache)> {
    CACHE.get_or_init(|| Mutex::new((0, HashMap::new())))
}
fn invalidate() {
    if let Ok(mut c) = cache().lock() {
        c.0 = c.0.wrapping_add(1);
        c.1.clear();
    }
}
async fn definitions(db: &PgPool) -> AppResult<Vec<Flag>> {
    let identity: String = sqlx::query_scalar("select current_database() || ':' || coalesce(inet_server_addr()::text, 'local') || ':' || coalesce(inet_server_port()::text, '')").fetch_one(db).await?;
    let generation = if let Ok(c) = cache().lock() {
        if let Some((at, _, flags)) = c.1.get(&identity)
            && at.elapsed() < Duration::from_secs(30)
        {
            return Ok(flags.clone());
        }
        c.0
    } else {
        0
    };
    let flags: Vec<Flag> = sqlx::query_as("select key,description,enabled,rollout,allow_emails,allow_teams,value from feature_flags order by key limit 1001").fetch_all(db).await?;
    if flags.len() > MAX_FLAGS as usize {
        return Err(AppError::internal("too many feature flags"));
    }
    if let Ok(mut c) = cache().lock()
        && c.0 == generation
    {
        if c.1.len() >= 4 {
            c.1.clear();
        }
        c.1.insert(identity, (Instant::now(), generation, flags.clone()));
    }
    Ok(flags)
}
fn bucket(key: &str, subject: &str) -> u64 {
    let hash = crypto::sha256(format!("{}:{key}:{subject}", key.len()).as_bytes());
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&hash[..8]);
    u64::from_be_bytes(bytes) % 100
}
async fn memberships(
    db: &PgPool,
    viewer: Option<&Viewer>,
    flags: &[Flag],
) -> AppResult<HashSet<Uuid>> {
    if let Some(viewer) = viewer
        && flags
            .iter()
            .any(|flag| flag.enabled && !flag.allow_teams.is_empty())
    {
        let teams: Vec<Uuid> = sqlx::query_scalar("select m.team_id from team_members m join teams t on t.id=m.team_id where m.user_id=$1 and t.deleted_at is null")
            .bind(viewer.id).fetch_all(db).await?;
        return Ok(teams.into_iter().collect());
    }
    Ok(HashSet::new())
}
fn evaluate(
    flag: &Flag,
    viewer: Option<&Viewer>,
    subject: Option<&str>,
    teams: &HashSet<Uuid>,
) -> bool {
    if !flag.enabled {
        return false;
    }
    if let Some(v) = viewer {
        if normalize_email(&v.email).is_some_and(|email| flag.allow_emails.contains(&email)) {
            return true;
        }
        if flag.allow_teams.iter().any(|team| teams.contains(team)) {
            return true;
        }
    }
    subject.is_some_and(|id| bucket(&flag.key, id) < flag.rollout as u64)
}
/// Evaluate a flag for a signed-in viewer. Anonymous server calls have no stable identity and
/// therefore do not participate in percentage rollouts.
pub async fn is_enabled(db: &PgPool, key: &str, viewer: Option<&Viewer>) -> AppResult<bool> {
    let flags = definitions(db).await?;
    let Some(flag) = flags.iter().find(|f| f.key == key) else {
        return Ok(false);
    };
    let subject = viewer.map(|v| v.id.to_string());
    let teams = memberships(db, viewer, std::slice::from_ref(flag)).await?;
    Ok(evaluate(flag, viewer, subject.as_deref(), &teams))
}
async fn public_flags(
    State(state): State<AppState>,
    meta: RequestMeta,
    viewer: Option<Viewer>,
    headers: HeaderMap,
) -> AppResult<(HeaderMap, ResponseJson<Value>)> {
    enforce_rate_limit(
        &state.db,
        &format!(
            "flags:read:{}",
            viewer
                .as_ref()
                .map_or_else(|| meta.ip.clone(), |v| v.id.to_string())
        ),
        limits::API_READ_PER_SUBJECT,
    )
    .await?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    let subject = if let Some(v) = &viewer {
        v.id.to_string()
    } else {
        match session::read_cookie(&headers, COOKIE).filter(|s| crypto::hash_token(s).is_some()) {
            Some(s) => s.to_owned(),
            None => {
                let (token, _) = crypto::new_token();
                let secure = if state.config.secure_cookies {
                    "; Secure"
                } else {
                    ""
                };
                let cookie = format!(
                    "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000{secure}"
                );
                response_headers.append(
                    header::SET_COOKIE,
                    HeaderValue::from_str(&cookie).map_err(AppError::internal)?,
                );
                token
            }
        }
    };
    let mut data = BTreeMap::new();
    let flags = definitions(&state.db).await?;
    let teams = memberships(&state.db, viewer.as_ref(), &flags).await?;
    for flag in flags {
        let enabled = evaluate(&flag, viewer.as_ref(), Some(&subject), &teams);
        let mut item = json!({"enabled": enabled});
        if enabled && let Some(value) = &flag.value {
            item["value"] = value.clone();
        }
        data.insert(flag.key, item);
    }
    Ok((response_headers, ResponseJson(json!({"data":data}))))
}
async fn admin_list(
    State(state): State<AppState>,
    AdminViewer(viewer): AdminViewer,
) -> AppResult<ResponseJson<Value>> {
    enforce_rate_limit(
        &state.db,
        &format!("flags:admin:read:{}", viewer.id),
        limits::API_READ_PER_SUBJECT,
    )
    .await?;
    let flags: Vec<Flag> = sqlx::query_as("select key,description,enabled,rollout,allow_emails,allow_teams,value from feature_flags order by key limit 1001").fetch_all(&state.db).await?;
    Ok(ResponseJson(json!({"data":flags})))
}
/// Store a validated definition in the caller's transaction. The caller must authorize step-up,
/// audit, commit, then call `invalidate_cache`.
pub async fn put_tx(
    tx: &mut Transaction<'_, Postgres>,
    key: String,
    input: Input,
) -> AppResult<(Option<Flag>, Flag)> {
    let flag = validate(key, input)?;
    if let Some(value) = &flag.value {
        let size: i32 = sqlx::query_scalar("select octet_length($1::jsonb::text)")
            .bind(value)
            .fetch_one(&mut **tx)
            .await?;
        if size > 8192 {
            return Err(invalid("value", "Use at most 8 KiB of JSON."));
        }
    }
    sqlx::query("select pg_advisory_xact_lock(78341002)")
        .execute(&mut **tx)
        .await?;
    let before = sqlx::query_as::<_, Flag>("select key,description,enabled,rollout,allow_emails,allow_teams,value from feature_flags where key=$1 for update").bind(&flag.key).fetch_optional(&mut **tx).await?;
    if before.is_none() {
        let count: i64 = sqlx::query_scalar("select count(*) from feature_flags")
            .fetch_one(&mut **tx)
            .await?;
        if count >= MAX_FLAGS {
            return Err(AppError::new(ErrorCode::LimitReached, "Too many flags."));
        }
    }
    sqlx::query("insert into feature_flags(key,description,enabled,rollout,allow_emails,allow_teams,value) values($1,$2,$3,$4,$5,$6,$7) on conflict(key) do update set description=excluded.description,enabled=excluded.enabled,rollout=excluded.rollout,allow_emails=excluded.allow_emails,allow_teams=excluded.allow_teams,value=excluded.value")
        .bind(&flag.key).bind(&flag.description).bind(flag.enabled).bind(flag.rollout).bind(&flag.allow_emails).bind(&flag.allow_teams).bind(&flag.value).execute(&mut **tx).await?;
    Ok((before, flag))
}
/// Delete a definition in the caller's transaction.
pub async fn delete_tx(tx: &mut Transaction<'_, Postgres>, key: &str) -> AppResult<Flag> {
    sqlx::query_as::<_, Flag>("delete from feature_flags where key=$1 returning key,description,enabled,rollout,allow_emails,allow_teams,value").bind(key).fetch_optional(&mut **tx).await?.ok_or_else(AppError::not_found)
}
pub fn invalidate_cache() {
    invalidate();
}
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    viewer: &Viewer,
    meta: &RequestMeta,
    action: &str,
    key: &str,
    before: Option<&Flag>,
    after: Option<&Flag>,
) -> AppResult<()> {
    sqlx::query("insert into audit_log(actor_id,action,target_type,target_id,ip,user_agent,request_id,meta) values($1,$2,'flag',$3,$4,$5,$6,$7)")
        .bind(viewer.id).bind(action).bind(key).bind(&meta.ip).bind(&meta.user_agent).bind(&meta.request_id).bind(json!({"before":before,"after":after})).execute(&mut **tx).await?;
    Ok(())
}
async fn put(
    State(state): State<AppState>,
    meta: RequestMeta,
    AdminViewer(viewer): AdminViewer,
    Path(key): Path<String>,
    Json(input): Json<Input>,
) -> AppResult<ResponseJson<Value>> {
    enforce_rate_limit(
        &state.db,
        &format!("flags:admin:write:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    let mut tx = state.db.begin().await?;
    admin::require_step_up(&mut tx, &state, &viewer).await?;
    let (before, after) = put_tx(&mut tx, key, input).await?;
    audit(
        &mut tx,
        &viewer,
        &meta,
        "flag.put",
        &after.key,
        before.as_ref(),
        Some(&after),
    )
    .await?;
    tx.commit().await?;
    invalidate();
    Ok(ResponseJson(json!({"data":after})))
}
async fn delete(
    State(state): State<AppState>,
    meta: RequestMeta,
    AdminViewer(viewer): AdminViewer,
    Path(key): Path<String>,
) -> AppResult<ResponseJson<Value>> {
    enforce_rate_limit(
        &state.db,
        &format!("flags:admin:write:{}", viewer.id),
        limits::API_WRITE_PER_SUBJECT,
    )
    .await?;
    let mut tx = state.db.begin().await?;
    admin::require_step_up(&mut tx, &state, &viewer).await?;
    let before = delete_tx(&mut tx, &key).await?;
    audit(
        &mut tx,
        &viewer,
        &meta,
        "flag.delete",
        &key,
        Some(&before),
        None,
    )
    .await?;
    tx.commit().await?;
    invalidate();
    Ok(ResponseJson(json!({"data": {"deleted":true}})))
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/flags", get(public_flags))
        .route("/admin/flags", get(admin_list))
        .route("/admin/flags/{key}", axum::routing::put(put).delete(delete))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use kernel::viewer::Role;
    fn input() -> Input {
        Input {
            description: String::new(),
            enabled: true,
            rollout: 0,
            allow_emails: vec![],
            allow_teams: vec![],
            value: None,
        }
    }
    fn viewer(id: Uuid, email: &str) -> Viewer {
        Viewer {
            id,
            session_id: Uuid::new_v4(),
            email: email.into(),
            display_name: String::new(),
            role: Role::User,
            via_cookie: false,
        }
    }
    #[test]
    fn validation_and_rollout() {
        assert!(valid_key("checkout.new-ui"));
        assert!(!valid_key("Bad key"));
        assert_eq!(
            normalize_email("  A@Example.com ").unwrap(),
            "a@example.com"
        );
        assert!(normalize_email("a@@example.com").is_none());
        let mut data = input();
        data.rollout = 101;
        assert!(validate("valid".into(), data).is_err());
        let mut data = input();
        data.allow_emails.push("bad".into());
        assert!(validate("valid".into(), data).is_err());
        assert_eq!(bucket("flag", "subject"), bucket("flag", "subject"));
        assert!(bucket("flag", "subject") < 100);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn evaluation_and_live_membership(db: PgPool) {
        let id: Uuid =
            sqlx::query_scalar("insert into users(email) values('a@example.com') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Test','test-team',$1) returning id",
        )
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'owner')")
            .bind(team)
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        let mut data = input();
        data.allow_teams.push(team.to_string());
        let mut tx = db.begin().await.unwrap();
        put_tx(&mut tx, "test".into(), data).await.unwrap();
        tx.commit().await.unwrap();
        invalidate_cache();
        let v = viewer(id, "a@example.com");
        assert!(is_enabled(&db, "test", Some(&v)).await.unwrap());
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert!(!is_enabled(&db, "test", Some(&v)).await.unwrap());
        let mut data = input();
        data.allow_emails.push(" A@Example.com ".into());
        let mut tx = db.begin().await.unwrap();
        put_tx(&mut tx, "test".into(), data).await.unwrap();
        tx.commit().await.unwrap();
        invalidate_cache();
        assert!(is_enabled(&db, "test", Some(&v)).await.unwrap());
        let mut data = input();
        data.rollout = 100;
        let mut tx = db.begin().await.unwrap();
        put_tx(&mut tx, "test".into(), data).await.unwrap();
        tx.commit().await.unwrap();
        invalidate_cache();
        assert!(is_enabled(&db, "test", Some(&v)).await.unwrap());
        assert!(!is_enabled(&db, "test", None).await.unwrap());
    }
    async fn request(
        state: &AppState,
        method: &str,
        path: &str,
        token: Option<&str>,
        cookie: Option<&str>,
        body: String,
    ) -> axum::response::Response {
        use tower::ServiceExt;
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        if let Some(cookie) = cookie {
            req = req.header("cookie", cookie);
        }
        router()
            .with_state(state.clone())
            .oneshot(req.body(axum::body::Body::from(body)).unwrap())
            .await
            .unwrap()
    }
    async fn body(response: axum::response::Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn http_security_and_evaluation_matrix(db: PgPool) {
        use axum::http::{StatusCode, header};
        use std::sync::Arc;
        let admin: Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('admin@flags.test','admin') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let user: Uuid =
            sqlx::query_scalar("insert into users(email) values('user@flags.test') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let (at, ah) = crypto::new_token();
        let sid: Uuid = sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id").bind(admin).bind(ah.as_slice()).fetch_one(&db).await.unwrap();
        let (ut, uh) = crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(user).bind(uh.as_slice()).execute(&db).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        for (method, path, payload) in [
            ("GET", "/admin/flags", ""),
            ("PUT", "/admin/flags/test", "{"),
            ("DELETE", "/admin/flags/test", ""),
        ] {
            assert_eq!(
                request(&state, method, path, Some(&ut), None, payload.into())
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        let payload = r#"{"description":"test","enabled":true,"rollout":100,"value":{"x":1}}"#;
        assert_eq!(
            request(
                &state,
                "PUT",
                "/admin/flags/test",
                Some(&at),
                None,
                payload.into()
            )
            .await
            .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()-interval '1 minute',digest('','sha256'))").bind(sid).execute(&db).await.unwrap();
        assert_eq!(
            request(
                &state,
                "PUT",
                "/admin/flags/test",
                Some(&at),
                None,
                payload.into()
            )
            .await
            .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        sqlx::query(
            "update admin_step_up set expires_at=now()+interval '10 minutes' where session_id=$1",
        )
        .bind(sid)
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(
            request(
                &state,
                "PUT",
                "/admin/flags/test",
                Some(&at),
                None,
                payload.into()
            )
            .await
            .status(),
            StatusCode::OK
        );
        let response = request(&state, "GET", "/flags", None, None, String::new()).await;
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        assert_eq!(body(response).await["data"]["test"]["enabled"], true);
        let response = request(&state, "GET", "/flags", None, Some(&cookie), String::new()).await;
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        assert_eq!(body(response).await["data"]["test"]["enabled"], true);
        let replacement = r#"{"description":"test","enabled":true,"rollout":0,"allowEmails":[" USER@flags.test "]}"#;
        assert_eq!(
            request(
                &state,
                "PUT",
                "/admin/flags/test",
                Some(&at),
                None,
                replacement.into()
            )
            .await
            .status(),
            StatusCode::OK
        );
        let anon =
            body(request(&state, "GET", "/flags", None, Some(&cookie), String::new()).await).await;
        assert_eq!(anon["data"]["test"]["enabled"], false);
        let signed =
            body(request(&state, "GET", "/flags", Some(&ut), None, String::new()).await).await;
        assert_eq!(signed["data"]["test"]["enabled"], true);
        assert!(signed["data"]["test"].get("value").is_none());
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Team','flags-team',$1) returning id",
        )
        .bind(user)
        .fetch_one(&db)
        .await
        .unwrap();
        let payload = json!({"description":"test","enabled":true,"rollout":0,"allowTeams":[team]})
            .to_string();
        assert_eq!(
            request(&state, "PUT", "/admin/flags/test", Some(&at), None, payload)
                .await
                .status(),
            StatusCode::OK
        );
        for expected in [false, true, false] {
            assert_eq!(
                body(request(&state, "GET", "/flags", Some(&ut), None, String::new()).await).await
                    ["data"]["test"]["enabled"],
                expected
            );
            if !expected {
                sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'owner') on conflict do nothing").bind(team).bind(user).execute(&db).await.unwrap();
            } else {
                sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
                    .bind(team)
                    .bind(user)
                    .execute(&db)
                    .await
                    .unwrap();
            }
        }
        for payload in [
            json!({"description":"x","enabled":true,"rollout":0,"extra":1}),
            json!({"description":"x","enabled":true,"rollout":0,"value":"x".repeat(8200)}),
            json!({"description":"x","enabled":true,"rollout":0,"allowEmails":["bad@@example.com"]}),
        ] {
            let response = request(
                &state,
                "PUT",
                "/admin/flags/test",
                Some(&at),
                None,
                payload.to_string(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(body(response).await["error"]["details"].is_array());
        }
        assert_eq!(
            request(
                &state,
                "DELETE",
                "/admin/flags/test",
                Some(&at),
                None,
                String::new()
            )
            .await
            .status(),
            StatusCode::OK
        );
        let actions: Vec<String> =
            sqlx::query_scalar("select action from audit_log where target_type='flag'")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(actions.iter().filter(|a| *a == "flag.put").count(), 3);
        assert_eq!(actions.iter().filter(|a| *a == "flag.delete").count(), 1);
    }
}
