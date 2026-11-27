use axum::{
    Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use kernel::{
    AppError, AppResult, AppState,
    config::OAuthClient,
    crypto,
    extract::{Path, Query},
    request::RequestMeta,
    security::{self, AuditEntry, limits},
    session,
};
use oauth2::{PkceCodeChallenge, PkceCodeVerifier};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
struct Cookie {
    provider: String,
    state: String,
    verifier: String,
    next: String,
    issued: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    next: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn next_path(next: &str) -> &str {
    if next.len() > 512
        || !next.starts_with('/')
        || next.starts_with("//")
        || next.contains('\\')
        || next.chars().any(char::is_control)
        || ["/api", "/login", "/signup"].iter().any(|p| {
            next == *p
                || next.starts_with(&format!("{p}/"))
                || next.starts_with(&format!("{p}?"))
                || next.starts_with(&format!("{p}#"))
        })
    {
        "/app"
    } else {
        next
    }
}
fn sign(state: &AppState, data: &Cookie) -> AppResult<String> {
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(data).map_err(AppError::internal)?);
    let mac = crypto::hmac_sha256(
        state.config.code_pepper.expose_secret().as_bytes(),
        &[b"oauth-state", body.as_bytes()],
    );
    Ok(format!("{body}.{}", URL_SAFE_NO_PAD.encode(mac)))
}
fn unsign(state: &AppState, raw: &str) -> Option<Cookie> {
    if raw.len() > 4096 {
        return None;
    }
    let (body, sig) = raw.split_once('.')?;
    let expected = crypto::hmac_sha256(
        state.config.code_pepper.expose_secret().as_bytes(),
        &[b"oauth-state", body.as_bytes()],
    );
    if !crypto::constant_time_eq(&URL_SAFE_NO_PAD.decode(sig).ok()?, &expected) {
        return None;
    }
    let data: Cookie = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
    if data.issued > now() || now() - data.issued > 600 {
        return None;
    }
    Some(data)
}
fn client<'a>(state: &'a AppState, provider: &str) -> Option<&'a OAuthClient> {
    match provider {
        "google" => state.config.google.as_ref(),
        "github" => state.config.github.as_ref(),
        _ => None,
    }
}
fn cookie(state: &AppState, value: &str, age: u32) -> AppResult<HeaderValue> {
    let secure = if state.config.secure_cookies {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!("oauth_state={value}; Path=/api/v1/auth/oauth; HttpOnly; SameSite=Lax; Max-Age={age}{secure}")).map_err(AppError::internal)
}
async fn start(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(input): Query<Start>,
    meta: RequestMeta,
) -> AppResult<Response> {
    security::enforce_rate_limit(
        &state.db,
        &format!("oauth:ip:{}", meta.ip),
        state.config.scaled_ip_limit(limits::SIGN_IN_PER_IP),
    )
    .await?;
    let config = client(&state, &provider).ok_or_else(AppError::not_found)?;
    if let Some(next) = &input.next {
        crate::validate::length(next, "next", 0, 512)?;
    }
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let data = Cookie {
        provider: provider.clone(),
        state: crypto::new_token().0,
        verifier: verifier.secret().to_owned(),
        next: next_path(input.next.as_deref().unwrap_or("/app")).to_owned(),
        issued: now(),
    };
    let endpoint = if provider == "google" {
        "https://accounts.google.com/o/oauth2/v2/auth"
    } else {
        "https://github.com/login/oauth/authorize"
    };
    let mut url = reqwest::Url::parse(endpoint).map_err(AppError::internal)?;
    url.query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair(
            "redirect_uri",
            &format!(
                "{}/api/v1/auth/oauth/{provider}/callback",
                state.config.app_origin
            ),
        )
        .append_pair("response_type", "code")
        .append_pair(
            "scope",
            if provider == "google" {
                "openid email profile"
            } else {
                "read:user user:email"
            },
        )
        .append_pair("state", &data.state)
        .append_pair("code_challenge", challenge.as_str())
        .append_pair("code_challenge_method", "S256");
    Ok((
        StatusCode::FOUND,
        [
            (
                header::LOCATION,
                HeaderValue::from_str(url.as_str()).map_err(AppError::internal)?,
            ),
            (
                header::SET_COOKIE,
                cookie(&state, &sign(&state, &data)?, 600)?,
            ),
        ],
    )
        .into_response())
}
async fn callback(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(input): Query<Callback>,
    headers: HeaderMap,
    meta: RequestMeta,
) -> AppResult<Response> {
    security::enforce_rate_limit(
        &state.db,
        &format!("oauth:ip:{}", meta.ip),
        state.config.scaled_ip_limit(limits::SIGN_IN_PER_IP),
    )
    .await?;
    let config = client(&state, &provider).ok_or_else(AppError::not_found)?;
    let result = async {
        let saved=unsign(&state,session::read_cookie(&headers,"oauth_state")?)?;
        let supplied=input.state.as_deref()?;
        if supplied.len()>128 { return None; }
        if saved.provider != provider || !crypto::constant_time_eq(saved.state.as_bytes(),supplied.as_bytes()) { return None; }
        let code=input.code.as_deref()?;
        if code.len()>4096 { return None; }
        let redirect=format!("{}/api/v1/auth/oauth/{provider}/callback",state.config.app_origin);
        let endpoint=if provider=="google" {"https://oauth2.googleapis.com/token"} else {"https://github.com/login/oauth/access_token"};
        let verifier=PkceCodeVerifier::new(saved.verifier.clone());
        let response: Value=state.http.post(endpoint).header("Accept","application/json").form(&[("client_id",config.client_id.as_str()),("client_secret",config.client_secret.expose_secret()),("code",code),("redirect_uri",redirect.as_str()),("grant_type","authorization_code"),("code_verifier",verifier.secret())]).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
        let token=response.get("access_token")?.as_str()?;
        let endpoint=if provider=="google" {"https://openidconnect.googleapis.com/v1/userinfo"} else {"https://api.github.com/user"};
        let profile: Value=state.http.get(endpoint).header("User-Agent","invigil-auth").bearer_auth(token).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
        let (subject,email,name)=if provider=="google" {
            if !profile.get("email_verified")?.as_bool()? { return None; }
            (profile.get("sub")?.as_str()?.to_owned(),profile.get("email")?.as_str()?.to_owned(),profile.get("name").and_then(Value::as_str).unwrap_or("User").to_owned())
        } else {
            let emails: Vec<Value>=state.http.get("https://api.github.com/user/emails").header("User-Agent","invigil-auth").bearer_auth(token).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
            let email=emails.iter().find(|e| e.get("primary").and_then(Value::as_bool)==Some(true) && e.get("verified").and_then(Value::as_bool)==Some(true))?.get("email")?.as_str()?.to_owned();
            (profile.get("id")?.as_i64()?.to_string(),email,profile.get("name").and_then(Value::as_str).or_else(||profile.get("login").and_then(Value::as_str)).unwrap_or("User").to_owned())
        };
        let email=crate::validate::email(&email).ok()?;
        if subject.is_empty() || subject.len()>128 { return None; }
        let name: String=name.chars().filter(|c| !c.is_control()).take(120).collect();
        let mut tx=state.db.begin().await.ok()?;
        let linked: Option<Uuid>=sqlx::query_scalar("select user_id from oauth_accounts where provider=$1 and provider_user_id=$2").bind(&provider).bind(&subject).fetch_optional(&mut *tx).await.ok()?;
        let id=if let Some(id)=linked { id } else {
            let id: Uuid=sqlx::query_scalar("insert into users (email,display_name,email_verified_at) values ($1,$2,now()) on conflict (email) do update set email_verified_at=coalesce(users.email_verified_at,now()) where users.deleted_at is null and users.status='active' and users.email_verified_at is not null returning id").bind(&email).bind(&name).fetch_optional(&mut *tx).await.ok()??;
            sqlx::query("insert into oauth_accounts (provider,provider_user_id,user_id) values ($1,$2,$3)").bind(&provider).bind(&subject).bind(id).execute(&mut *tx).await.ok()?;
            id
        };
        let active: bool=sqlx::query_scalar("select exists(select 1 from users where id=$1 and deleted_at is null and status='active')").bind(id).fetch_one(&mut *tx).await.ok()?;
        if !active { return None; }
        tx.commit().await.ok()?;
        if linked.is_none() { security::audit(&state.db,&meta,AuditEntry {action:"auth.oauth_linked",actor_id:Some(id),target_type:Some("user"),target_id:Some(id.to_string()),meta:json!({})}).await; }
        security::audit(&state.db,&meta,AuditEntry {action:"auth.signin",actor_id:Some(id),target_type:Some("user"),target_id:Some(id.to_string()),meta:json!({})}).await;
        Some((id,saved.next))
    }.await;
    finish_callback(&state, &meta, result).await
}
async fn finish_callback(
    state: &AppState,
    meta: &RequestMeta,
    result: Option<(Uuid, String)>,
) -> AppResult<Response> {
    let (location, session_cookie) = if let Some((id, next)) = result {
        match crate::mfa::issue(state, meta, id).await? {
            crate::mfa::Login::Challenge(token) => {
                let mut url = reqwest::Url::parse(&format!("{}/verify", state.config.app_origin))
                    .map_err(AppError::internal)?;
                url.query_pairs_mut()
                    .append_pair("mfa", &token)
                    .append_pair("next", next_path(&next));
                (url.to_string(), None)
            }
            crate::mfa::Login::Session(token) => (
                format!("{}{}", state.config.app_origin, next_path(&next)),
                Some(session::cookie(
                    &state.config,
                    &token,
                    state.config.session_ttl,
                )),
            ),
        }
    } else {
        (
            format!("{}/login?error=oauth", state.config.app_origin),
            None,
        )
    };
    let mut response = (
        StatusCode::FOUND,
        [
            (
                header::LOCATION,
                HeaderValue::from_str(&location).map_err(AppError::internal)?,
            ),
            (header::SET_COOKIE, cookie(state, "", 0)?),
        ],
    )
        .into_response();
    if let Some(value) = session_cookie {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    Ok(response)
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth/{provider}/start", get(start))
        .route("/oauth/{provider}/callback", get(callback))
}
#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::next_path;
    #[sqlx::test(migrations = "../../migrations")]
    async fn callback_mfa_redirect_and_fail_closed(db: sqlx::PgPool) {
        use axum::http::{StatusCode, header};
        use std::sync::Arc;
        let mut state = kernel::AppState {
            db,
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let meta = kernel::request::RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: "test".into(),
            request_id: uuid::Uuid::new_v4().to_string(),
        };
        let id:uuid::Uuid=sqlx::query_scalar("insert into users(email,email_verified_at) values('oauth@example.com',now()) returning id").fetch_one(&state.db).await.unwrap();
        sqlx::query("insert into mfa_totp(user_id,secret_ciphertext,secret_nonce,enabled_at) values($1,$2,$3,now())").bind(id).bind([0u8;36].as_slice()).bind([0u8;12].as_slice()).execute(&state.db).await.unwrap();
        let response =
            super::finish_callback(&state, &meta, Some((id, "/projects?a=1&b=2".into())))
                .await
                .unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        let location = response.headers()[header::LOCATION].to_str().unwrap();
        assert!(location.starts_with(&format!("{}/verify?mfa=", state.config.app_origin)));
        let url = reqwest::Url::parse(location).unwrap();
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "next").unwrap().1,
            "/projects?a=1&b=2"
        );
        let token = url
            .query_pairs()
            .find(|(k, _)| k == "mfa")
            .unwrap()
            .1
            .into_owned();
        let stored:Vec<u8>=sqlx::query_scalar("select token_hash from mfa_challenges where user_id=$1 and expires_at>now() and attempts=0").bind(id).fetch_one(&state.db).await.unwrap();
        assert_eq!(stored, kernel::crypto::hash_token(&token).unwrap());
        assert!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .all(|value| !value
                    .to_str()
                    .unwrap()
                    .starts_with(&format!("{}=", state.config.session_cookie)))
        );
        Arc::make_mut(&mut state.config).environment = kernel::config::Environment::Production;
        assert_eq!(
            super::finish_callback(&state, &meta, Some((id, "/app".into())))
                .await
                .unwrap_err()
                .code,
            kernel::ErrorCode::NotConfigured
        );
        Arc::make_mut(&mut state.config).environment = kernel::config::Environment::Development;
        sqlx::query("update users set deleted_at=now() where id=$1")
            .bind(id)
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(
            super::finish_callback(&state, &meta, Some((id, "/app".into())))
                .await
                .unwrap_err()
                .code,
            kernel::ErrorCode::Unauthenticated
        );
        let sessions: i64 = sqlx::query_scalar("select count(*) from sessions")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(sessions, 0);
    }
    #[test]
    fn sanitises_next() {
        for s in [
            "//evil", "/\\evil", "/api/v1", "/login?x", "/signup", "/x\n",
        ] {
            assert_eq!(next_path(s), "/app");
        }
        assert_eq!(next_path("/projects?a=1"), "/projects?a=1");
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn cookie_signature_and_expiry(db: sqlx::PgPool) {
        use super::{Cookie, now, sign, unsign};
        use std::sync::Arc;
        let config = kernel::config::Config::from_env().unwrap();
        let state = kernel::AppState {
            db,
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let mut data = Cookie {
            provider: "google".into(),
            state: "state".into(),
            verifier: "verifier".into(),
            next: "/app".into(),
            issued: now(),
        };
        let signed = sign(&state, &data).unwrap();
        assert!(unsign(&state, &signed).is_some());
        assert!(unsign(&state, &format!("{signed}x")).is_none());
        data.issued = now().saturating_sub(601);
        assert!(unsign(&state, &sign(&state, &data).unwrap()).is_none());
    }
}
