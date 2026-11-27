use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use examcore::{AppState, Viewer};
use hmac::{Hmac, Mac};
use kernel::{
    email::Email,
    request::RequestMeta,
    security::{AuditEntry, Limit, audit, enforce_rate_limit},
};
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use sqlx::Row;
use std::time::Duration;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/contact", post(submit))
        .route("/institute-requests", get(list))
        .route("/institute-requests/{id}", patch(update))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactInput {
    institute: String,
    contact_name: String,
    email: String,
    phone: Option<String>,
    role: Option<String>,
    expected_candidates: Option<i32>,
    message: String,
    website: Option<String>,
}
fn valid(i: &ContactInput) -> bool {
    let email = i.email.trim();
    (2..=160).contains(&i.institute.trim().chars().count())
        && (2..=120).contains(&i.contact_name.trim().chars().count())
        && email.len() <= 254
        && email.split_once('@').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.contains('@')
                && b.contains('.')
                && !b.starts_with('.')
                && !b.ends_with('.')
        })
        && email
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._+-@".contains(&c))
        && i.phone.as_ref().is_none_or(|v| {
            (7..=20).contains(&v.chars().count())
                && v.chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | ' '))
        })
        && i.role.as_ref().is_none_or(|v| v.chars().count() <= 80)
        && i.expected_candidates
            .is_none_or(|v| (1..=1_000_000).contains(&v))
        && (10..=2000).contains(&i.message.trim().chars().count())
}
fn is_honeypot(i: &ContactInput) -> bool {
    i.website.as_deref().is_some_and(|v| !v.trim().is_empty())
}
fn keyed_ip_hash(secret: &[u8], ip: &str) -> Result<String, examcore::AppError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(examcore::AppError::internal)?;
    mac.update(ip.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}
async fn submit(
    State(s): State<AppState>,
    meta: RequestMeta,
    Json(i): Json<ContactInput>,
) -> Result<(StatusCode, Json<serde_json::Value>), examcore::AppError> {
    if is_honeypot(&i) {
        return Ok((StatusCode::ACCEPTED, examcore::ok(json!({"received":true}))));
    }
    if !valid(&i) {
        return Err(examcore::invalid(
            "contact",
            "Please check the submitted details.",
        ));
    }
    enforce_rate_limit(
        &s.db,
        &format!("contact:ip:{}", meta.ip),
        Limit {
            limit: 5,
            window: Duration::from_secs(3600),
        },
    )
    .await?;
    let email = i.email.trim().to_lowercase();
    enforce_rate_limit(
        &s.db,
        &format!("contact:email:{email}"),
        Limit {
            limit: 3,
            window: Duration::from_secs(86400),
        },
    )
    .await?;
    let ip_hash = keyed_ip_hash(s.config.code_pepper.expose_secret().as_bytes(), &meta.ip)?;
    let id:Uuid=sqlx::query_scalar("insert into institute_requests(institute,contact_name,email,phone,role,expected_candidates,message,ip_hash) values($1,$2,$3,$4,$5,$6,$7,$8) returning id")
 .bind(i.institute.trim()).bind(i.contact_name.trim()).bind(&email).bind(i.phone.as_deref()).bind(i.role.as_deref()).bind(i.expected_candidates).bind(i.message.trim()).bind(ip_hash).fetch_one(&s.db).await?;
    let fields = kernel::email_layout::details(&[
        ("Request ID", &id.to_string()),
        ("Institute", i.institute.trim()),
        ("Contact", i.contact_name.trim()),
        ("Email", &email),
        ("Phone", i.phone.as_deref().unwrap_or("-")),
        ("Role", i.role.as_deref().unwrap_or("-")),
        (
            "Expected candidates",
            &i.expected_candidates.map_or("-".into(), |v| v.to_string()),
        ),
        ("Message", i.message.trim()),
    ]);
    let inbox = std::env::var("CONTACT_INBOX").unwrap_or_else(|_| "info@inventixhq.com".into());
    let _ = s
        .email
        .send(&Email {
            to: inbox,
            subject: "New institute request".into(),
            html: kernel::email_layout::layout("CONTACT / NEW REQUEST", "Institute enquiry", "A new institute request has arrived", &fields, "A visitor submitted the contact form on Inventix Invigil."),
            text: format!("New institute request {id}\n\nInstitute: {}\nContact: {}\nEmail: {}\nPhone: {}\nRole: {}\nExpected candidates: {}\n\nMessage:\n{}", i.institute.trim(), i.contact_name.trim(), email, i.phone.as_deref().unwrap_or("-"), i.role.as_deref().unwrap_or("-"), i.expected_candidates.map_or("-".into(), |v| v.to_string()), i.message.trim()),
            reply_to: Some(email.clone()),
        })
        .await;
    let _ = s
        .email
        .send(&Email {
            to: email,
            subject: "We received your institute request".into(),
            html: kernel::email_layout::layout("CONTACT / RECEIVED", "Thank you for reaching out", "Your institute request has been received", "<p style=\"font:15px/1.6 Helvetica,Arial,sans-serif;color:#12110E\">Thank you for contacting Inventix Invigil. Our team will be in touch.</p>", "You received this acknowledgement because you submitted an institute request."),
            text: "Thank you for contacting Inventix Invigil. Our team will be in touch.\n\nInventix Invigil · Exams that hold up.\ninfo@inventixhq.com · COMSATS University Lahore, Pakistan\nWe never ask for your password by email.".into(),
            reply_to: None,
        })
        .await;
    Ok((StatusCode::ACCEPTED, examcore::ok(json!({"received":true}))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ContactInput {
        ContactInput {
            institute: "North College".into(),
            contact_name: "Ada Example".into(),
            email: "ada@example.edu".into(),
            phone: Some("+92 300 1234567".into()),
            role: None,
            expected_candidates: Some(500),
            message: "We need an examination platform.".into(),
            website: None,
        }
    }

    #[test]
    fn validates_contact_fields_and_bounds() {
        let mut input = sample();
        assert!(valid(&input));
        input.email = "ada@example.edu\r\nBcc:bad@example.edu".into();
        assert!(!valid(&input));
        input = sample();
        input.expected_candidates = Some(1_000_001);
        assert!(!valid(&input));
        input = sample();
        input.phone = Some("1234567;".into());
        assert!(!valid(&input));
    }

    #[test]
    #[allow(clippy::expect_used)]
    fn contact_ip_pseudonym_is_keyed() {
        let ip = "203.0.113.7";
        let first = keyed_ip_hash(b"server secret one", ip).expect("first HMAC");
        let same = keyed_ip_hash(b"server secret one", ip).expect("repeat HMAC");
        let rotated = keyed_ip_hash(b"server secret two", ip).expect("rotated HMAC");
        assert_eq!(first, same);
        assert_ne!(first, rotated);
        assert_ne!(first, hex::encode(kernel::crypto::sha256(ip.as_bytes())));
    }

    #[test]
    fn honeypot_requests_are_recognized_without_storage() {
        let mut input = sample();
        assert!(!is_honeypot(&input));
        input.website = Some("https://spam.invalid".into());
        assert!(is_honeypot(&input));
    }

    #[test]
    fn rejects_unknown_fields_and_escapes_html() {
        assert!(serde_json::from_str::<ContactInput>(r#"{"unexpected":true}"#).is_err());
        assert_eq!(
            kernel::email_layout::escape("<a&'\""),
            "&lt;a&amp;&#39;&quot;"
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    #[allow(clippy::expect_used)]
    async fn honeypot_returns_accepted_without_inserting(db: sqlx::PgPool) {
        use axum::{body::Body, http::Request};
        use kernel::email::LogSender;
        use std::sync::Arc;
        use tower::ServiceExt;

        let before: i64 = sqlx::query_scalar("select count(*) from institute_requests")
            .fetch_one(&db)
            .await
            .expect("count requests");
        let state = AppState {
            db: db.clone(),
            config: Arc::new(kernel::config::Config::from_env().expect("test config")),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let request = Request::post("/contact")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"institute":"Example College","contactName":"Ada Example","email":"ada@example.edu","message":"We need help with examinations.","website":"spam"}"#,
            ))
            .expect("contact request");
        let response = router()
            .with_state(state)
            .oneshot(request)
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let after: i64 = sqlx::query_scalar("select count(*) from institute_requests")
            .fetch_one(&db)
            .await
            .expect("count requests");
        assert_eq!(before, after);
    }

    #[sqlx::test(migrations = "../../migrations")]
    #[allow(clippy::expect_used)]
    async fn contact_budgets_limit_ip_to_five_and_email_to_three(db: sqlx::PgPool) {
        use kernel::security::{Limit, enforce_rate_limit};
        use std::time::Duration;

        let ip_key = format!("cx7-contact-ip:{}", Uuid::new_v4());
        for _ in 0..5 {
            enforce_rate_limit(
                &db,
                &ip_key,
                Limit {
                    limit: 5,
                    window: Duration::from_secs(3600),
                },
            )
            .await
            .expect("allowed IP submission");
        }
        assert!(
            enforce_rate_limit(
                &db,
                &ip_key,
                Limit {
                    limit: 5,
                    window: Duration::from_secs(3600)
                },
            )
            .await
            .is_err()
        );

        let email_key = format!("cx7-contact-email:{}", Uuid::new_v4());
        for _ in 0..3 {
            enforce_rate_limit(
                &db,
                &email_key,
                Limit {
                    limit: 3,
                    window: Duration::from_secs(86400),
                },
            )
            .await
            .expect("allowed email submission");
        }
        assert!(
            enforce_rate_limit(
                &db,
                &email_key,
                Limit {
                    limit: 3,
                    window: Duration::from_secs(86400)
                },
            )
            .await
            .is_err()
        );
    }

    #[sqlx::test(migrations = "../../migrations")]
    #[allow(clippy::expect_used)]
    async fn non_admin_request_list_is_hidden(db: sqlx::PgPool) {
        use axum::{body::Body, http::Request};
        use kernel::{
            email::LogSender,
            viewer::{Role, Viewer},
        };
        use std::sync::Arc;
        use tower::ServiceExt;

        let state = AppState {
            db,
            config: Arc::new(kernel::config::Config::from_env().expect("test config")),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let mut request = Request::get("/institute-requests")
            .body(Body::empty())
            .expect("request");
        request.extensions_mut().insert(Viewer {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            email: "candidate@example.edu".into(),
            display_name: "Candidate".into(),
            role: Role::User,
            via_cookie: false,
        });
        let response = router()
            .with_state(state)
            .oneshot(request)
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[sqlx::test(migrations = "../../migrations")]
    #[allow(clippy::expect_used)]
    async fn admin_status_change_is_audited(db: sqlx::PgPool) {
        use axum::{body::Body, http::Request};
        use kernel::{
            email::LogSender,
            viewer::{Role, Viewer},
        };
        use std::sync::Arc;
        use tower::ServiceExt;

        let admin_id: Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('cx7-admin@example.edu','admin') returning id",
        )
        .fetch_one(&db)
        .await
        .expect("insert admin");
        let request_id: Uuid = sqlx::query_scalar(
            "insert into institute_requests(institute,contact_name,email,message,ip_hash) values('Example College','Ada Example','ada@example.edu','We need help with exams.','hash') returning id",
        ).fetch_one(&db).await.expect("insert request");
        let state = AppState {
            db: db.clone(),
            config: Arc::new(kernel::config::Config::from_env().expect("test config")),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let mut request = Request::patch(format!("/institute-requests/{request_id}"))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"status":"contacted"}"#))
            .expect("patch request");
        request.extensions_mut().insert(Viewer {
            id: admin_id,
            session_id: Uuid::new_v4(),
            email: "cx7-admin@example.edu".into(),
            display_name: "Admin".into(),
            role: Role::Admin,
            via_cookie: false,
        });
        let response = router()
            .with_state(state)
            .oneshot(request)
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let action: String = sqlx::query_scalar(
            "select action from audit_log where target_type='institute_request' and target_id=$1",
        )
        .bind(request_id.to_string())
        .fetch_one(&db)
        .await
        .expect("audit event");
        assert_eq!(action, "institute_request.update");
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}
async fn list(
    State(s): State<AppState>,
    admin: Viewer,
    Query(q): Query<ListQuery>,
) -> examcore::ApiJson {
    if !admin.is_admin() {
        return Err(examcore::AppError::not_found());
    }
    if q.status
        .as_ref()
        .is_some_and(|v| !["new", "contacted", "onboarded", "declined"].contains(&v.as_str()))
    {
        return Err(examcore::invalid("status", "Unknown request status."));
    }
    let limit = q.limit.unwrap_or(50);
    let offset = q.offset.unwrap_or(0);
    if !(1..=100).contains(&limit) || !(0..=1_000_000).contains(&offset) {
        return Err(examcore::invalid("pagination", "Invalid pagination."));
    }
    let rows=sqlx::query("select id,institute,contact_name,email::text,phone,role,expected_candidates,message,status,created_at,handled_by,handled_at from institute_requests where ($1::text is null or status=$1) order by created_at desc,id limit $2 offset $3").bind(q.status).bind(limit).bind(offset).fetch_all(&s.db).await?;
    let mut values = Vec::with_capacity(rows.len());
    for r in &rows {
        values.push(json!({"id":r.try_get::<Uuid,_>("id")?,"institute":r.try_get::<String,_>("institute")?,"contactName":r.try_get::<String,_>("contact_name")?,"email":r.try_get::<String,_>("email")?,"phone":r.try_get::<Option<String>,_>("phone")?,"role":r.try_get::<Option<String>,_>("role")?,"expectedCandidates":r.try_get::<Option<i32>,_>("expected_candidates")?,"message":r.try_get::<String,_>("message")?,"status":r.try_get::<String,_>("status")?,"createdAt":r.try_get::<time::OffsetDateTime,_>("created_at")?.to_string(),"handledBy":r.try_get::<Option<Uuid>,_>("handled_by")?,"handledAt":r.try_get::<Option<time::OffsetDateTime>,_>("handled_at")?.map(|x|x.to_string())}));
    }
    Ok(examcore::ok(
        json!({"items":values,"limit":limit,"offset":offset}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateInput {
    status: String,
}
async fn update(
    State(s): State<AppState>,
    a: Viewer,
    Path(id): Path<Uuid>,
    meta: RequestMeta,
    Json(i): Json<UpdateInput>,
) -> examcore::ApiJson {
    if !a.is_admin() {
        return Err(examcore::AppError::not_found());
    }
    if !["new", "contacted", "onboarded", "declined"].contains(&i.status.as_str()) {
        return Err(examcore::invalid("status", "Unknown request status."));
    }
    let mut tx = s.db.begin().await?;
    let row=sqlx::query("update institute_requests set status=$2,handled_by=$3,handled_at=now() where id=$1 returning id,status").bind(id).bind(&i.status).bind(a.id).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Err(examcore::AppError::not_found());
    };
    tx.commit().await?;
    audit(
        &s.db,
        &meta,
        AuditEntry {
            action: "institute_request.update",
            actor_id: Some(a.id),
            target_type: Some("institute_request"),
            target_id: Some(id.to_string()),
            meta: json!({"status":i.status}),
        },
    )
    .await;
    Ok(examcore::ok(
        json!({"id":id,"status":row.try_get::<String,_>("status")?}),
    ))
}
