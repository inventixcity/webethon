//! Candidate enrollment and account invitation routes.
use axum::{
    Router,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use examcore::{ExaminerViewer, kernel};
use kernel::{
    AppError, AppResult, AppState, crypto,
    extract::{Json as JsonBody, Path},
    request::RequestMeta,
    security::{self, AuditEntry, limits},
    session,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateImportRow {
    pub email: String,
    pub display_name: String,
    pub extra_minutes: Option<i32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportInput {
    candidates: Vec<CandidateImportRow>,
    invite: bool,
    dry_run: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtraInput {
    extra_minutes: i32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptInput {
    token: String,
    password: String,
    display_name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    candidate_id: Uuid,
    email: String,
    display_name: String,
    status: String,
    extra_minutes: i32,
    invited: bool,
    activated: bool,
    attempt: Option<AttemptSummary>,
    created_at: time::OffsetDateTime,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    dry_run: bool,
    created: usize,
    updated: usize,
    errors: Vec<ImportRowError>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportRowError {
    row: usize,
    path: String,
    message: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttemptSummary {
    id: Uuid,
    status: String,
    total_score: Option<f64>,
}

fn valid_email(input: &str) -> Option<String> {
    let email = input.trim().to_ascii_lowercase();
    if email.len() > 254 || email.is_empty() || email.chars().any(char::is_whitespace) {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || domain.is_empty()
        || email.matches('@').count() != 1
    {
        return None;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if !local
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&b))
        || labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return None;
    }
    let tld = labels.last()?;
    if !((tld.len() >= 2 && tld.bytes().all(|byte| byte.is_ascii_alphabetic()))
        || tld.starts_with("xn--"))
    {
        return None;
    }
    Some(email)
}
fn field(row: usize, path: &str, message: &str) -> ImportRowError {
    ImportRowError {
        row,
        path: path.into(),
        message: message.into(),
    }
}
fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
async fn audit(db: &PgPool, meta: &RequestMeta, actor: Uuid, action: &'static str, target: Uuid) {
    security::audit(
        db,
        meta,
        AuditEntry {
            action,
            actor_id: Some(actor),
            target_type: Some("exam"),
            target_id: Some(target.to_string()),
            meta: json!({}),
        },
    )
    .await;
}

pub async fn enroll_tx(
    tx: &mut Transaction<'_, Postgres>,
    exam_id: Uuid,
    rows: &[CandidateImportRow],
    by: Uuid,
) -> AppResult<()> {
    for row in rows {
        let email = valid_email(&row.email)
            .ok_or_else(|| examcore::invalid("email", "Enter a valid email address."))?;
        let name = row.display_name.trim();
        if !(1..=120).contains(&name.chars().count()) {
            return Err(examcore::invalid("displayName", "Use 1 to 120 characters."));
        }
        let extra = row.extra_minutes.unwrap_or(0);
        if !(0..=600).contains(&extra) {
            return Err(examcore::invalid(
                "extraMinutes",
                "Choose a value from 0 to 600.",
            ));
        }
        let user: Option<(Uuid, String)> = sqlx::query_as(
            "select id,role from users where email=$1 and deleted_at is null for update",
        )
        .bind(&email)
        .fetch_optional(&mut **tx)
        .await?;
        let user = match user {
            Some(user) => user,
            None => {
                let inserted: Option<Uuid> = sqlx::query_scalar(
                    "insert into users(email,display_name,role,status) values($1,$2,'user','active') on conflict(email) do nothing returning id",
                )
                .bind(&email)
                .bind(name)
                .fetch_optional(&mut **tx)
                .await?;
                if let Some(id) = inserted {
                    (id, "user".to_owned())
                } else {
                    sqlx::query_as(
                        "select id,role from users where email=$1 and deleted_at is null for update",
                    )
                    .bind(&email)
                    .fetch_optional(&mut **tx)
                    .await?
                    .ok_or_else(|| {
                        examcore::invalid("email", "This email is already assigned to an account.")
                    })?
                }
            }
        };
        if user.1 != "user" {
            return Err(examcore::invalid(
                "email",
                "This email is not a candidate account.",
            ));
        }
        let id = user.0;
        sqlx::query("insert into enrollments(exam_id,candidate_id,extra_minutes,enrolled_by,status) values($1,$2,$3,$4,'enrolled') on conflict(exam_id,candidate_id) do update set extra_minutes=excluded.extra_minutes,enrolled_by=excluded.enrolled_by,status='enrolled',updated_at=now()").bind(exam_id).bind(id).bind(extra).bind(by).execute(&mut **tx).await?;
    }
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ExaminerViewer(v): ExaminerViewer,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&state.db, &v, id).await?;
    let rows:Vec<Enrollment>=sqlx::query_as::<_,EnrollRow>("select e.candidate_id,u.email::text,u.display_name,e.status,e.extra_minutes,exists(select 1 from account_invites i where i.user_id=u.id) invited,u.password_hash is not null activated,(select jsonb_build_object('id',a.id,'status',a.status,'totalScore',a.total_score::float8) from attempts a where a.exam_id=e.exam_id and a.candidate_id=e.candidate_id and not a.sandbox order by a.started_at desc limit 1) attempt,e.created_at from enrollments e join users u on u.id=e.candidate_id where e.exam_id=$1 order by u.email").bind(id).fetch_all(&state.db).await?.into_iter().map(Into::into).collect();
    Ok(examcore::ok(rows))
}
#[derive(sqlx::FromRow)]
struct EnrollRow {
    candidate_id: Uuid,
    email: String,
    display_name: String,
    status: String,
    extra_minutes: i32,
    invited: bool,
    activated: bool,
    attempt: Option<Value>,
    created_at: time::OffsetDateTime,
}
impl From<EnrollRow> for Enrollment {
    fn from(r: EnrollRow) -> Self {
        Self {
            candidate_id: r.candidate_id,
            email: r.email,
            display_name: r.display_name,
            status: r.status,
            extra_minutes: r.extra_minutes,
            invited: r.invited,
            activated: r.activated,
            attempt: r
                .attempt
                .and_then(|value| serde_json::from_value(value).ok()),
            created_at: r.created_at,
        }
    }
}

async fn import(
    State(state): State<AppState>,
    meta: RequestMeta,
    Path(id): Path<Uuid>,
    ExaminerViewer(v): ExaminerViewer,
    JsonBody(input): JsonBody<ImportInput>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&state.db, &v, id).await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("enroll:{}", v.id),
        security::Limit {
            limit: 30,
            window: std::time::Duration::from_secs(3600),
        },
    )
    .await?;
    if input.candidates.len() > 1000 {
        return Err(examcore::invalid(
            "candidates",
            "Import at most 1000 candidates.",
        ));
    }
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    for (i, r) in input.candidates.iter().enumerate() {
        let row = i + 1;
        let email = valid_email(&r.email);
        if email.as_ref().is_none_or(|e| !seen.insert(e.clone())) {
            errors.push(field(row, "email", "Enter a valid, unique email."));
        }
        if !(1..=120).contains(&r.display_name.trim().chars().count()) {
            errors.push(field(row, "displayName", "Use 1 to 120 characters."));
        }
        if r.extra_minutes.is_some_and(|n| !(0..=600).contains(&n)) {
            errors.push(field(row, "extraMinutes", "Choose a value from 0 to 600."));
        }
        if let Some(email) = email {
            let role: Option<String> =
                sqlx::query_scalar("select role from users where email=$1 and deleted_at is null")
                    .bind(email)
                    .fetch_optional(&state.db)
                    .await?;
            if role.is_some_and(|r| r != "user") {
                errors.push(field(
                    row,
                    "email",
                    "This email is not a candidate account.",
                ));
            }
        }
    }
    if input.dry_run || !errors.is_empty() {
        return Ok(examcore::ok(
            json!({"dryRun":input.dry_run,"created":0,"updated":0,"errors":errors,"inviteLinks":[]}),
        ));
    }
    let mut tx = state.db.begin().await?;
    let exam = examcore::load_exam_for_examiner(&state.db, &v, id).await?;
    let mut created = 0;
    let mut updated = 0;
    for row in &input.candidates {
        if let Some(email) = valid_email(&row.email) {
            let existing:bool=sqlx::query_scalar("select exists(select 1 from enrollments e join users u on u.id=e.candidate_id where e.exam_id=$1 and u.email=$2)").bind(id).bind(email).fetch_one(&mut *tx).await?;
            if existing {
                updated += 1;
            } else {
                created += 1;
            }
        }
    }
    enroll_tx(&mut tx, id, &input.candidates, v.id).await?;
    let mut links = Vec::new();
    let mut outgoing = Vec::new();
    if input.invite {
        for r in &input.candidates {
            let email = valid_email(&r.email).unwrap_or_default();
            let (uid, active): (Uuid, bool) =
                sqlx::query_as("select id,password_hash is not null from users where email=$1")
                    .bind(&email)
                    .fetch_one(&mut *tx)
                    .await?;
            if !active {
                let (token, hash) = crypto::new_token();
                sqlx::query(
                    "update account_invites set used_at=now() where user_id=$1 and used_at is null",
                )
                .bind(uid)
                .execute(&mut *tx)
                .await?;
                sqlx::query("insert into account_invites(token_hash,user_id,invited_by,expires_at) values($1,$2,$3,now()+interval '7 days')").bind(hash.as_slice()).bind(uid).bind(v.id).execute(&mut *tx).await?;
                let url = format!("{}/invite/{}", state.config.app_origin, token);
                links.push(json!({"email":email,"url":url}));
                outgoing.push((email, url, exam.title.clone(), exam.starts_at, exam.ends_at));
            }
        }
    }
    tx.commit().await?;
    audit(&state.db, &meta, v.id, "exam.enrollments_imported", id).await;
    for (email, url, title, start, end) in outgoing {
        let e = kernel::email::Email {
            to: email,
            subject: format!("Your invitation to {title}"),
            html: format!(
                "<p>You are invited to <strong>{}</strong>.</p><p>Schedule: {} to {}.</p><p><a href=\"{}\">Set your password</a></p><p>Inventix Invigil</p>",
                html(&title),
                html(&start.to_string()),
                html(&end.to_string()),
                html(&url)
            ),
            text: format!(
                "You are invited to {title}. Schedule: {start} to {end}. Set your password: {url}\n\nInventix Invigil"
            ),
        };
        if let Err(error) = state.email.send(&e).await {
            tracing::warn!(error=%error,"invite email failed");
        }
    }
    Ok(examcore::ok(
        json!({"dryRun":false,"created":created,"updated":updated,"errors":[],"inviteLinks":links}),
    ))
}

async fn invite_one(
    State(state): State<AppState>,
    meta: RequestMeta,
    Path((id, cid)): Path<(Uuid, Uuid)>,
    ExaminerViewer(v): ExaminerViewer,
) -> examcore::ApiJson {
    let exam = examcore::load_exam_for_examiner(&state.db, &v, id).await?;
    security::enforce_rate_limit(
        &state.db,
        &format!("invite:{cid}"),
        security::Limit {
            limit: 10,
            window: std::time::Duration::from_secs(3600),
        },
    )
    .await?;
    let mut tx = state.db.begin().await?;
    let row:Option<(String,String,bool)>=sqlx::query_as("select u.email::text,u.display_name,u.password_hash is not null from enrollments e join users u on u.id=e.candidate_id where e.exam_id=$1 and e.candidate_id=$2 and e.status='enrolled'").bind(id).bind(cid).fetch_optional(&mut *tx).await?;
    let (email, name, active) = row.ok_or_else(AppError::not_found)?;
    if active {
        return Err(examcore::invalid(
            "candidateId",
            "This candidate has already activated their account.",
        ));
    }
    let (token, hash) = crypto::new_token();
    sqlx::query("update account_invites set used_at=now() where user_id=$1 and used_at is null")
        .bind(cid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("insert into account_invites(token_hash,user_id,invited_by,expires_at) values($1,$2,$3,now()+interval '7 days')").bind(hash.as_slice()).bind(cid).bind(v.id).execute(&mut *tx).await?;
    tx.commit().await?;
    audit(&state.db, &meta, v.id, "exam.candidate_invited", id).await;
    let url = format!("{}/invite/{token}", state.config.app_origin);
    let e = kernel::email::Email {
        to: email.clone(),
        subject: format!("Your invitation to {}", exam.title),
        html: format!(
            "<p>You are invited to <strong>{}</strong>.</p><p>Schedule: {} to {}.</p><p><a href=\"{}\">Set your password</a></p><p>Inventix Invigil</p>",
            html(&exam.title),
            html(&exam.starts_at.to_string()),
            html(&exam.ends_at.to_string()),
            html(&url)
        ),
        text: format!(
            "You are invited to {}. Schedule: {} to {}. Set your password: {url}\n\nInventix Invigil",
            exam.title, exam.starts_at, exam.ends_at
        ),
    };
    if let Err(err) = state.email.send(&e).await {
        tracing::warn!(error=%err,"invite email failed");
    }
    let _ = name;
    Ok(examcore::ok(
        json!({"sent":true,"inviteLink":{"email":email,"url":url}}),
    ))
}
async fn patch(
    State(state): State<AppState>,
    meta: RequestMeta,
    Path((id, cid)): Path<(Uuid, Uuid)>,
    ExaminerViewer(v): ExaminerViewer,
    JsonBody(input): JsonBody<ExtraInput>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&state.db, &v, id).await?;
    if !(0..=600).contains(&input.extra_minutes) {
        return Err(examcore::invalid(
            "extraMinutes",
            "Choose a value from 0 to 600.",
        ));
    }
    let row=sqlx::query("update enrollments set extra_minutes=$3,updated_at=now() where exam_id=$1 and candidate_id=$2 returning exam_id").bind(id).bind(cid).bind(input.extra_minutes).fetch_optional(&state.db).await?;
    if row.is_none() {
        return Err(AppError::not_found());
    }
    audit(&state.db, &meta, v.id, "exam.enrollment_accommodation", id).await;
    let enrollment:Option<Enrollment>=sqlx::query_as::<_,EnrollRow>("select e.candidate_id,u.email::text,u.display_name,e.status,e.extra_minutes,exists(select 1 from account_invites i where i.user_id=u.id) invited,u.password_hash is not null activated,(select jsonb_build_object('id',a.id,'status',a.status,'totalScore',a.total_score::float8) from attempts a where a.exam_id=e.exam_id and a.candidate_id=e.candidate_id and not a.sandbox order by a.started_at desc limit 1) attempt,e.created_at from enrollments e join users u on u.id=e.candidate_id where e.exam_id=$1 and e.candidate_id=$2").bind(id).bind(cid).fetch_optional(&state.db).await?.map(Into::into);
    let enrollment = enrollment.ok_or_else(AppError::not_found)?;
    Ok(examcore::ok(enrollment))
}
async fn revoke(
    State(state): State<AppState>,
    meta: RequestMeta,
    Path((id, cid)): Path<(Uuid, Uuid)>,
    ExaminerViewer(v): ExaminerViewer,
) -> AppResult<StatusCode> {
    examcore::load_exam_for_examiner(&state.db, &v, id).await?;
    let r=sqlx::query("update enrollments set status='revoked',updated_at=now() where exam_id=$1 and candidate_id=$2").bind(id).bind(cid).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::not_found());
    }
    audit(&state.db, &meta, v.id, "exam.enrollment_revoked", id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn lookup_invite(
    State(state): State<AppState>,
    meta: RequestMeta,
    Path(token): Path<String>,
) -> examcore::ApiJson {
    security::enforce_rate_limit(
        &state.db,
        &format!("invite-lookup:{}", meta.ip),
        limits::CODE_PER_IP,
    )
    .await?;
    let hash = crypto::hash_token(&token).ok_or_else(AppError::not_found)?;
    let row:Option<(String,String)>=sqlx::query_as("select u.email::text,u.display_name from account_invites i join users u on u.id=i.user_id where i.token_hash=$1 and i.used_at is null and i.expires_at>now() and u.deleted_at is null").bind(hash.as_slice()).fetch_optional(&state.db).await?;
    let (email, display) = row.ok_or_else(AppError::not_found)?;
    Ok(examcore::ok(json!({"email":email,"displayName":display})))
}
async fn accept(
    State(state): State<AppState>,
    meta: RequestMeta,
    JsonBody(input): JsonBody<AcceptInput>,
) -> AppResult<Response> {
    security::enforce_rate_limit(
        &state.db,
        &format!("invite-accept:{}", meta.ip),
        limits::CODE_PER_IP,
    )
    .await?;
    let hash = crypto::hash_token(&input.token).ok_or_else(AppError::not_found)?;
    let email:Option<String>=sqlx::query_scalar("select u.email::text from account_invites i join users u on u.id=i.user_id where i.token_hash=$1 and i.used_at is null and i.expires_at>now()").bind(hash.as_slice()).fetch_optional(&state.db).await?;
    let email = email.ok_or_else(AppError::not_found)?;
    auth::password::policy(&state, &email, &input.password).await?;
    if !(1..=120).contains(&input.display_name.trim().chars().count()) {
        return Err(examcore::invalid("displayName", "Use 1 to 120 characters."));
    }
    let password = auth::password::hash(&state, input.password).await?;
    let mut tx = state.db.begin().await?;
    let uid:Option<Uuid>=sqlx::query_scalar("update account_invites set used_at=now() where token_hash=$1 and used_at is null and expires_at>now() returning user_id").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let uid = uid.ok_or_else(AppError::not_found)?;
    let updated=sqlx::query("update users set password_hash=$1,email_verified_at=now(),display_name=$2 where id=$3 and role='user' and password_hash is null").bind(password).bind(input.display_name.trim()).bind(uid).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::not_found());
    }
    let (token, token_hash) = crypto::new_token();
    let expires = time::OffsetDateTime::now_utc()
        + time::Duration::try_from(state.config.session_ttl).map_err(AppError::internal)?;
    sqlx::query(
        "insert into sessions(user_id,token_hash,expires_at,ip,user_agent) values($1,$2,$3,$4,$5)",
    )
    .bind(uid)
    .bind(token_hash.as_slice())
    .bind(expires)
    .bind(&meta.ip)
    .bind(&meta.user_agent)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    security::audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "auth.invite_accepted",
            actor_id: Some(uid),
            target_type: Some("user"),
            target_id: Some(uid.to_string()),
            meta: json!({}),
        },
    )
    .await;
    Ok((
        [(
            header::SET_COOKIE,
            session::cookie(&state.config, &token, state.config.session_ttl),
        )],
        examcore::ok(json!({
            "user": {
                "id": uid,
                "email": email,
                "displayName": input.display_name.trim(),
                "role": "candidate",
                "mfaEnabled": false
            }
        })),
    )
        .into_response())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/exams/{id}/enrollments", get(list).post(import))
        .route(
            "/exams/{id}/enrollments/{candidateId}",
            axum::routing::patch(patch).delete(revoke),
        )
        .route(
            "/exams/{id}/enrollments/{candidateId}/invite",
            post(invite_one),
        )
        .route("/invites/{token}", get(lookup_invite))
        .route("/invites/accept", post(accept))
        .route("/auth/invites/{token}", get(lookup_invite))
        .route("/auth/invites/accept", post(accept))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, extract::State, http::header};
    use kernel::{
        config::Config,
        email::LogSender,
        viewer::{Role, Viewer},
    };
    use std::sync::Arc;

    fn state(db: PgPool) -> AppState {
        let mut config = Config::from_env().expect("test config");
        config.breach_check = false;
        AppState {
            db,
            config: Arc::new(config),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }

    fn viewer(id: Uuid, email: &str) -> ExaminerViewer {
        ExaminerViewer(Viewer {
            id,
            session_id: Uuid::new_v4(),
            email: email.into(),
            display_name: "Examiner".into(),
            role: Role::Examiner,
            via_cookie: false,
        })
    }

    fn meta() -> RequestMeta {
        RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: "test".into(),
            request_id: "test-request".into(),
        }
    }

    #[test]
    fn email_normalization_and_shape_validation() {
        assert_eq!(
            valid_email("  Person+exam@Example.org ").as_deref(),
            Some("person+exam@example.org")
        );
        for bad in [
            "",
            "plain",
            "a@@example.org",
            "a..b@example.org",
            "a@-example.org",
            "a@localhost",
            "a b@example.org",
        ] {
            assert!(valid_email(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn html_email_values_are_escaped() {
        assert_eq!(html("<x a=\"b\">&'"), "&lt;x a=&quot;b&quot;&gt;&amp;&#39;");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn examiner_email_is_refused_and_import_transaction_can_roll_back(db: PgPool) {
        let examiner: Uuid = sqlx::query_scalar("insert into users(email,display_name,role) values('owner@example.org','Owner','examiner') returning id")
            .fetch_one(&db).await.expect("examiner fixture");
        let exam: Uuid = sqlx::query_scalar("insert into exams(owner_id,title,starts_at,ends_at,duration_minutes,total_marks) values($1,'Test exam',now(),now()+interval '1 hour',60,10) returning id")
            .bind(examiner).fetch_one(&db).await.expect("exam fixture");
        let rows = vec![
            CandidateImportRow {
                email: "candidate@example.org".into(),
                display_name: "Candidate".into(),
                extra_minutes: None,
            },
            CandidateImportRow {
                email: "owner@example.org".into(),
                display_name: "Owner".into(),
                extra_minutes: None,
            },
        ];
        let mut tx = db.begin().await.expect("transaction");
        assert!(enroll_tx(&mut tx, exam, &rows, examiner).await.is_err());
        tx.rollback().await.expect("rollback");
        let count: i64 =
            sqlx::query_scalar("select count(*) from users where email='candidate@example.org'")
                .fetch_one(&db)
                .await
                .expect("candidate count");
        assert_eq!(count, 0);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn dry_run_writes_nothing_and_foreign_exam_is_hidden(db: PgPool) {
        let owner:Uuid=sqlx::query_scalar("insert into users(email,display_name,role) values('owner2@example.org','Owner','examiner') returning id").fetch_one(&db).await.expect("owner");
        let other:Uuid=sqlx::query_scalar("insert into users(email,display_name,role) values('other@example.org','Other','examiner') returning id").fetch_one(&db).await.expect("other");
        let exam:Uuid=sqlx::query_scalar("insert into exams(owner_id,title,starts_at,ends_at,duration_minutes,total_marks) values($1,'Dry run',now(),now()+interval '1 hour',60,10) returning id").bind(owner).fetch_one(&db).await.expect("exam");
        let row = CandidateImportRow {
            email: "preview@example.org".into(),
            display_name: "Preview".into(),
            extra_minutes: None,
        };
        let result = import(
            State(state(db.clone())),
            meta(),
            Path(exam),
            viewer(owner, "owner2@example.org"),
            JsonBody(ImportInput {
                candidates: vec![row],
                invite: false,
                dry_run: true,
            }),
        )
        .await;
        let result = result.expect("dry run response");
        assert_eq!(result.0["data"]["dryRun"], true);
        assert_eq!(result.0["data"]["errors"], json!([]));
        let count: i64 =
            sqlx::query_scalar("select count(*) from users where email='preview@example.org'")
                .fetch_one(&db)
                .await
                .expect("candidate count");
        assert_eq!(count, 0);
        let denied =
            examcore::load_exam_for_examiner(&db, &viewer(other, "other@example.org").0, exam)
                .await
                .expect_err("foreign examiner must not see the exam");
        assert_eq!(denied.into_response().status(), StatusCode::NOT_FOUND);

        let bad_import = import(
            State(state(db.clone())),
            meta(),
            Path(exam),
            viewer(owner, "owner2@example.org"),
            JsonBody(ImportInput {
                candidates: vec![
                    CandidateImportRow {
                        email: "valid@example.org".into(),
                        display_name: "Valid".into(),
                        extra_minutes: None,
                    },
                    CandidateImportRow {
                        email: "VALID@example.org".into(),
                        display_name: "Duplicate".into(),
                        extra_minutes: None,
                    },
                    CandidateImportRow {
                        email: "owner2@example.org".into(),
                        display_name: "Owner".into(),
                        extra_minutes: None,
                    },
                ],
                invite: false,
                dry_run: false,
            }),
        )
        .await
        .expect("row errors are returned as import results");
        assert_eq!(bad_import.0["data"]["errors"][0]["row"], 2);
        assert_eq!(bad_import.0["data"]["errors"][1]["row"], 3);
        let valid_count: i64 =
            sqlx::query_scalar("select count(*) from users where email='valid@example.org'")
                .fetch_one(&db)
                .await
                .expect("valid row count");
        assert_eq!(valid_count, 0);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn invite_expires_is_single_use_and_acceptance_sets_cookie(db: PgPool) {
        let state = state(db.clone());
        let uid:Uuid=sqlx::query_scalar("insert into users(email,display_name,role) values('invitee@example.org','Invitee','user') returning id").fetch_one(&db).await.expect("user");
        let (token, hash) = crypto::new_token();
        sqlx::query("insert into account_invites(token_hash,user_id,expires_at) values($1,$2,now()+interval '7 days')").bind(hash.as_slice()).bind(uid).execute(&db).await.expect("invite");
        let response = accept(
            State(state.clone()),
            meta(),
            JsonBody(AcceptInput {
                token: token.clone(),
                password: "A-strong-password-9!".into(),
                display_name: "New Name".into(),
            }),
        )
        .await
        .expect("accept");
        assert!(response.headers().contains_key(header::SET_COOKIE));
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("accept response body");
        let body: Value = serde_json::from_slice(&body).expect("accept response JSON");
        assert!(body["data"]["token"].is_null());
        assert_eq!(body["data"]["user"]["email"], "invitee@example.org");
        assert!(
            accept(
                State(state.clone()),
                meta(),
                JsonBody(AcceptInput {
                    token,
                    password: "A-strong-password-9!".into(),
                    display_name: "New Name".into()
                })
            )
            .await
            .is_err()
        );
        let expired_user:Uuid=sqlx::query_scalar("insert into users(email,display_name,role) values('expired@example.org','Expired','user') returning id").fetch_one(&db).await.expect("expired user");
        let (expired, expired_hash) = crypto::new_token();
        sqlx::query("insert into account_invites(token_hash,user_id,expires_at) values($1,$2,now()-interval '1 second')").bind(expired_hash.as_slice()).bind(expired_user).execute(&db).await.expect("expired invite");
        assert!(
            lookup_invite(State(state), meta(), Path(expired))
                .await
                .is_err()
        );
    }
}
