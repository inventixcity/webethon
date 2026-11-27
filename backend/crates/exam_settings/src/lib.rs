use axum::{Router, extract::State, routing::get};
use examcore::{AppResult, AppState, Viewer};
use kernel::extract::Json as JsonBody;
use kernel::{
    request::RequestMeta,
    security::{AuditEntry, audit_tx},
};
use serde_json::{Value, json};
use sqlx::Row;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/me/preferences",
            get(get_preferences).patch(patch_preferences),
        )
        .route("/institution", get(get_institution))
        .route(
            "/admin-institution",
            get(get_admin_institution).patch(patch_admin_institution),
        )
}

pub async fn ai_suggestions_enabled(db: &sqlx::PgPool) -> bool {
    sqlx::query_scalar("select ai_suggestions_enabled from institution_settings where id=1")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

pub async fn institution_name(db: &sqlx::PgPool) -> String {
    sqlx::query_scalar("select name from institution_settings where id=1")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "Inventix Invigil".to_owned())
}

fn defaults(role: &str) -> Value {
    let mut prefs = json!({"theme":"system","reducedMotion":false,"textSize":"md","timeZone":"Asia/Karachi","emailNotifications":{"securityAlerts":true,"productUpdates":true}});
    match role {
        "candidate" => {
            prefs["candidate"] = json!({"accessibility":{"highContrast":false,"dyslexiaFont":false,"largerTargets":false,"confirmBeforeSubmit":true},"examReminders":{"emailBeforeStartMinutes":15}})
        }
        "examiner" => {
            prefs["examiner"] = json!({"examDefaults":{"durationMinutes":60,"passPercent":50,"shuffleQuestions":false,"shuffleOptions":false,"lateJoinMinutes":0,"integrity":{"fullscreen":false,"pasteBlock":true,"focusTracking":true,"typingTelemetry":false}},"notifications":{"onSubmissionsComplete":true,"onDisputeFiled":true,"onOutageReported":true}})
        }
        "admin" => {
            prefs["admin"] =
                json!({"notifications":{"onInstituteRequest":true,"onSecurityEvent":true}})
        }
        _ => {}
    }
    prefs
}

fn validate(role: &str, v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let shared = [
        "theme",
        "reducedMotion",
        "textSize",
        "timeZone",
        "emailNotifications",
    ];
    if o.keys().any(|k| !shared.contains(&k.as_str()) && k != role) {
        return false;
    }
    let theme = v["theme"].as_str().unwrap_or("");
    if !["system", "light", "dark"].contains(&theme)
        || !v["reducedMotion"].is_boolean()
        || !["sm", "md", "lg"].contains(&v["textSize"].as_str().unwrap_or(""))
        || !v["timeZone"]
            .as_str()
            .is_some_and(|z| z.parse::<chrono_tz::Tz>().is_ok())
    {
        return false;
    }
    let e = &v["emailNotifications"];
    if !keys_are(e, &["securityAlerts", "productUpdates"])
        || e["securityAlerts"] != true
        || !e["productUpdates"].is_boolean()
    {
        return false;
    }
    match role {
        "candidate" => {
            let c = &v["candidate"];
            keys_are(c, &["accessibility", "examReminders"])
                && keys_are(
                    &c["accessibility"],
                    &[
                        "highContrast",
                        "dyslexiaFont",
                        "largerTargets",
                        "confirmBeforeSubmit",
                    ],
                )
                && keys_are(&c["examReminders"], &["emailBeforeStartMinutes"])
                && [
                    "highContrast",
                    "dyslexiaFont",
                    "largerTargets",
                    "confirmBeforeSubmit",
                ]
                .iter()
                .all(|k| c["accessibility"][k].is_boolean())
                && [0, 15, 60, 1440].contains(
                    &c["examReminders"]["emailBeforeStartMinutes"]
                        .as_i64()
                        .unwrap_or(-1),
                )
        }
        "examiner" => {
            let x = &v["examiner"];
            keys_are(x, &["examDefaults", "notifications"])
                && keys_are(
                    &x["examDefaults"],
                    &[
                        "durationMinutes",
                        "passPercent",
                        "shuffleQuestions",
                        "shuffleOptions",
                        "lateJoinMinutes",
                        "integrity",
                    ],
                )
                && keys_are(
                    &x["examDefaults"]["integrity"],
                    &[
                        "fullscreen",
                        "pasteBlock",
                        "focusTracking",
                        "typingTelemetry",
                    ],
                )
                && keys_are(
                    &x["notifications"],
                    &[
                        "onSubmissionsComplete",
                        "onDisputeFiled",
                        "onOutageReported",
                    ],
                )
                && (5..=600).contains(&x["examDefaults"]["durationMinutes"].as_i64().unwrap_or(0))
                && (0..=100).contains(&x["examDefaults"]["passPercent"].as_i64().unwrap_or(-1))
                && (0..=120).contains(&x["examDefaults"]["lateJoinMinutes"].as_i64().unwrap_or(-1))
                && ["shuffleQuestions", "shuffleOptions"]
                    .iter()
                    .all(|k| x["examDefaults"][k].is_boolean())
                && [
                    "fullscreen",
                    "pasteBlock",
                    "focusTracking",
                    "typingTelemetry",
                ]
                .iter()
                .all(|k| x["examDefaults"]["integrity"][k].is_boolean())
                && [
                    "onSubmissionsComplete",
                    "onDisputeFiled",
                    "onOutageReported",
                ]
                .iter()
                .all(|k| x["notifications"][k].is_boolean())
        }
        "admin" => {
            keys_are(&v["admin"], &["notifications"])
                && keys_are(
                    &v["admin"]["notifications"],
                    &["onInstituteRequest", "onSecurityEvent"],
                )
                && ["onInstituteRequest", "onSecurityEvent"]
                    .iter()
                    .all(|k| v["admin"]["notifications"][k].is_boolean())
        }
        _ => false,
    }
}

fn keys_are(value: &Value, allowed: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == allowed.len() && object.keys().all(|key| allowed.contains(&key.as_str()))
    })
}

async fn get_preferences(State(s): State<AppState>, v: Viewer) -> AppResult<axum::Json<Value>> {
    let role = v.role.as_str();
    let stored: Option<Value> =
        sqlx::query_scalar("select prefs from user_preferences where user_id=$1")
            .bind(v.id)
            .fetch_optional(&s.db)
            .await?;
    let prefs = stored.unwrap_or_else(|| defaults(role));
    let can_delete: bool = sqlx::query_scalar(
        "select allow_candidate_self_delete from institution_settings where id=1",
    )
    .fetch_optional(&s.db)
    .await?
    .unwrap_or(false);
    Ok(examcore::ok(
        json!({"role":role,"prefs":prefs,"candidateSelfDeleteAllowed":can_delete}),
    ))
}

async fn patch_preferences(
    State(s): State<AppState>,
    v: Viewer,
    JsonBody(input): JsonBody<Value>,
) -> AppResult<axum::Json<Value>> {
    let role = v.role.as_str();
    let mut tx = s.db.begin().await?;
    sqlx::query("select id from users where id=$1 for update")
        .bind(v.id)
        .fetch_one(&mut *tx)
        .await?;
    let mut merged = defaults(role);
    let existing: Option<Value> =
        sqlx::query_scalar("select prefs from user_preferences where user_id=$1 for update")
            .bind(v.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(old) = existing {
        merge(&mut merged, old);
    }
    if !input.is_object() {
        return Err(examcore::invalid("prefs", "Preferences must be an object."));
    }
    merge(&mut merged, input);
    merged["emailNotifications"]["securityAlerts"] = json!(true);
    if !validate(role, &merged) {
        return Err(examcore::invalid(
            "prefs",
            "One or more preferences are invalid for this role.",
        ));
    }
    sqlx::query("insert into user_preferences(user_id,prefs,updated_at) values($1,$2,now()) on conflict(user_id) do update set prefs=excluded.prefs,updated_at=now()").bind(v.id).bind(&merged).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(examcore::ok(json!({"role":role,"prefs":merged})))
}

fn merge(dst: &mut Value, src: Value) {
    if let (Some(d), Some(s)) = (dst.as_object_mut(), src.as_object()) {
        for (k, v) in s {
            if v.is_object() && d.get(k).is_some_and(Value::is_object) {
                merge(&mut d[k], v.clone());
            } else {
                d.insert(k.clone(), v.clone());
            }
        }
    }
}

async fn get_institution(State(s): State<AppState>) -> AppResult<axum::Json<Value>> {
    let row = sqlx::query(
        "select name,short_name,contact_email,support_hours from institution_settings where id=1",
    )
    .fetch_one(&s.db)
    .await?;
    Ok(examcore::ok(
        json!({"name":row.try_get::<String,_>("name")?,"shortName":row.try_get::<String,_>("short_name")?,"contactEmail":row.try_get::<String,_>("contact_email")?,"supportHours":row.try_get::<String,_>("support_hours")?}),
    ))
}

async fn get_admin_institution(
    State(s): State<AppState>,
    v: Viewer,
) -> AppResult<axum::Json<Value>> {
    if !v.is_admin() {
        return Err(examcore::AppError::not_found());
    }
    let row=sqlx::query("select name,short_name,contact_email,support_hours,default_time_zone,ai_suggestions_enabled,allow_candidate_self_delete,staff_mfa_required,results_verification_public from institution_settings where id=1").fetch_one(&s.db).await?;
    Ok(examcore::ok(
        json!({"name":row.try_get::<String,_>("name")?,"shortName":row.try_get::<String,_>("short_name")?,"contactEmail":row.try_get::<String,_>("contact_email")?,"supportHours":row.try_get::<String,_>("support_hours")?,"defaultTimeZone":row.try_get::<String,_>("default_time_zone")?,"aiSuggestionsEnabled":row.try_get::<bool,_>("ai_suggestions_enabled")?,"allowCandidateSelfDelete":row.try_get::<bool,_>("allow_candidate_self_delete")?,"staffMfaRequired":row.try_get::<bool,_>("staff_mfa_required")?,"resultsVerificationPublic":row.try_get::<bool,_>("results_verification_public")?}),
    ))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstitutionPatch {
    name: String,
    short_name: String,
    contact_email: String,
    support_hours: String,
    default_time_zone: String,
    ai_suggestions_enabled: bool,
    allow_candidate_self_delete: bool,
    staff_mfa_required: bool,
    results_verification_public: bool,
}
async fn patch_admin_institution(
    State(s): State<AppState>,
    v: Viewer,
    meta: RequestMeta,
    JsonBody(i): JsonBody<InstitutionPatch>,
) -> AppResult<axum::Json<Value>> {
    if !v.is_admin() {
        return Err(examcore::AppError::not_found());
    }
    if !(2..=120).contains(&i.name.trim().chars().count())
        || i.short_name.len() > 40
        || i.contact_email.len() > 254
        || !i.contact_email.contains('@')
        || i.support_hours.len() > 240
        || i.default_time_zone.parse::<chrono_tz::Tz>().is_err()
    {
        return Err(examcore::invalid(
            "institution",
            "Please check the institution details.",
        ));
    }
    let mut tx = s.db.begin().await?;
    admin::require_step_up(&mut tx, &s, &v).await?;
    let before: Value = sqlx::query_scalar(
        "select to_jsonb(i)-'id' from institution_settings i where id=1 for update",
    )
    .fetch_one(&mut *tx)
    .await?;
    let after = json!({"name":i.name,"short_name":i.short_name,"contact_email":i.contact_email,"support_hours":i.support_hours,"default_time_zone":i.default_time_zone,"ai_suggestions_enabled":i.ai_suggestions_enabled,"allow_candidate_self_delete":i.allow_candidate_self_delete,"staff_mfa_required":i.staff_mfa_required,"results_verification_public":i.results_verification_public});
    sqlx::query("update institution_settings set name=$1,short_name=$2,contact_email=$3,support_hours=$4,default_time_zone=$5,ai_suggestions_enabled=$6,allow_candidate_self_delete=$7,staff_mfa_required=$8,results_verification_public=$9,updated_at=now() where id=1").bind(&i.name).bind(&i.short_name).bind(&i.contact_email).bind(&i.support_hours).bind(&i.default_time_zone).bind(i.ai_suggestions_enabled).bind(i.allow_candidate_self_delete).bind(i.staff_mfa_required).bind(i.results_verification_public).execute(&mut *tx).await?;
    audit_tx(
        &mut tx,
        &meta,
        AuditEntry {
            action: "institution.settings.update",
            actor_id: Some(v.id),
            target_type: Some("institution"),
            target_id: Some("1".into()),
            meta: json!({"before":before,"after":after}),
        },
    )
    .await?;
    tx.commit().await?;
    get_admin_institution(State(s), v).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    #[test]
    fn role_validation_rejects_cross_role_fields_and_bad_values() {
        let c = defaults("candidate");
        assert!(validate("candidate", &c));
        let mut x = defaults("examiner");
        x["candidate"] = json!({});
        assert!(!validate("examiner", &x));
        let mut x = defaults("candidate");
        x["candidate"]["examReminders"]["emailBeforeStartMinutes"] = json!(16);
        assert!(!validate("candidate", &x));
        let mut x = defaults("admin");
        x["admin"]["notifications"]["onSecurityEvent"] = json!("yes");
        assert!(!validate("admin", &x));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn role_access_step_up_and_audit_are_enforced(
        db: sqlx::PgPool,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use std::sync::Arc;
        let candidate = make_user(&db, "user").await?;
        let admin_user = make_user(&db, "admin").await?;
        let state = AppState {
            db: db.clone(),
            config: Arc::new(kernel::config::Config::from_env()?),
            http: Default::default(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let app = router().with_state(state);
        let (status, _) = request(&app, &candidate.0, "GET", "/admin-institution", None).await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = request(
            &app,
            &candidate.0,
            "PATCH",
            "/me/preferences",
            Some(json!({"examiner":{"examDefaults":{}}})),
        )
        .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let update = json!({"name":"Inventix Invigil","shortName":"Invigil","contactEmail":"support@example.test","supportHours":"Weekdays","defaultTimeZone":"Asia/Karachi","aiSuggestionsEnabled":true,"allowCandidateSelfDelete":false,"staffMfaRequired":false,"resultsVerificationPublic":true});
        let (status, _) = request(
            &app,
            &admin_user.0,
            "PATCH",
            "/admin-institution",
            Some(update.clone()),
        )
        .await?;
        assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
        sqlx::query("insert into admin_step_up(session_id,expires_at,password_hash_snapshot) values($1,now()+interval '10 minutes',digest('','sha256'))").bind(admin_user.1).execute(&db).await?;
        let (status, _) = request(
            &app,
            &admin_user.0,
            "PATCH",
            "/admin-institution",
            Some(update),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let (action, meta): (String, Value) = sqlx::query_as("select action,meta from audit_log where actor_id=$1 and action='institution.settings.update' order by id desc limit 1").bind(admin_user.2).fetch_one(&db).await?;
        assert_eq!(action, "institution.settings.update");
        assert!(meta.get("before").is_some() && meta.get("after").is_some());
        let (status, _) = request(&app, &admin_user.0, "GET", "/institution", None).await?;
        assert_eq!(status, StatusCode::OK);
        Ok(())
    }

    struct TestUser(String, uuid::Uuid, uuid::Uuid);
    async fn make_user(
        db: &sqlx::PgPool,
        role: &str,
    ) -> Result<TestUser, Box<dyn std::error::Error + Send + Sync>> {
        let id: uuid::Uuid =
            sqlx::query_scalar("insert into users(email,role) values($1,$2) returning id")
                .bind(format!("settings-{}@example.test", uuid::Uuid::new_v4()))
                .bind(role)
                .fetch_one(db)
                .await?;
        let (token, hash) = kernel::crypto::new_token();
        let session:uuid::Uuid=sqlx::query_scalar("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id").bind(id).bind(hash.as_slice()).fetch_one(db).await?;
        Ok(TestUser(token, session, id))
    }
    async fn request(
        app: &axum::Router,
        token: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(axum::http::StatusCode, Value), Box<dyn std::error::Error + Send + Sync>> {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(
                        body.map(|v| Body::from(v.to_string()))
                            .unwrap_or_else(Body::empty),
                    )?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1_000_000).await?;
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)?
        };
        Ok((status, value))
    }
}
