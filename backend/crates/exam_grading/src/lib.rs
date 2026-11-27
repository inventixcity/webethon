//! Grading and result publication for Invigil examinations.
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post, put},
};
use examcore::{
    AppError, AppResult, AppState, CandidateViewer, ExaminerViewer, MarkingScheme, conflict,
    load_exam_for_examiner, round2, score_objective,
};
use kernel::{
    request::RequestMeta,
    security::{AuditEntry, audit},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/exams/{exam_id}/grading", get(grading_list))
        .route(
            "/attempts/{attempt_id}/answers/{item_id}/grade",
            put(grade_answer),
        )
        .route("/exams/{exam_id}/results", get(results))
        .route("/exams/{exam_id}/results/publish", post(publish_results))
        .route(
            "/exams/{exam_id}/results/unpublish",
            post(unpublish_results),
        )
        .route("/me/results/{attempt_id}", get(candidate_result))
        .route("/attempts/{attempt_id}/report", get(attempt_report))
        .route("/exams/{exam_id}/report", get(exam_report))
        .route("/verify/{code}", get(verify_certificate))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GradingItem {
    attempt_id: Uuid,
    item_id: Uuid,
    script_label: String,
    position: i32,
    stem: String,
    rubric: String,
    marks: f64,
    answer_text: String,
    word_count: usize,
    manual_marks: Option<f64>,
    feedback: String,
    #[serde(with = "time::serde::rfc3339::option")]
    graded_at: Option<time::OffsetDateTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GradingQuery {
    pending: Option<bool>,
    #[serde(rename = "itemId")]
    item_id: Option<Uuid>,
}

async fn grading_list(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path(exam_id): Path<Uuid>,
    Query(query): Query<GradingQuery>,
) -> examcore::ApiJson {
    load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
    let rows = sqlx::query(
        "with scripts as (
           select id, row_number() over (order by created_at, id) as script_no
           from attempts where exam_id=$1 and not sandbox and status <> 'in_progress'
         )
         select t.id as attempt_id, i.id as item_id, s.script_no::int as script_no,
                i.position, i.stem, i.rubric, i.marks::float8 as marks,
                coalesce(a.response->>'text','') as answer_text,
                a.manual_marks::float8 as manual_marks, a.feedback, a.graded_at
         from scripts s join attempts t on t.id=s.id
         join exam_items i on i.exam_id=t.exam_id and i.id=any(t.item_order) and i.kind='written'
         left join answers a on a.attempt_id=t.id and a.item_id=i.id
         where t.exam_id=$1 and ($2::boolean is not true or a.manual_marks is null)
           and ($3::uuid is null or i.id=$3)
         order by s.script_no, i.position",
    )
    .bind(exam_id)
    .bind(query.pending)
    .bind(query.item_id)
    .fetch_all(&state.db)
    .await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let answer_text: String = row.try_get("answer_text")?;
        let script_no: i32 = row.try_get("script_no")?;
        items.push(GradingItem {
            attempt_id: row.try_get("attempt_id")?,
            item_id: row.try_get("item_id")?,
            script_label: format!("Script {script_no:02}"),
            position: row.try_get("position")?,
            stem: row.try_get("stem")?,
            rubric: row.try_get("rubric")?,
            marks: row.try_get("marks")?,
            word_count: answer_text.split_whitespace().count(),
            answer_text,
            manual_marks: row.try_get("manual_marks")?,
            feedback: row.try_get("feedback")?,
            graded_at: row.try_get("graded_at")?,
        });
    }
    Ok(examcore::ok(items))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GradeInput {
    marks: f64,
    feedback: String,
}

async fn grade_answer(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path((attempt_id, item_id)): Path<(Uuid, Uuid)>,
    meta: RequestMeta,
    Json(input): Json<GradeInput>,
) -> examcore::ApiJson {
    if !valid_grade(input.marks, f64::MAX) || input.feedback.chars().count() > 4000 {
        return Err(examcore::invalid(
            "marks",
            "Marks or feedback are outside the allowed range.",
        ));
    }
    let mut tx = state.db.begin().await?;
    let exam_id: Uuid = sqlx::query_scalar("select exam_id from attempts where id=$1")
        .bind(attempt_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(AppError::not_found)?;
    let exam = sqlx::query("select owner_id,results_published_at from exams where id=$1 and deleted_at is null for update")
        .bind(exam_id).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    let owner_id: Uuid = exam.try_get("owner_id")?;
    if owner_id != viewer.id && !viewer.is_admin() {
        return Err(AppError::not_found());
    }
    let published: Option<time::OffsetDateTime> = exam.try_get("results_published_at")?;
    if published.is_some() {
        return Err(conflict(
            "published",
            "Unpublish results before changing grades.",
        ));
    }
    let attempt =
        sqlx::query("select status,sandbox from attempts where id=$1 and exam_id=$2 for update")
            .bind(attempt_id)
            .bind(exam_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(AppError::not_found)?;
    let status: String = attempt.try_get("status")?;
    let sandbox: bool = attempt.try_get("sandbox")?;
    if status == "in_progress" || sandbox {
        return Err(AppError::not_found());
    }
    let marks_max: Option<f64> = sqlx::query_scalar(
        "select marks::float8 from exam_items where id=$1 and exam_id=$2 and kind='written'",
    )
    .bind(item_id)
    .bind(exam_id)
    .fetch_optional(&mut *tx)
    .await?;
    let maximum = marks_max.ok_or_else(AppError::not_found)?;
    if !valid_grade(input.marks, maximum) {
        return Err(examcore::invalid(
            "marks",
            "Marks must be within the item maximum in 0.25 steps.",
        ));
    }
    let before: Option<f64> = sqlx::query_scalar(
        "select manual_marks::float8 from answers where attempt_id=$1 and item_id=$2",
    )
    .bind(attempt_id)
    .bind(item_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    sqlx::query("insert into answers(attempt_id,item_id,response,client_seq,manual_marks,feedback,graded_by,graded_at) values ($1,$2,'{\"text\":\"\"}'::jsonb,0,$3,$4,$5,now()) on conflict(attempt_id,item_id) do update set manual_marks=excluded.manual_marks,feedback=excluded.feedback,graded_by=excluded.graded_by,graded_at=excluded.graded_at")
        .bind(attempt_id).bind(item_id).bind(input.marks).bind(&input.feedback).bind(viewer.id).execute(&mut *tx).await?;
    autograde_attempt(&mut tx, attempt_id).await?;
    tx.commit().await?;
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "grading.grade",
            actor_id: Some(viewer.id),
            target_type: Some("attempt"),
            target_id: Some(attempt_id.to_string()),
            meta: json!({"itemId": item_id, "before": before, "after": input.marks}),
        },
    )
    .await;
    let response = sqlx::query("select i.position,i.stem,i.rubric,i.marks::float8 as marks,a.response->>'text' as answer_text,a.manual_marks::float8 as manual_marks,a.feedback,a.graded_at from exam_items i join answers a on a.item_id=i.id where i.id=$1 and a.attempt_id=$2")
        .bind(item_id).bind(attempt_id).fetch_one(&state.db).await?;
    let text: String = response
        .try_get::<Option<String>, _>("answer_text")?
        .unwrap_or_default();
    let script_number: i64 = sqlx::query_scalar("select count(*) from attempts curr join attempts prev on prev.exam_id=curr.exam_id and not prev.sandbox and prev.status<>'in_progress' and (prev.created_at,prev.id) <= (curr.created_at,curr.id) where curr.id=$1 and not curr.sandbox and curr.status<>'in_progress'")
        .bind(attempt_id).fetch_one(&state.db).await?;
    Ok(examcore::ok(GradingItem {
        attempt_id,
        item_id,
        script_label: format!("Script {script_number:02}"),
        position: response.try_get("position")?,
        stem: response.try_get("stem")?,
        rubric: response.try_get("rubric")?,
        marks: response.try_get("marks")?,
        word_count: text.split_whitespace().count(),
        answer_text: text,
        manual_marks: response.try_get("manual_marks")?,
        feedback: response.try_get("feedback")?,
        graded_at: response.try_get("graded_at")?,
    }))
}

fn valid_grade(marks: f64, maximum: f64) -> bool {
    marks.is_finite() && marks >= 0.0 && marks <= maximum && (marks * 4.0).fract().abs() <= 0.000001
}

async fn results(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path(exam_id): Path<Uuid>,
) -> examcore::ApiJson {
    load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
    Ok(examcore::ok(results_value(&state, exam_id).await?))
}

async fn results_value(state: &AppState, exam_id: Uuid) -> AppResult<Value> {
    let exam = sqlx::query("select total_marks::float8 as total_marks,pass_marks::float8 as pass_marks,results_published_at,ends_at,status from exams where id=$1 and deleted_at is null")
        .bind(exam_id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    let total_marks: f64 = exam.try_get("total_marks")?;
    let pass_marks: f64 = exam.try_get("pass_marks")?;
    let published: Option<time::OffsetDateTime> = exam.try_get("results_published_at")?;
    let rows = sqlx::query("select a.id as attempt_id,a.candidate_id,u.display_name,u.email,a.status,a.auto_score::float8 as auto_score,a.manual_score::float8 as manual_score,a.total_score::float8 as total_score,case when a.total_score is null then null else round((a.total_score::numeric / $2::numeric * 100),2)::float8 end as percent,case when a.total_score is null then null else a.total_score >= $3 end as passed,a.grading_status,a.review_priority,a.submitted_at from attempts a join users u on u.id=a.candidate_id where a.exam_id=$1 and not a.sandbox order by a.created_at,a.id")
        .bind(exam_id).bind(total_marks).bind(pass_marks).fetch_all(&state.db).await?;
    let mut conn = state.db.acquire().await?;
    let blockers = publication_blockers(&mut conn, exam_id).await?;
    let rows_json = rows.iter().map(|row| {
        let attempt_id: Uuid = row.try_get("attempt_id")?;
        let candidate_id: Uuid = row.try_get("candidate_id")?;
        let display_name: String = row.try_get("display_name")?;
        let email: String = row.try_get("email")?;
        let attempt_status: String = row.try_get("status")?;
        let auto_score: Option<f64> = row.try_get("auto_score")?;
        let manual_score: Option<f64> = row.try_get("manual_score")?;
        let total_score: Option<f64> = row.try_get("total_score")?;
        let percent: Option<f64> = row.try_get("percent")?;
        let passed: Option<bool> = row.try_get("passed")?;
        let grading_status: String = row.try_get("grading_status")?;
        let review_priority: String = row.try_get("review_priority")?;
        let submitted_at: Option<time::OffsetDateTime> = row.try_get("submitted_at")?;
        Ok(json!({"attemptId":attempt_id,"candidateId":candidate_id,"displayName":display_name,"email":email,"status":attempt_status,"autoScore":auto_score,"manualScore":manual_score,"totalScore":total_score,"percent":percent,"passed":passed,"gradingStatus":grading_status,"reviewPriority":review_priority,"submittedAt":examcore::ts(submitted_at)}))
    }).collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok(
        json!({"examId":exam_id,"totalMarks":total_marks,"passMarks":pass_marks,"resultsPublishedAt":examcore::ts(published),"canPublish":blockers.is_empty(),"blockers":blockers,"rows":rows_json}),
    )
}

async fn publication_blockers(conn: &mut PgConnection, exam_id: Uuid) -> AppResult<Vec<String>> {
    let exam = sqlx::query("select ends_at,status from exams where id=$1 and deleted_at is null")
        .bind(exam_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(AppError::not_found)?;
    let ends_at: time::OffsetDateTime = exam.try_get("ends_at")?;
    let status: String = exam.try_get("status")?;
    let mut blockers = Vec::new();
    if time::OffsetDateTime::now_utc() < ends_at && status != "completed" {
        blockers.push("The exam window is still open.".to_owned());
    }
    if sqlx::query_scalar::<_, bool>("select exists(select 1 from attempts where exam_id=$1 and not sandbox and status='in_progress')")
        .bind(exam_id).fetch_one(&mut *conn).await? {
        blockers.push("One or more attempts are still in progress.".to_owned());
    }
    if sqlx::query_scalar::<_, bool>("select exists(select 1 from attempts where exam_id=$1 and not sandbox and grading_status <> 'complete')")
        .bind(exam_id).fetch_one(&mut *conn).await? {
        blockers.push("One or more attempts are not fully graded.".to_owned());
    }
    Ok(blockers)
}

async fn publish_results(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path(exam_id): Path<Uuid>,
    meta: RequestMeta,
) -> examcore::ApiJson {
    let mut tx = state.db.begin().await?;
    let owner: Option<Uuid> = sqlx::query_scalar(
        "select owner_id from exams where id=$1 and deleted_at is null for update",
    )
    .bind(exam_id)
    .fetch_optional(&mut *tx)
    .await?;
    if owner.is_none_or(|owner| owner != viewer.id && !viewer.is_admin()) {
        return Err(AppError::not_found());
    }
    let blockers = publication_blockers(&mut tx, exam_id).await?;
    if !blockers.is_empty() {
        return Err(conflict(
            "grading_incomplete",
            "Results cannot be published yet.",
        ));
    }
    sqlx::query("update exams set results_published_at=coalesce(results_published_at,now()),updated_at=now() where id=$1")
        .bind(exam_id).execute(&mut *tx).await?;
    let exam = sqlx::query("select title,pass_marks::float8 as pass_marks,total_marks::float8 as total_marks from exams where id=$1")
        .bind(exam_id).fetch_one(&mut *tx).await?;
    let exam_title: String = exam.try_get("title")?;
    let pass_marks: f64 = exam.try_get("pass_marks")?;
    let total_marks: f64 = exam.try_get("total_marks")?;
    let candidates = sqlx::query("select a.id,a.total_score::float8 as total_score,a.candidate_id,u.display_name from attempts a join users u on u.id=a.candidate_id where a.exam_id=$1 and not a.sandbox and a.status<>'in_progress'")
        .bind(exam_id).fetch_all(&mut *tx).await?;
    let issued_count = candidates.len();
    for candidate in candidates {
        let attempt_id: Uuid = candidate.try_get("id")?;
        let score: f64 = candidate.try_get("total_score")?;
        let display_name: String = candidate.try_get("display_name")?;
        issue_certificate(
            &mut tx,
            attempt_id,
            &exam_title,
            &display_name,
            score,
            total_marks,
            pass_marks,
        )
        .await?;
    }
    tx.commit().await?;
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "results.publish",
            actor_id: Some(viewer.id),
            target_type: Some("exam"),
            target_id: Some(exam_id.to_string()),
            meta: json!({"attempts":issued_count}),
        },
    )
    .await;
    Ok(examcore::ok(results_value(&state, exam_id).await?))
}

async fn issue_certificate(
    conn: &mut PgConnection,
    attempt_id: Uuid,
    exam_title: &str,
    display_name: &str,
    score: f64,
    total_marks: f64,
    pass_marks: f64,
) -> AppResult<String> {
    let existing = sqlx::query(
        "select verify_code,revoked_at from result_certificates where attempt_id=$1 for update",
    )
    .bind(attempt_id)
    .fetch_optional(&mut *conn)
    .await?;
    let (verify_code, needs_reissue, has_existing) = if let Some(row) = existing {
        let verify_code: String = row.try_get("verify_code")?;
        let revoked_at: Option<time::OffsetDateTime> = row.try_get("revoked_at")?;
        (verify_code, revoked_at.is_some(), true)
    } else {
        (new_verify_code(), true, false)
    };
    if !needs_reissue {
        return Ok(verify_code);
    }

    let name_parts: Vec<&str> = display_name.split_whitespace().collect();
    let first_initial = name_parts
        .first()
        .and_then(|word| word.chars().next())
        .unwrap_or('X');
    let last_name = name_parts.last().copied().unwrap_or("X");
    let last_initial = last_name.chars().next().unwrap_or('X');
    let last_character = last_name.chars().last().unwrap_or('X');
    let issued_at = time::OffsetDateTime::now_utc();
    let statement = json!({
        "certificateId": verify_code,
        "examTitle": exam_title,
        "candidate": format!("{first_initial}. {last_initial}****{last_character}"),
        "percent": round2(score / total_marks * 100.0),
        "passed": score >= pass_marks,
        "issuedAt": examcore::ts(issued_at),
        "issuer": "Inventix Invigil"
    });
    let statement_hash =
        examcore::kernel::crypto::sha256(examcore::canonical_json(&statement).as_bytes());
    let (signature, key_id) = examcore::signer::sign(&statement_hash);
    if has_existing {
        sqlx::query("update result_certificates set statement=$2,statement_hash=$3,signature=$4,key_id=$5,issued_at=$6,revoked_at=null where attempt_id=$1")
            .bind(attempt_id)
            .bind(statement)
            .bind(statement_hash.to_vec())
            .bind(signature.to_vec())
            .bind(key_id)
            .bind(issued_at)
            .execute(&mut *conn)
            .await?;
    } else {
        sqlx::query("insert into result_certificates(attempt_id,verify_code,statement,statement_hash,signature,key_id,issued_at,revoked_at) values($1,$2,$3,$4,$5,$6,$7,null)")
            .bind(attempt_id)
            .bind(&verify_code)
            .bind(statement)
            .bind(statement_hash.to_vec())
            .bind(signature.to_vec())
            .bind(key_id)
            .bind(issued_at)
            .execute(&mut *conn)
            .await?;
    }
    Ok(verify_code)
}

fn new_verify_code() -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut bytes = [0_u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let code: String = bytes
        .iter()
        .map(|byte| ALPHABET[usize::from(byte & 31)] as char)
        .collect();
    format!("{}-{}-{}", &code[0..4], &code[4..8], &code[8..12])
}

async fn unpublish_results(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path(exam_id): Path<Uuid>,
    meta: RequestMeta,
) -> examcore::ApiJson {
    let mut tx = state.db.begin().await?;
    let owner: Option<Uuid> = sqlx::query_scalar(
        "select owner_id from exams where id=$1 and deleted_at is null for update",
    )
    .bind(exam_id)
    .fetch_optional(&mut *tx)
    .await?;
    if owner.is_none_or(|owner| owner != viewer.id && !viewer.is_admin()) {
        return Err(AppError::not_found());
    }
    sqlx::query("update exams set results_published_at=null,updated_at=now() where id=$1")
        .bind(exam_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("update result_certificates set revoked_at=coalesce(revoked_at,now()) where attempt_id in (select id from attempts where exam_id=$1)")
        .bind(exam_id).execute(&mut *tx).await?;
    tx.commit().await?;
    audit(
        &state.db,
        &meta,
        AuditEntry {
            action: "results.unpublish",
            actor_id: Some(viewer.id),
            target_type: Some("exam"),
            target_id: Some(exam_id.to_string()),
            meta: json!({}),
        },
    )
    .await;
    Ok(examcore::ok(results_value(&state, exam_id).await?))
}

async fn verify_certificate(
    State(state): State<AppState>,
    Path(code): Path<String>,
    meta: RequestMeta,
) -> examcore::ApiJson {
    kernel::security::enforce_rate_limit(
        &state.db,
        &format!("verify:{}", meta.ip),
        kernel::security::Limit {
            limit: 30,
            window: std::time::Duration::from_secs(60),
        },
    )
    .await?;
    let Some(canonical) = canonical_verify_code(&code) else {
        return Ok(examcore::ok(
            json!({"valid":false,"revoked":false,"statement":null,"signature":null}),
        ));
    };
    let row = sqlx::query("select statement,statement_hash,signature,key_id,revoked_at from result_certificates where verify_code=$1")
        .bind(canonical).fetch_optional(&state.db).await?;
    let Some(row) = row else {
        return Ok(examcore::ok(
            json!({"valid":false,"revoked":false,"statement":null,"signature":null}),
        ));
    };
    let statement: Value = row.try_get("statement")?;
    let stored_hash: Vec<u8> = row.try_get("statement_hash")?;
    let signature: Vec<u8> = row.try_get("signature")?;
    let key_id: String = row.try_get("key_id")?;
    let revoked: Option<time::OffsetDateTime> = row.try_get("revoked_at")?;
    let valid = verify_statement(&statement, &stored_hash, &signature);
    let public_statement = json!({
        "certificateId": statement.get("certificateId").and_then(Value::as_str),
        "examTitle": statement.get("examTitle").and_then(Value::as_str),
        "candidate": statement.get("candidate").and_then(Value::as_str),
        "percent": statement.get("percent").and_then(Value::as_f64),
        "passed": statement.get("passed").and_then(Value::as_bool),
        "issuedAt": statement.get("issuedAt"),
        "issuer": statement.get("issuer").and_then(Value::as_str),
    });
    Ok(examcore::ok(
        json!({"valid":valid && revoked.is_none(),"revoked":revoked.is_some(),"statement":public_statement,"signature":{"algorithm":"Ed25519","keyId":key_id,"valid":valid}}),
    ))
}

fn canonical_verify_code(code: &str) -> Option<String> {
    let normalized: String = code
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .map(|character| character.to_ascii_uppercase())
        .take(64)
        .collect();
    let valid_shape = normalized.chars().count() == 12
        && normalized.len() == 12
        && normalized
            .bytes()
            .all(|byte| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&byte));
    if valid_shape {
        Some(format!(
            "{}-{}-{}",
            &normalized[0..4],
            &normalized[4..8],
            &normalized[8..12]
        ))
    } else {
        None
    }
}

fn verify_statement(statement: &Value, stored_hash: &[u8], signature: &[u8]) -> bool {
    let hash = examcore::kernel::crypto::sha256(examcore::canonical_json(statement).as_bytes());
    hash.as_slice() == stored_hash && examcore::signer::verify(stored_hash, signature)
}

async fn candidate_result(
    State(state): State<AppState>,
    CandidateViewer(viewer): CandidateViewer,
    Path(attempt_id): Path<Uuid>,
) -> examcore::ApiJson {
    let row = sqlx::query("select a.exam_id,a.candidate_id,a.total_score::float8 as total_score,a.submitted_at,e.title,e.total_marks::float8 as total_marks,e.pass_marks::float8 as pass_marks,e.results_published_at,e.settings,c.verify_code from attempts a join exams e on e.id=a.exam_id join result_certificates c on c.attempt_id=a.id where a.id=$1 and a.sandbox=false and a.candidate_id=$2 and e.results_published_at is not null and c.revoked_at is null")
        .bind(attempt_id).bind(viewer.id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    let total_score: f64 = row.try_get("total_score")?;
    let total_marks: f64 = row.try_get("total_marks")?;
    let pass_marks: f64 = row.try_get("pass_marks")?;
    let published_at: time::OffsetDateTime = row.try_get("results_published_at")?;
    let settings: Value = row.try_get("settings")?;
    let breakdown = if settings
        .get("showBreakdown")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let answers = sqlx::query("select i.position,i.kind,i.stem,i.marks::float8 as marks,a.response,i.correct,i.options,i.explanation,a.feedback,a.auto_marks::float8 as auto_marks,a.manual_marks::float8 as manual_marks from attempts t join exam_items i on i.id=any(t.item_order) and i.exam_id=t.exam_id left join answers a on a.attempt_id=t.id and a.item_id=i.id where t.id=$1 order by array_position(t.item_order,i.id)")
            .bind(attempt_id).fetch_all(&state.db).await?;
        Some(answers.into_iter().map(|answer| {
            let position: i32 = answer.try_get("position")?;
            let kind: String = answer.try_get("kind")?;
            let stem: String = answer.try_get("stem")?;
            let marks: f64 = answer.try_get("marks")?;
            let response: Option<Value> = answer.try_get("response")?;
            let correct: Value = answer.try_get("correct")?;
            let options: Value = answer.try_get("options")?;
            let explanation: String = answer.try_get("explanation")?;
            let feedback: Option<String> = answer.try_get("feedback")?;
            let auto: Option<f64> = answer.try_get("auto_marks")?;
            let manual: Option<f64> = answer.try_get("manual_marks")?;
            Ok(json!({"position":position,"kind":kind,"stem":stem,"marks":marks,"awarded":manual.or(auto).unwrap_or(0.0),"response":response,"correct":if kind=="written" {Value::Null} else {correct},"options":options,"feedback":feedback.unwrap_or_default(),"explanation":explanation}))
        }).collect::<Result<Vec<_>, sqlx::Error>>()?)
    } else {
        None
    };
    let title: String = row.try_get("title")?;
    let submitted_at: Option<time::OffsetDateTime> = row.try_get("submitted_at")?;
    let verify_code: String = row.try_get("verify_code")?;
    Ok(examcore::ok(
        json!({"attemptId":attempt_id,"examTitle":title,"totalMarks":total_marks,"passMarks":pass_marks,"totalScore":total_score,"percent":round2(total_score/total_marks*100.0),"passed":total_score>=pass_marks,"submittedAt":examcore::ts(submitted_at),"publishedAt":examcore::ts(published_at),"verifyCode":verify_code,"breakdown":breakdown}),
    ))
}

async fn attempt_report(
    State(state): State<AppState>,
    viewer: examcore::Viewer,
    Path(attempt_id): Path<Uuid>,
) -> examcore::ApiJson {
    let row = sqlx::query("select a.exam_id,a.candidate_id,a.status,a.sandbox,a.total_score::float8 as total_score,a.submitted_at,u.display_name,e.title,e.total_marks::float8 as total_marks,e.pass_marks::float8 as pass_marks,e.results_published_at,e.settings,c.verify_code,c.revoked_at from attempts a join users u on u.id=a.candidate_id join exams e on e.id=a.exam_id left join result_certificates c on c.attempt_id=a.id and c.revoked_at is null where a.id=$1")
        .bind(attempt_id).fetch_optional(&state.db).await?.ok_or_else(AppError::not_found)?;
    let exam_id: Uuid = row.try_get("exam_id")?;
    let candidate_id: Uuid = row.try_get("candidate_id")?;
    let is_owner: bool = sqlx::query_scalar(
        "select exists(select 1 from exams where id=$1 and (owner_id=$2 or $3))",
    )
    .bind(exam_id)
    .bind(viewer.id)
    .bind(viewer.is_admin())
    .fetch_one(&state.db)
    .await?;
    let published: Option<time::OffsetDateTime> = row.try_get("results_published_at")?;
    let revoked: Option<time::OffsetDateTime> = row.try_get("revoked_at")?;
    if !is_owner && (candidate_id != viewer.id || published.is_none() || revoked.is_some()) {
        return Err(AppError::not_found());
    }
    if row.try_get::<bool, _>("sandbox")? {
        return Err(AppError::not_found());
    }
    let settings: Value = row.try_get("settings")?;
    let show_breakdown = settings
        .get("showBreakdown")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let items = if should_include_attempt_report_breakdown(is_owner, show_breakdown) {
        let questions = sqlx::query("select i.position,i.stem,i.marks::float8 as marks,a.auto_marks::float8 as auto_marks,a.manual_marks::float8 as manual_marks,a.feedback from attempts t join exam_items i on i.id=any(t.item_order) and i.exam_id=t.exam_id left join answers a on a.attempt_id=t.id and a.item_id=i.id where t.id=$1 order by array_position(t.item_order,i.id)")
            .bind(attempt_id).fetch_all(&state.db).await?;
        questions.into_iter().map(|answer| {
            let position: i32 = answer.try_get("position")?;
            let stem: String = answer.try_get("stem")?;
            let marks: f64 = answer.try_get("marks")?;
            let awarded = answer.try_get::<Option<f64>,_>("manual_marks")?.or(answer.try_get("auto_marks")?).unwrap_or(0.0);
            let feedback: Option<String> = answer.try_get("feedback")?;
            Ok(json!({"position":position,"stem":stem,"marks":marks,"awarded":awarded,"feedback":feedback.unwrap_or_default()}))
        }).collect::<Result<Vec<_>, sqlx::Error>>()?
    } else {
        Vec::new()
    };
    let display_name: String = row.try_get("display_name")?;
    let title: String = row.try_get("title")?;
    let total_marks: f64 = row.try_get("total_marks")?;
    let pass_marks: f64 = row.try_get("pass_marks")?;
    let total_score: Option<f64> = row.try_get("total_score")?;
    let total_score = total_score.ok_or_else(AppError::not_found)?;
    let submitted_at: Option<time::OffsetDateTime> = row.try_get("submitted_at")?;
    let verify_code: Option<String> = row.try_get("verify_code")?;
    if !is_owner && verify_code.is_none() {
        return Err(AppError::not_found());
    }
    let code = verify_code.unwrap_or_default();
    Ok(examcore::ok(
        json!({"attemptId":attempt_id,"candidate":display_name,"examTitle":title,"date":submitted_at,"score":total_score,"totalMarks":total_marks,"percent":round2(total_score/total_marks*100.0),"passed":total_score>=pass_marks,"items":items,"verifyCode":code,"verifyUrl":format!("{}/verify/{}",state.config.app_origin,code)}),
    ))
}

fn should_include_attempt_report_breakdown(is_owner: bool, show_breakdown: bool) -> bool {
    is_owner || show_breakdown
}

async fn exam_report(
    State(state): State<AppState>,
    ExaminerViewer(viewer): ExaminerViewer,
    Path(exam_id): Path<Uuid>,
) -> examcore::ApiJson {
    load_exam_for_examiner(&state.db, &viewer, exam_id).await?;
    let mut report = results_value(&state, exam_id).await?;
    let rows = report
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let scores: Vec<f64> = rows
        .iter()
        .filter_map(|row| row.get("totalScore").and_then(Value::as_f64))
        .collect();
    let mut sorted = scores.clone();
    sorted.sort_by(f64::total_cmp);
    let mean = if scores.is_empty() {
        0.0
    } else {
        scores.iter().sum::<f64>() / scores.len() as f64
    };
    let median = match sorted.len() {
        0 => 0.0,
        length if length % 2 == 1 => sorted[length / 2],
        length => (sorted[length / 2 - 1] + sorted[length / 2]) / 2.0,
    };
    let high = sorted.last().copied().unwrap_or(0.0);
    let low = sorted.first().copied().unwrap_or(0.0);
    let total_marks = report
        .get("totalMarks")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let mut distribution = [0_i32; 10];
    for score in &scores {
        let percent = if total_marks > 0.0 {
            score / total_marks * 100.0
        } else {
            0.0
        };
        let bucket = ((percent / 10.0).floor() as usize).min(9);
        distribution[bucket] += 1;
    }
    let passed = rows
        .iter()
        .filter(|row| row.get("passed").and_then(Value::as_bool) == Some(true))
        .count();
    let item_rows = sqlx::query("select i.id,i.position,i.stem,i.marks::float8 as marks,count(distinct t.id)::int as responses,coalesce(sum(coalesce(a.manual_marks,a.auto_marks)),0)::float8 as awarded from exam_items i left join attempts t on t.exam_id=i.exam_id and not t.sandbox and t.status<>'in_progress' left join answers a on a.item_id=i.id and a.attempt_id=t.id where i.exam_id=$1 and not i.sandbox group by i.id order by i.position")
        .bind(exam_id).fetch_all(&state.db).await?;
    let facilities = item_rows.into_iter().map(|item| {
        let item_id: Uuid = item.try_get("id")?;
        let position: i32 = item.try_get("position")?;
        let stem: String = item.try_get("stem")?;
        let marks: f64 = item.try_get("marks")?;
        let responses: i32 = item.try_get("responses")?;
        let awarded: f64 = item.try_get("awarded")?;
        let facility = if responses == 0 { 0.0 } else { awarded / (f64::from(responses) * marks) };
        Ok(json!({"itemId":item_id,"position":position,"stem":stem,"marks":marks,"responses":responses,"facility":round2(facility)}))
    }).collect::<Result<Vec<_>, sqlx::Error>>()?;
    report["summary"] = json!({"count":scores.len(),"mean":round2(mean),"median":round2(median),"highest":high,"lowest":low,"passRate":if rows.is_empty(){0.0}else{round2(passed as f64/rows.len() as f64*100.0)}});
    report["distribution"] = json!(
        distribution
            .iter()
            .enumerate()
            .map(|(index, count)| json!({"from":index*10,"to":(index+1)*10,"count":count}))
            .collect::<Vec<_>>()
    );
    report["itemSummary"] = json!(facilities);
    Ok(examcore::ok(report))
}

/// Recalculate an attempt's objective and written scores from its frozen paper.
/// Safe to call repeatedly; manual marks are preserved and objective marks are replaced.
pub async fn autograde_attempt(conn: &mut PgConnection, attempt_id: Uuid) -> AppResult<()> {
    let order: Option<Vec<Uuid>> =
        sqlx::query_scalar("select item_order from attempts where id = $1")
            .bind(attempt_id)
            .fetch_optional(&mut *conn)
            .await?;
    let order = order.ok_or_else(AppError::not_found)?;

    let mut auto_score = 0.0_f64;
    let mut manual_score = 0.0_f64;
    let mut written_count = 0_i64;
    let mut graded_count = 0_i64;

    for item_id in order {
        let row = sqlx::query(
            "select i.kind, i.correct, i.options, i.marks::float8 as marks, \
                    i.negative_marks::float8 as negative_marks, i.multi_rule, \
                    a.response, a.manual_marks::float8 as manual_marks \
             from exam_items i left join answers a on a.item_id = i.id and a.attempt_id = $1 \
             where i.id = $2",
        )
        .bind(attempt_id)
        .bind(item_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(AppError::not_found)?;

        let kind: String = row.try_get("kind")?;
        if kind == "written" {
            written_count += 1;
            let manual_marks: Option<f64> = row.try_get("manual_marks")?;
            if let Some(marks) = manual_marks {
                graded_count += 1;
                manual_score += marks;
            }
            continue;
        }

        let correct: Vec<String> = serde_json::from_value(row.try_get("correct")?)
            .map_err(|_| AppError::internal("Stored answer key is invalid."))?;
        let options: Value = row.try_get("options")?;
        let option_count = options.as_array().map_or(0, Vec::len);
        let response: Option<Value> = row.try_get("response")?;
        let selected = response
            .as_ref()
            .and_then(|value| value.get("selected"))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let scheme = MarkingScheme {
            kind,
            correct,
            option_count,
            marks: row.try_get("marks")?,
            negative_marks: row.try_get("negative_marks")?,
            multi_rule: row.try_get("multi_rule")?,
        };
        let marks = score_objective(&scheme, &selected).unwrap_or(0.0);
        sqlx::query("update answers set auto_marks = $3 where attempt_id = $1 and item_id = $2")
            .bind(attempt_id)
            .bind(item_id)
            .bind(marks)
            .execute(&mut *conn)
            .await?;
        auto_score += marks;
    }

    let status = if written_count == 0 || graded_count == written_count {
        "complete"
    } else if graded_count > 0 {
        "partial"
    } else {
        "pending"
    };
    let total_score = round2((auto_score + manual_score).max(0.0));
    sqlx::query(
        "update attempts set auto_score = $2, manual_score = $3, total_score = $4, \
         grading_status = $5, updated_at = now() where id = $1",
    )
    .bind(attempt_id)
    .bind(round2(auto_score))
    .bind(round2(manual_score))
    .bind(total_score)
    .bind(status)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;
    use examcore::kernel::crypto::sha256;
    use serde_json::json;

    #[test]
    fn grade_requires_range_and_quarter_steps() {
        assert!(valid_grade(0.0, 2.0));
        assert!(valid_grade(1.25, 2.0));
        assert!(!valid_grade(2.25, 2.0));
        assert!(!valid_grade(0.3, 2.0));
        assert!(!valid_grade(f64::NAN, 2.0));
    }

    #[test]
    fn certificate_signature_detects_statement_tampering() {
        let statement = json!({"candidate":"A. B****n","percent":82.5});
        let hash = sha256(examcore::canonical_json(&statement).as_bytes());
        let (signature, _) = examcore::signer::sign(&hash);
        assert!(verify_statement(&statement, &hash, &signature));
        let tampered = json!({"candidate":"A. B****n","percent":92.5});
        assert!(!verify_statement(&tampered, &hash, &signature));
    }

    #[test]
    fn malformed_unicode_verification_codes_do_not_slice_or_panic() {
        assert_eq!(
            canonical_verify_code("abcd efgh jkmp"),
            Some("ABCD-EFGH-JKMP".to_owned())
        );
        assert_eq!(canonical_verify_code("éééééééééééé"), None);
        assert_eq!(canonical_verify_code("ABCD-EFGH-JKPU"), None);
        assert_eq!(canonical_verify_code("ABCD-EFGH-JK"), None);
    }

    #[test]
    fn successful_json_payloads_use_data_envelope() {
        let response = examcore::ok(json!({"count":3}));
        assert_eq!(response.0, json!({"data":{"count":3}}));
    }

    #[test]
    fn candidate_report_breakdown_obeys_exam_setting_and_owner_access() {
        assert!(!should_include_attempt_report_breakdown(false, false));
        assert!(should_include_attempt_report_breakdown(false, true));
        assert!(should_include_attempt_report_breakdown(true, false));
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn autograde_scores_multiselect_and_is_idempotent(
        db: sqlx::PgPool,
    ) -> Result<(), sqlx::Error> {
        let owner: Uuid = sqlx::query_scalar("insert into users(email,role) values('grading-owner@example.test','examiner') returning id")
            .fetch_one(&db).await?;
        let candidate: Uuid = sqlx::query_scalar(
            "insert into users(email) values('grading-candidate@example.test') returning id",
        )
        .fetch_one(&db)
        .await?;
        let exam_id: Uuid = sqlx::query_scalar("insert into exams(owner_id,title,starts_at,ends_at,duration_minutes,total_marks,pass_marks) values($1,'Grading test',now()-interval '1 day',now()+interval '1 day',60,4,2) returning id")
            .bind(owner).fetch_one(&db).await?;
        let item_id: Uuid = sqlx::query_scalar("insert into exam_items(exam_id,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule) values($1,0,'test',1,'multi','Select all', '[{\"id\":\"a\"},{\"id\":\"b\"},{\"id\":\"c\"}]','[\"a\",\"b\"]',4,1,'partial') returning id")
            .bind(exam_id).fetch_one(&db).await?;
        let attempt_id: Uuid = sqlx::query_scalar("insert into attempts(exam_id,candidate_id,status,finalized_by,deadline_at,seed,item_order,journal_genesis) values($1,$2,'submitted','candidate',now(),1,$3,$4) returning id")
            .bind(exam_id).bind(candidate).bind(vec![item_id]).bind(vec![0_u8;32]).fetch_one(&db).await?;
        sqlx::query("insert into answers(attempt_id,item_id,response,client_seq) values($1,$2,'{\"selected\":[\"a\"]}',1)")
            .bind(attempt_id).bind(item_id).execute(&db).await?;
        let mut tx = db.begin().await?;
        autograde_attempt(&mut tx, attempt_id)
            .await
            .map_err(|_| sqlx::Error::Protocol("autograde failed".into()))?;
        tx.commit().await?;
        let first: (f64, f64, String) = sqlx::query_as("select auto_score::float8,total_score::float8,grading_status from attempts where id=$1")
            .bind(attempt_id).fetch_one(&db).await?;
        assert_eq!(first, (2.0, 2.0, "complete".to_owned()));
        let mut tx = db.begin().await?;
        autograde_attempt(&mut tx, attempt_id)
            .await
            .map_err(|_| sqlx::Error::Protocol("autograde failed".into()))?;
        tx.commit().await?;
        let second: (f64, f64, String) = sqlx::query_as("select auto_score::float8,total_score::float8,grading_status from attempts where id=$1")
            .bind(attempt_id).fetch_one(&db).await?;
        assert_eq!(first, second);
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn verification_rejects_statement_tampered_in_database(
        db: sqlx::PgPool,
    ) -> Result<(), sqlx::Error> {
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('certificate-owner@example.test','examiner') returning id",
        )
        .fetch_one(&db)
        .await?;
        let candidate: Uuid = sqlx::query_scalar(
            "insert into users(email) values('certificate-candidate@example.test') returning id",
        )
        .fetch_one(&db)
        .await?;
        let exam_id: Uuid = sqlx::query_scalar(
            "insert into exams(owner_id,title,starts_at,ends_at,duration_minutes,total_marks,pass_marks) values($1,'Certificate test',now()-interval '1 day',now()+interval '1 day',60,10,5) returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await?;
        let attempt_id: Uuid = sqlx::query_scalar(
            "insert into attempts(exam_id,candidate_id,status,finalized_by,deadline_at,seed,item_order,journal_genesis,total_score,grading_status) values($1,$2,'submitted','candidate',now(),1,'{}',$3,8,'complete') returning id",
        )
        .bind(exam_id)
        .bind(candidate)
        .bind(vec![0_u8; 32])
        .fetch_one(&db)
        .await?;
        let statement = json!({"certificateId":"ABCD-EFGH-JKMP","examTitle":"Certificate test","candidate":"C. C****e","percent":80.0,"passed":true,"issuedAt":"2026-11-27T00:00:00Z","issuer":"Inventix Invigil"});
        let hash = sha256(examcore::canonical_json(&statement).as_bytes());
        let (signature, key_id) = examcore::signer::sign(&hash);
        sqlx::query("insert into result_certificates(attempt_id,verify_code,statement,statement_hash,signature,key_id) values($1,'ABCD-EFGH-JKMP',$2,$3,$4,$5)")
            .bind(attempt_id)
            .bind(&statement)
            .bind(hash.to_vec())
            .bind(signature.to_vec())
            .bind(key_id)
            .execute(&db)
            .await?;
        let stored = sqlx::query("select statement,statement_hash,signature from result_certificates where attempt_id=$1")
            .bind(attempt_id)
            .fetch_one(&db)
            .await?;
        assert!(verify_statement(
            &stored.try_get("statement")?,
            &stored.try_get::<Vec<u8>, _>("statement_hash")?,
            &stored.try_get::<Vec<u8>, _>("signature")?,
        ));
        sqlx::query("update result_certificates set statement=jsonb_set(statement,'{percent}','99'::jsonb) where attempt_id=$1")
            .bind(attempt_id)
            .execute(&db)
            .await?;
        let tampered = sqlx::query("select statement,statement_hash,signature from result_certificates where attempt_id=$1")
            .bind(attempt_id)
            .fetch_one(&db)
            .await?;
        assert!(!verify_statement(
            &tampered.try_get("statement")?,
            &tampered.try_get::<Vec<u8>, _>("statement_hash")?,
            &tampered.try_get::<Vec<u8>, _>("signature")?,
        ));
        sqlx::query("update result_certificates set revoked_at=now(),issued_at=now()-interval '1 day' where attempt_id=$1")
            .bind(attempt_id)
            .execute(&db)
            .await?;
        let mut tx = db.begin().await?;
        let reissued_code = issue_certificate(
            &mut tx,
            attempt_id,
            "Certificate test",
            "Candidate Name",
            8.0,
            10.0,
            5.0,
        )
        .await
        .map_err(|_| sqlx::Error::Protocol("certificate reissue failed".into()))?;
        tx.commit().await?;
        assert_eq!(reissued_code, "ABCD-EFGH-JKMP");
        let reissued = sqlx::query("select verify_code,statement,statement_hash,signature,revoked_at,issued_at from result_certificates where attempt_id=$1")
            .bind(attempt_id)
            .fetch_one(&db)
            .await?;
        assert_eq!(
            reissued.try_get::<Option<time::OffsetDateTime>, _>("revoked_at")?,
            None
        );
        assert!(
            reissued.try_get::<time::OffsetDateTime, _>("issued_at")?
                > time::OffsetDateTime::now_utc() - time::Duration::minutes(1)
        );
        assert!(verify_statement(
            &reissued.try_get("statement")?,
            &reissued.try_get::<Vec<u8>, _>("statement_hash")?,
            &reissued.try_get::<Vec<u8>, _>("signature")?,
        ));
        assert_eq!(
            reissued.try_get::<String, _>("verify_code")?,
            "ABCD-EFGH-JKMP"
        );
        Ok(())
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn publishing_is_blocked_for_live_and_ungraded_attempts(
        db: sqlx::PgPool,
    ) -> Result<(), sqlx::Error> {
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email,role) values('publish-owner@example.test','examiner') returning id",
        )
        .fetch_one(&db)
        .await?;
        let candidate: Uuid = sqlx::query_scalar(
            "insert into users(email) values('publish-candidate@example.test') returning id",
        )
        .fetch_one(&db)
        .await?;
        let exam_id: Uuid = sqlx::query_scalar(
            "insert into exams(owner_id,title,starts_at,ends_at,duration_minutes,total_marks,pass_marks) values($1,'Publish test',now()-interval '2 days',now()-interval '1 day',60,10,5) returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await?;
        sqlx::query("insert into attempts(exam_id,candidate_id,deadline_at,seed,item_order,journal_genesis) values($1,$2,now(),1,'{}',$3)")
            .bind(exam_id)
            .bind(candidate)
            .bind(vec![0_u8; 32])
            .execute(&db)
            .await?;
        let mut conn = db.acquire().await?;
        let blockers = publication_blockers(&mut conn, exam_id)
            .await
            .map_err(|_| sqlx::Error::Protocol("blocker check failed".into()))?;
        assert!(blockers.iter().any(|reason| reason.contains("in progress")));
        assert!(
            blockers
                .iter()
                .any(|reason| reason.contains("fully graded"))
        );
        let statement = json!({"certificateId":"ZXCV-1234-5678","examTitle":"Publish test"});
        let hash = sha256(examcore::canonical_json(&statement).as_bytes());
        let (signature, key_id) = examcore::signer::sign(&hash);
        let attempt_id: Uuid = sqlx::query_scalar("select id from attempts where exam_id=$1")
            .bind(exam_id)
            .fetch_one(&db)
            .await?;
        sqlx::query("insert into result_certificates(attempt_id,verify_code,statement,statement_hash,signature,key_id) values($1,'ZXCV-1234-5678',$2,$3,$4,$5)")
            .bind(attempt_id)
            .bind(statement)
            .bind(hash.to_vec())
            .bind(signature.to_vec())
            .bind(key_id)
            .execute(&db)
            .await?;
        let visible: bool = sqlx::query_scalar("select exists(select 1 from attempts a join exams e on e.id=a.exam_id join result_certificates c on c.attempt_id=a.id where a.id=$1 and a.candidate_id=$2 and not a.sandbox and e.results_published_at is not null and c.revoked_at is null)")
            .bind(attempt_id)
            .bind(candidate)
            .fetch_one(&db)
            .await?;
        assert!(
            !visible,
            "candidate must not see a certificate before publication"
        );
        Ok(())
    }
}
