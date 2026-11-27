//! Candidate disputes and examiner resolutions for published examination results.
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use examcore::{AppError, AppState, CandidateViewer, ExaminerViewer, conflict};
use kernel::{
    request::RequestMeta,
    security::{AuditEntry, Limit, audit, enforce_rate_limit},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/attempts/{attempt_id}/disputes", post(create_dispute))
        .route("/me/disputes", get(my_disputes))
        .route("/exams/{exam_id}/disputes", get(exam_disputes))
        .route("/disputes/{dispute_id}/resolve", post(resolve_dispute))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    item_id: Uuid,
    reason: String,
}

async fn create_dispute(
    State(state): State<AppState>,
    CandidateViewer(viewer): CandidateViewer,
    Path(attempt_id): Path<Uuid>,
    meta: RequestMeta,
    Json(input): Json<CreateInput>,
) -> examcore::ApiJson {
    if !(10..=2000).contains(&input.reason.chars().count()) {
        return Err(examcore::invalid(
            "reason",
            "Reason must be 10 to 2000 characters.",
        ));
    }
    enforce_rate_limit(
        &state.db,
        &format!("dispute:{}", viewer.id),
        Limit {
            limit: 10,
            window: Duration::from_secs(3600),
        },
    )
    .await?;
    let mut tx = state.db.begin().await?;
    let row = sqlx::query("select a.exam_id,a.candidate_id,a.item_order,a.sandbox,e.results_published_at from attempts a join exams e on e.id=a.exam_id where a.id=$1 for update of a")
        .bind(attempt_id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let candidate_id: Uuid = row.try_get("candidate_id")?;
    let sandbox: bool = row.try_get("sandbox")?;
    if candidate_id != viewer.id || sandbox {
        return Err(AppError::not_found());
    }
    let exam_id: Uuid = row.try_get("exam_id")?;
    let published: Option<time::OffsetDateTime> = row.try_get("results_published_at")?;
    let published = published.ok_or_else(AppError::not_found)?;
    let now: time::OffsetDateTime = sqlx::query_scalar("select now()")
        .fetch_one(&mut *tx)
        .await?;
    if now > published + time::Duration::days(7) {
        return Err(AppError::not_found());
    }
    let order: Vec<Uuid> = row.try_get("item_order")?;
    if !order.contains(&input.item_id) {
        return Err(AppError::not_found());
    }
    let exists: bool = sqlx::query_scalar(
        "select exists(select 1 from exam_items where id=$1 and exam_id=$2 and not sandbox)",
    )
    .bind(input.item_id)
    .bind(exam_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(AppError::not_found());
    }
    let inserted = sqlx::query("insert into disputes(attempt_id,item_id,candidate_id,reason) values($1,$2,$3,$4) on conflict(attempt_id,item_id) do nothing returning id,attempt_id,item_id,reason,status,resolution,response,created_at,resolved_at,score_before::float8 as score_before,score_after::float8 as score_after")
        .bind(attempt_id).bind(input.item_id).bind(viewer.id).bind(&input.reason).fetch_optional(&mut *tx).await?;
    let Some(dispute) = inserted else {
        return Err(conflict(
            "duplicate",
            "A dispute already exists for this item.",
        ));
    };
    tx.commit().await?;
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "dispute.create",
            actor_id: Some(viewer.id),
            target_type: Some("dispute"),
            target_id: Some(dispute.try_get::<Uuid, _>("id")?.to_string()),
            meta: json!({"attemptId":attempt_id,"itemId":input.item_id}),
        },
    )
    .await;
    let data = dispute_value(&state.db, dispute, false).await?;
    Ok(examcore::ok(data))
}
async fn dispute_value(
    conn: &PgPool,
    row: sqlx::postgres::PgRow,
    examiner: bool,
) -> examcore::AppResult<Value> {
    let item_id: Uuid = row.try_get("item_id")?;
    let item = sqlx::query("select position,stem from exam_items where id=$1")
        .bind(item_id)
        .fetch_one(conn)
        .await?;
    let mut data = json!({"id":row.try_get::<Uuid,_>("id")?,"attemptId":row.try_get::<Uuid,_>("attempt_id")?,"itemId":item_id,"position":item.try_get::<i32,_>("position")?,"stem":item.try_get::<String,_>("stem")?,"reason":row.try_get::<String,_>("reason")?,"status":row.try_get::<String,_>("status")?,"resolution":row.try_get::<String,_>("resolution")?,"response":row.try_get::<String,_>("response")?,"createdAt":examcore::iso(row.try_get("created_at")?),"resolvedAt":examcore::iso_opt(row.try_get("resolved_at")?),"scoreBefore":row.try_get::<Option<f64>,_>("score_before")?,"scoreAfter":row.try_get::<Option<f64>,_>("score_after")?});
    if examiner {
        data["scriptLabel"] = row
            .try_get::<Option<String>, _>("script_label")?
            .map_or(Value::Null, Value::String);
        let details = sqlx::query("select coalesce((a.item_marks->>(i.id::text))::float8,i.marks::float8) as item_marks,coalesce(ans.manual_marks,ans.auto_marks)::float8 as awarded_marks,i.kind,i.options,u.display_name as resolved_by from disputes d join exam_items i on i.id=d.item_id join attempts a on a.id=d.attempt_id left join answers ans on ans.attempt_id=a.id and ans.item_id=i.id left join users u on u.id=d.resolved_by where d.id=$1")
            .bind(row.try_get::<Uuid,_>("id")?).fetch_one(conn).await?;
        data["itemMarks"] = json!(details.try_get::<f64, _>("item_marks")?);
        data["awardedMarks"] = details
            .try_get::<Option<f64>, _>("awarded_marks")?
            .map_or(Value::Null, |v| json!(v));
        data["kind"] = json!(details.try_get::<String, _>("kind")?);
        data["options"] = details.try_get::<Value, _>("options")?;
        data["resolvedBy"] = details
            .try_get::<Option<String>, _>("resolved_by")?
            .map_or(Value::Null, Value::String);
    }
    Ok(data)
}

const DISPUTE_SELECT: &str = "select d.id,d.attempt_id,d.item_id,d.reason,d.status,d.resolution,d.response,d.created_at,d.resolved_at,d.score_before::float8 as score_before,d.score_after::float8 as score_after";
async fn my_disputes(
    State(state): State<AppState>,
    CandidateViewer(viewer): CandidateViewer,
) -> examcore::ApiJson {
    let rows = sqlx::query(&format!(
        "{DISPUTE_SELECT} from disputes d where d.candidate_id=$1 order by d.created_at desc"
    ))
    .bind(viewer.id)
    .fetch_all(&state.db)
    .await?;
    let mut values = Vec::with_capacity(rows.len());
    for row in rows {
        values.push(dispute_value(&state.db, row, false).await?);
    }
    Ok(examcore::ok(values))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusQuery {
    status: Option<String>,
}
async fn exam_disputes(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path(exam_id): Path<Uuid>,
    Query(query): Query<StatusQuery>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
    if query
        .status
        .as_ref()
        .is_some_and(|s| !["open", "accepted", "rejected"].contains(&s.as_str()))
    {
        return Err(examcore::invalid("status", "Unknown dispute status."));
    }
    let rows=sqlx::query(&format!("with scripts as (select id,row_number() over(order by created_at,id) script_no from attempts where exam_id=$1 and not sandbox) {DISPUTE_SELECT},'Script '||lpad(s.script_no::text,2,'0') as script_label from disputes d join attempts a on a.id=d.attempt_id join scripts s on s.id=a.id where a.exam_id=$1 and ($2::text is null or d.status=$2) order by d.created_at" )).bind(exam_id).bind(query.status).fetch_all(&state.db).await?;
    let mut values = Vec::with_capacity(rows.len());
    for row in rows {
        values.push(dispute_value(&state.db, row, true).await?);
    }
    Ok(examcore::ok(values))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveInput {
    status: String,
    resolution: String,
    response: String,
    marks: Option<f64>,
    alternative_option_ids: Option<Vec<String>>,
}
async fn resolve_dispute(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path(dispute_id): Path<Uuid>,
    meta: RequestMeta,
    Json(input): Json<ResolveInput>,
) -> examcore::ApiJson {
    if !["accepted", "rejected"].contains(&input.status.as_str())
        || !["none", "regrade", "void_item", "accept_alternative"]
            .contains(&input.resolution.as_str())
        || input.response.chars().count() > 2000
    {
        return Err(examcore::invalid(
            "resolution",
            "Invalid dispute resolution.",
        ));
    }
    if (input.status == "rejected" && input.resolution != "none")
        || (input.status == "accepted" && input.resolution == "none")
    {
        return Err(examcore::invalid(
            "resolution",
            "Accepted disputes require an action; rejected disputes use none.",
        ));
    }
    let mut tx = state.db.begin().await?;
    let base=sqlx::query("select d.attempt_id,d.item_id,d.status,a.exam_id,a.total_score::float8 as score_before,e.owner_id,e.title,e.total_marks::float8 as total_marks,e.pass_marks::float8 as pass_marks,u.display_name from disputes d join attempts a on a.id=d.attempt_id join exams e on e.id=a.exam_id join users u on u.id=a.candidate_id where d.id=$1 and e.deleted_at is null for update of d,a,e").bind(dispute_id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let owner: Uuid = base.try_get("owner_id")?;
    if owner != viewer.id && !viewer.is_admin() {
        return Err(AppError::not_found());
    }
    if base.try_get::<String, _>("status")? != "open" {
        return Err(conflict("resolved", "Dispute is already resolved."));
    }
    let attempt_id: Uuid = base.try_get("attempt_id")?;
    let item_id: Uuid = base.try_get("item_id")?;
    let exam_id: Uuid = base.try_get("exam_id")?;
    let item=sqlx::query("select marks::float8 as marks,kind,options,correct,voided,accepted_alternatives from exam_items where id=$1 and exam_id=$2 for update").bind(item_id).bind(exam_id).fetch_one(&mut *tx).await?;
    let marks_max: f64 = item.try_get("marks")?;
    match input.resolution.as_str() {
        "regrade" => {
            let marks = input
                .marks
                .ok_or_else(|| examcore::invalid("marks", "Marks are required."))?;
            if !valid_grade(marks, marks_max) {
                return Err(examcore::invalid(
                    "marks",
                    "Marks must be within the item maximum in 0.25 steps.",
                ));
            }
            sqlx::query("insert into answers(attempt_id,item_id,response,client_seq,manual_marks,feedback,graded_by,graded_at) values($1,$2,'{}',0,$3,$4,$5,now()) on conflict(attempt_id,item_id) do update set manual_marks=$3,feedback=$4,graded_by=$5,graded_at=now()").bind(attempt_id).bind(item_id).bind(marks).bind(&input.response).bind(viewer.id).execute(&mut *tx).await?;
        }
        "void_item" => {
            sqlx::query("update exam_items set voided=true where id=$1")
                .bind(item_id)
                .execute(&mut *tx)
                .await?;
        }
        "accept_alternative" => {
            let ids = input.alternative_option_ids.as_ref().ok_or_else(|| {
                examcore::invalid("alternativeOptionIds", "Option ids are required.")
            })?;
            let options: Value = item.try_get("options")?;
            let valid: Vec<String> = options
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| o.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect();
            if ids.is_empty() || ids.iter().any(|id| !valid.contains(id)) {
                return Err(examcore::invalid(
                    "alternativeOptionIds",
                    "Choose one or more options belonging to this item.",
                ));
            }
            sqlx::query("update exam_items set accepted_alternatives=(select coalesce(jsonb_agg(distinct value), '[]'::jsonb) from jsonb_array_elements_text(accepted_alternatives || $2::jsonb) value) where id=$1").bind(item_id).bind(json!(ids)).execute(&mut *tx).await?;
        }
        _ => {}
    }
    let affected: Vec<Uuid> =
        if input.resolution == "void_item" || input.resolution == "accept_alternative" {
            sqlx::query_scalar(
                "select id from attempts where exam_id=$1 and not sandbox order by id for update",
            )
            .bind(exam_id)
            .fetch_all(&mut *tx)
            .await?
        } else {
            sqlx::query_scalar("select id from attempts where id=$1 for update")
                .bind(attempt_id)
                .fetch_all(&mut *tx)
                .await?
        };
    for id in &affected {
        exam_grading::autograde_attempt(&mut tx, *id).await?;
    }
    let after: Option<f64> =
        sqlx::query_scalar("select total_score::float8 from attempts where id=$1")
            .bind(attempt_id)
            .fetch_one(&mut *tx)
            .await?;
    let before: Option<f64> = base.try_get("score_before")?;
    sqlx::query("update disputes set status=$2,resolution=$3,response=$4,resolved_by=$5,resolved_at=now(),score_before=$6,score_after=$7 where id=$1").bind(dispute_id).bind(&input.status).bind(&input.resolution).bind(&input.response).bind(viewer.id).bind(before).bind(after).execute(&mut *tx).await?;
    let title: String = base.try_get("title")?;
    let pass: f64 = base.try_get("pass_marks")?;
    let total: f64 = sqlx::query_scalar("select coalesce(sum(marks),0)::float8 from exam_items where exam_id=$1 and not voided and not sandbox")
        .bind(exam_id).fetch_one(&mut *tx).await?;
    for id in &affected {
        let cert=sqlx::query("select a.total_score::float8 as score,u.display_name from attempts a join users u on u.id=a.candidate_id join result_certificates c on c.attempt_id=a.id where a.id=$1 and c.revoked_at is null").bind(id).fetch_optional(&mut *tx).await?;
        if let Some(c) = cert {
            let score: f64 = c.try_get("score")?;
            let name: String = c.try_get("display_name")?;
            sqlx::query("update result_certificates set revoked_at=now() where attempt_id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            exam_grading::issue_certificate(&mut tx, *id, &title, &name, score, total, pass)
                .await?;
        }
    }
    tx.commit().await?;
    audit(&state.db,&meta,AuditEntry{action:"dispute.resolve",actor_id:Some(viewer.id),target_type:Some("dispute"),target_id:Some(dispute_id.to_string()),meta:json!({"attemptId":attempt_id,"itemId":item_id,"resolution":input.resolution,"before":before,"after":after})}).await;
    let row = sqlx::query(&format!("{DISPUTE_SELECT} from disputes d where d.id=$1"))
        .bind(dispute_id)
        .fetch_one(&state.db)
        .await?;
    Ok(examcore::ok(dispute_value(&state.db, row, false).await?))
}
fn valid_grade(marks: f64, max: f64) -> bool {
    marks.is_finite() && marks >= 0.0 && marks <= max && (marks * 4.0).fract().abs() < 1e-6
}

#[cfg(test)]
mod tests {
    use super::valid_grade;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use sqlx::Row;
    use std::{error::Error, sync::Arc};
    use tower::ServiceExt;
    use uuid::Uuid;

    type TestResult<T = ()> = Result<T, Box<dyn Error + Send + Sync>>;

    struct Identity {
        id: Uuid,
        token: String,
    }
    struct Fixture {
        state: examcore::AppState,
        candidate: Identity,
        other_candidate: Identity,
        examiner: Identity,
        stranger_examiner: Identity,
        exam: Uuid,
        other_exam: Uuid,
        attempts: [Uuid; 2],
        items: [Uuid; 2],
        codes: [String; 2],
    }

    async fn identity(db: &sqlx::PgPool, suffix: &str, role: &str) -> TestResult<Identity> {
        let id = sqlx::query_scalar(
            "insert into users(email,display_name,role) values($1,$2,$3) returning id",
        )
        .bind(format!("{suffix}@disputes.test"))
        .bind(format!("Name {suffix}"))
        .bind(role)
        .fetch_one(db)
        .await?;
        let (token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')")
            .bind(id).bind(hash.as_slice()).execute(db).await?;
        Ok(Identity { id, token })
    }

    async fn fixture(db: sqlx::PgPool, published: bool) -> TestResult<Fixture> {
        let suffix = Uuid::new_v4().simple().to_string();
        let candidate = identity(&db, &format!("candidate-{suffix}"), "user").await?;
        let other_candidate = identity(&db, &format!("other-candidate-{suffix}"), "user").await?;
        let examiner = identity(&db, &format!("examiner-{suffix}"), "examiner").await?;
        let stranger_examiner =
            identity(&db, &format!("stranger-examiner-{suffix}"), "examiner").await?;
        let settings = json!({"showBreakdown":true});
        let exam: Uuid = sqlx::query_scalar("insert into exams(owner_id,title,status,starts_at,ends_at,duration_minutes,total_marks,pass_marks,settings,published_at,results_published_at) values($1,'Dispute fixture','completed',now()-interval '2 days',now()-interval '1 day',60,20,5,$2,now()-interval '2 days',case when $3 then now() else null end) returning id")
            .bind(examiner.id).bind(&settings).bind(published).fetch_one(&db).await?;
        let other_exam: Uuid = sqlx::query_scalar("insert into exams(owner_id,title,status,starts_at,ends_at,duration_minutes,total_marks,pass_marks,settings,published_at) values($1,'Other exam','completed',now()-interval '2 days',now()-interval '1 day',60,20,5,$2,now()-interval '2 days') returning id")
            .bind(stranger_examiner.id).bind(&settings).fetch_one(&db).await?;
        let mut items = Vec::new();
        for position in 0..2 {
            let id: Uuid = sqlx::query_scalar("insert into exam_items(exam_id,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule) values($1,$2,'Core',2,'single',$3,'[{\"id\":\"a\",\"text\":\"Alpha\"},{\"id\":\"b\",\"text\":\"Beta\"}]','[\"a\"]',10,0,'all_or_nothing') returning id")
                .bind(exam).bind(position).bind(format!("Question {position}")).fetch_one(&db).await?;
            items.push(id);
        }
        let mut attempts = Vec::new();
        let mut codes = Vec::new();
        for (candidate_id, suffix, selected) in
            [(candidate.id, "a", "b"), (other_candidate.id, "b", "a")]
        {
            let attempt_id: Uuid = sqlx::query_scalar("insert into attempts(exam_id,candidate_id,status,finalized_by,deadline_at,seed,item_order,journal_genesis) values($1,$2,'submitted','candidate',now(),1,$3,$4) returning id")
                .bind(exam).bind(candidate_id).bind(items.clone()).bind(vec![0_u8;32]).fetch_one(&db).await?;
            for item in &items {
                let choice = if *item == items[0] { selected } else { suffix };
                sqlx::query("insert into answers(attempt_id,item_id,response,client_seq) values($1,$2,$3,1)")
                    .bind(attempt_id).bind(item).bind(json!({"selected":[choice]})).execute(&db).await?;
            }
            let mut tx = db.begin().await?;
            exam_grading::autograde_attempt(&mut tx, attempt_id).await?;
            let score: f64 =
                sqlx::query_scalar("select total_score::float8 from attempts where id=$1")
                    .bind(attempt_id)
                    .fetch_one(&mut *tx)
                    .await?;
            if published {
                exam_grading::issue_certificate(
                    &mut tx,
                    attempt_id,
                    "Dispute fixture",
                    if candidate_id == candidate.id {
                        "Name Candidate"
                    } else {
                        "Name Other"
                    },
                    score,
                    20.0,
                    5.0,
                )
                .await?;
            }
            tx.commit().await?;
            attempts.push(attempt_id);
            if published {
                codes.push(
                    sqlx::query_scalar(
                        "select verify_code from result_certificates where attempt_id=$1",
                    )
                    .bind(attempt_id)
                    .fetch_one(&db)
                    .await?,
                );
            } else {
                codes.push(String::new());
            }
        }
        let config = Arc::new(kernel::config::Config::from_env()?);
        let state = examcore::AppState {
            db,
            config,
            http: Default::default(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        Ok(Fixture {
            state,
            candidate,
            other_candidate,
            examiner,
            stranger_examiner,
            exam,
            other_exam,
            attempts: [attempts[0], attempts[1]],
            items: [items[0], items[1]],
            codes: [codes[0].clone(), codes[1].clone()],
        })
    }

    async fn call(
        f: &Fixture,
        token: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> TestResult<(StatusCode, Value)> {
        let app = crate::router()
            .merge(exam_grading::router())
            .with_state(f.state.clone());
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json");
        let response = app
            .oneshot(
                req.body(
                    body.map(|v| Body::from(v.to_string()))
                        .unwrap_or_else(Body::empty),
                )?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1_000_000).await?;
        Ok((status, serde_json::from_slice(&bytes)?))
    }
    async fn create_dispute(
        f: &Fixture,
        who: &Identity,
        attempt: Uuid,
        item: Uuid,
    ) -> TestResult<(StatusCode, Value)> {
        call(
            f,
            &who.token,
            "POST",
            &format!("/attempts/{attempt}/disputes"),
            Some(json!({"itemId":item,"reason":"The selected answer should receive credit."})),
        )
        .await
    }
    async fn resolve(
        f: &Fixture,
        id: Uuid,
        resolution: &str,
        extras: Value,
    ) -> TestResult<(StatusCode, Value)> {
        let mut body = json!({"status":"accepted","resolution":resolution,"response":"Reviewed and resolved."});
        if let (Some(dst), Some(src)) = (body.as_object_mut(), extras.as_object()) {
            for (key, value) in src {
                dst.insert(key.clone(), value.clone());
            }
        }
        call(
            f,
            &f.examiner.token,
            "POST",
            &format!("/disputes/{id}/resolve"),
            Some(body),
        )
        .await
    }

    #[test]
    fn dispute_regrade_requires_quarter_mark_within_item_maximum() {
        assert!(valid_grade(0.0, 4.0));
        assert!(valid_grade(1.25, 4.0));
        assert!(!valid_grade(4.25, 4.0));
        assert!(!valid_grade(0.3, 4.0));
        assert!(!valid_grade(f64::NAN, 4.0));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn dispute_schema_and_marking_columns_are_installed(
        db: sqlx::PgPool,
    ) -> Result<(), sqlx::Error> {
        let enabled: bool = sqlx::query_scalar(
            "select relrowsecurity from pg_class where oid='disputes'::regclass",
        )
        .fetch_one(&db)
        .await?;
        assert!(enabled);
        let columns = sqlx::query("select column_name from information_schema.columns where table_name in ('exam_items','attempts') and column_name in ('voided','accepted_alternatives','item_marks')")
            .fetch_all(&db).await?;
        let names: Vec<String> = columns.iter().map(|row| row.get("column_name")).collect();
        assert!(names.contains(&"voided".to_owned()));
        assert!(names.contains(&"accepted_alternatives".to_owned()));
        assert!(names.contains(&"item_marks".to_owned()));
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn dispute_creation_checks_publication_ownership_and_duplicates(
        db: sqlx::PgPool,
    ) -> TestResult {
        let unpublished = fixture(db.clone(), false).await?;
        assert_eq!(
            create_dispute(
                &unpublished,
                &unpublished.candidate,
                unpublished.attempts[0],
                unpublished.items[0]
            )
            .await?
            .0,
            StatusCode::NOT_FOUND
        );
        let f = fixture(db, true).await?;
        assert_eq!(
            create_dispute(&f, &f.candidate, f.attempts[1], f.items[0])
                .await?
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            create_dispute(&f, &f.candidate, f.attempts[0], f.items[0])
                .await?
                .0,
            StatusCode::OK
        );
        assert_eq!(
            create_dispute(&f, &f.candidate, f.attempts[0], f.items[0])
                .await?
                .0,
            StatusCode::CONFLICT
        );
        let (status, rows) = call(
            &f,
            &f.examiner.token,
            "GET",
            &format!("/exams/{}/disputes", f.exam),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let row = &rows["data"][0];
        assert_eq!(row["itemMarks"], 10.0);
        assert_eq!(row["awardedMarks"], 0.0);
        assert_eq!(row["kind"], "single");
        assert_eq!(row["options"][0], json!({"id":"a","text":"Alpha"}));
        assert!(row.get("correct").is_none());
        assert_eq!(row["resolvedBy"], Value::Null);
        assert_eq!(
            call(
                &f,
                &f.stranger_examiner.token,
                "GET",
                &format!("/exams/{}/disputes", f.exam),
                None
            )
            .await?
            .0,
            StatusCode::NOT_FOUND
        );
        assert_ne!(f.other_exam, f.exam);
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn void_recomputes_all_attempts_and_candidate_breakdown(db: sqlx::PgPool) -> TestResult {
        let f = fixture(db, true).await?;
        let initial:Vec<(Option<f64>,Option<f64>,Option<f64>)>=sqlx::query_as("select auto_score::float8,manual_score::float8,total_score::float8 from attempts where exam_id=$1 order by created_at,id").bind(f.exam).fetch_all(&f.state.db).await?;
        assert_eq!(
            initial.iter().map(|r| r.2).collect::<Vec<_>>(),
            vec![Some(10.0), Some(10.0)]
        );
        create_dispute(&f, &f.candidate, f.attempts[0], f.items[0]).await?;
        let id: Uuid =
            sqlx::query_scalar("select id from disputes where attempt_id=$1 and item_id=$2")
                .bind(f.attempts[0])
                .bind(f.items[0])
                .fetch_one(&f.state.db)
                .await?;
        assert_eq!(
            resolve(&f, id, "void_item", json!({})).await?.0,
            StatusCode::OK
        );
        for attempt in f.attempts {
            let total: f64 =
                sqlx::query_scalar("select total_score::float8 from attempts where id=$1")
                    .bind(attempt)
                    .fetch_one(&f.state.db)
                    .await?;
            let details:Vec<(Uuid,Option<f64>)>=sqlx::query_as("select item_id,auto_marks::float8 from answers where attempt_id=$1 order by item_id").bind(attempt).fetch_all(&f.state.db).await?;
            let expected = if attempt == f.attempts[0] { 10.0 } else { 0.0 };
            assert_eq!(total, expected, "attempt {attempt}; answers={details:?}");
            let (status, result) = call(
                &f,
                if attempt == f.attempts[0] {
                    &f.candidate.token
                } else {
                    &f.other_candidate.token
                },
                "GET",
                &format!("/me/results/{attempt}"),
                None,
            )
            .await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(result["data"]["totalMarks"], 10.0);
            assert_eq!(result["data"]["percent"], expected / 10.0 * 100.0);
            let voided = result["data"]["breakdown"]
                .as_array()
                .ok_or("missing breakdown")?
                .iter()
                .find(|item| item["itemId"] == f.items[0].to_string())
                .ok_or("missing itemId")?;
            assert_eq!(voided["voided"], true);
            assert_eq!(voided["feedback"], "Voided after review");
        }
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn alternatives_raise_scores_regrade_validates_and_certificate_verifies(
        db: sqlx::PgPool,
    ) -> TestResult {
        let f = fixture(db, true).await?;
        create_dispute(&f, &f.candidate, f.attempts[0], f.items[0]).await?;
        let id: Uuid =
            sqlx::query_scalar("select id from disputes where attempt_id=$1 and item_id=$2")
                .bind(f.attempts[0])
                .bind(f.items[0])
                .fetch_one(&f.state.db)
                .await?;
        for marks in [10.5, 1.3] {
            let (status, body) = resolve(&f, id, "regrade", json!({"marks":marks})).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        }
        assert_eq!(
            resolve(
                &f,
                id,
                "accept_alternative",
                json!({"alternativeOptionIds":["b"]})
            )
            .await?
            .0,
            StatusCode::OK
        );
        let score: f64 = sqlx::query_scalar("select total_score::float8 from attempts where id=$1")
            .bind(f.attempts[0])
            .fetch_one(&f.state.db)
            .await?;
        assert_eq!(score, 20.0);
        let (status, verification) = call(
            &f,
            &f.candidate.token,
            "GET",
            &format!("/verify/{}", f.codes[0]),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(verification["data"]["valid"], true);
        assert_eq!(verification["data"]["signature"]["valid"], true);
        let (status, rows) = call(
            &f,
            &f.examiner.token,
            "GET",
            &format!("/exams/{}/disputes", f.exam),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        assert!(
            rows["data"][0]["resolvedBy"]
                .as_str()
                .is_some_and(|name| name.starts_with("Name examiner-"))
        );
        Ok(())
    }
}
