//! Exam authoring and lifecycle endpoints.
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post, put},
};
use examcore::{
    ExaminerViewer, invalid, invalid_many,
    kernel::{
        AppError, AppResult, AppState,
        request::RequestMeta,
        security::{self, AuditEntry},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExamSettings {
    #[serde(default = "yes")]
    pub shuffle_questions: bool,
    #[serde(default = "yes")]
    pub shuffle_options: bool,
    #[serde(default = "yes")]
    pub allow_offline_journal: bool,
    #[serde(default)]
    pub late_join_minutes: Option<i32>,
    #[serde(default = "yes")]
    pub show_breakdown: bool,
    #[serde(default)]
    pub integrity: Integrity,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Integrity {
    #[serde(default = "yes")]
    pub watermark: bool,
    #[serde(default)]
    pub canary: bool,
    #[serde(default = "yes")]
    pub fullscreen: bool,
}
impl Default for Integrity {
    fn default() -> Self {
        Self {
            watermark: true,
            canary: false,
            fullscreen: true,
        }
    }
}
fn yes() -> bool {
    true
}
impl Default for ExamSettings {
    fn default() -> Self {
        Self {
            shuffle_questions: true,
            shuffle_options: true,
            allow_offline_journal: true,
            late_join_minutes: None,
            show_breakdown: true,
            integrity: Integrity {
                watermark: true,
                canary: false,
                fullscreen: true,
            },
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExamInput {
    pub title: String,
    pub instructions: String,
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub ends_at: OffsetDateTime,
    pub duration_minutes: i32,
    pub total_marks: f64,
    pub pass_marks: f64,
    #[serde(default)]
    pub settings: ExamSettings,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExamPatch {
    pub title: Option<String>,
    pub instructions: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub starts_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub ends_at: Option<OffsetDateTime>,
    pub duration_minutes: Option<i32>,
    pub total_marks: Option<f64>,
    pub pass_marks: Option<f64>,
    pub settings: Option<ExamSettings>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignInput {
    pub items: Vec<AssignItem>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignItem {
    pub question_id: Uuid,
    pub marks: Option<f64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    status: Option<String>,
    cursor: Option<Uuid>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ForceQuery {
    #[serde(default)]
    force: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/exams", get(list).post(create))
        .route("/exams/{id}", get(get_exam).patch(update).delete(remove))
        .route("/exams/{id}/questions", put(assign))
        .route("/exams/{id}/review", get(review))
        .route(
            "/exams/{id}/blueprint",
            get(get_blueprint).put(put_blueprint),
        )
        .route("/exams/{id}/blueprint/preview", get(blueprint_preview))
        .route("/exams/{id}/fairness", get(fairness))
        .route("/exams/{id}/publish", post(publish))
        .route("/exams/{id}/unpublish", post(unpublish))
        .route("/exams/{id}/complete", post(complete))
        .route("/exams/{id}/duplicate", post(duplicate))
        .route("/exams/{id}/sandbox", post(sandbox))
}

fn validate(i: &ExamInput) -> AppResult<()> {
    let mut e = Vec::new();
    if !(1..=160).contains(&i.title.trim().chars().count()) {
        e.push((
            "title".into(),
            "Title must contain 1 to 160 characters.".into(),
        ));
    }
    if i.instructions.chars().count() > 8000 {
        e.push(("instructions".into(), "Instructions are too long.".into()));
    }
    let window = (i.ends_at - i.starts_at).whole_seconds();
    if window <= 0 {
        e.push(("endsAt".into(), "End must be after start.".into()));
    }
    if !(1..=1440).contains(&i.duration_minutes) || i64::from(i.duration_minutes) * 60 > window {
        e.push((
            "durationMinutes".into(),
            "Duration must fit within the exam window.".into(),
        ));
    }
    if !i.total_marks.is_finite() || i.total_marks <= 0.0 || i.total_marks > 100000.0 {
        e.push((
            "totalMarks".into(),
            "Total marks must be greater than 0 and at most 100000.".into(),
        ));
    }
    if !i.pass_marks.is_finite() || i.pass_marks < 0.0 || i.pass_marks > i.total_marks {
        e.push((
            "passMarks".into(),
            "Pass marks must be between 0 and total marks.".into(),
        ));
    }
    if let Some(m) = i.settings.late_join_minutes
        && !(0..=1440).contains(&m)
    {
        e.push((
            "settings.lateJoinMinutes".into(),
            "Must be between 0 and 1440.".into(),
        ));
    }
    if e.is_empty() {
        Ok(())
    } else {
        Err(invalid_many(e))
    }
}
fn settings(v: Value) -> ExamSettings {
    serde_json::from_value(v).unwrap_or_default()
}
fn dto(
    exam: examcore::ExamRow,
    instructions: String,
    q: Value,
    enrolled: i64,
    attempts: i64,
    updated: OffsetDateTime,
) -> Value {
    let now = examcore::now();
    let phase = examcore::phase(&exam.status, exam.starts_at, exam.ends_at, now);
    json!({"id":exam.id,"title":exam.title,"status":exam.status,"phase":phase,"startsAt":examcore::iso(exam.starts_at),"endsAt":examcore::iso(exam.ends_at),"durationMinutes":exam.duration_minutes,"totalMarks":exam.total_marks,"questionCount":q.as_array().map_or(0,Vec::len),"enrolledCount":enrolled,"attemptCount":attempts,"resultsPublishedAt":examcore::iso_opt(exam.results_published_at),"updatedAt":examcore::iso(updated),"instructions":instructions,"passMarks":exam.pass_marks,"settings":settings(exam.settings),"version":exam.version,"questions":q})
}
pub async fn create_exam_tx(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    input: &ExamInput,
) -> AppResult<Uuid> {
    validate(input)?;
    let id:Uuid=sqlx::query_scalar("insert into exams(owner_id,title,instructions,starts_at,ends_at,duration_minutes,total_marks,pass_marks,settings) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id").bind(owner).bind(input.title.trim()).bind(&input.instructions).bind(input.starts_at).bind(input.ends_at).bind(input.duration_minutes).bind(input.total_marks).bind(input.pass_marks).bind(serde_json::to_value(&input.settings).map_err(AppError::internal)?).fetch_one(&mut **tx).await?;
    Ok(id)
}
pub async fn assign_tx(
    tx: &mut Transaction<'_, Postgres>,
    exam: Uuid,
    items: &[AssignItem],
    viewer: Uuid,
    admin: bool,
) -> AppResult<()> {
    let status: Option<String> =
        sqlx::query_scalar("select status from exams where id=$1 for update")
            .bind(exam)
            .fetch_optional(&mut **tx)
            .await?;
    if status.as_deref() != Some("draft") {
        return Err(examcore::conflict(
            "state",
            "Questions can only be assigned to a draft.",
        ));
    }
    if items.len() > 200 {
        return Err(invalid("items", "At most 200 questions may be assigned."));
    }
    let mut seen = std::collections::HashSet::new();
    for it in items {
        if !seen.insert(it.question_id) {
            return Err(invalid("items", "Question assignments must be unique."));
        }
        if it
            .marks
            .is_some_and(|m| !m.is_finite() || m <= 0.0 || m > 1000.0)
        {
            return Err(invalid(
                "items.marks",
                "Marks must be greater than 0 and at most 1000.",
            ));
        }
        let owner: Option<Uuid> =
            sqlx::query_scalar("select owner_id from questions where id=$1 and deleted_at is null")
                .bind(it.question_id)
                .fetch_optional(&mut **tx)
                .await?;
        if owner.is_none_or(|o| o != viewer && !admin) {
            return Err(AppError::not_found());
        }
    }
    sqlx::query("delete from exam_questions where exam_id=$1")
        .bind(exam)
        .execute(&mut **tx)
        .await?;
    for (i, it) in items.iter().enumerate() {
        sqlx::query(
            "insert into exam_questions(exam_id,question_id,position,marks) values($1,$2,$3,$4)",
        )
        .bind(exam)
        .bind(it.question_id)
        .bind(i as i32)
        .bind(it.marks)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}
pub async fn publish_tx(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> AppResult<()> {
    let state: String = sqlx::query_scalar("select status from exams where id=$1 for update")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    if state == "published" {
        return Ok(());
    }
    if state != "draft" {
        return Err(examcore::conflict(
            "state",
            "Only draft exams can be published.",
        ));
    }
    let (ready,marks_ok):(bool,bool)=sqlx::query_as("select e.ends_at>now() and count(q.id)>0 and count(q.id)=count(eq.question_id) and e.duration_minutes*60<=extract(epoch from(e.ends_at-e.starts_at)) and count(*) filter(where q.kind in ('single','multi') and jsonb_array_length(q.correct)=0)=0, abs(e.total_marks::float8-coalesce(sum(coalesce(eq.marks,q.marks))::float8,0))<0.009 from exams e left join exam_questions eq on eq.exam_id=e.id left join questions q on q.id=eq.question_id and q.deleted_at is null where e.id=$1 group by e.id").bind(id).fetch_one(&mut **tx).await?;
    let bp = sqlx::query("select enabled,rows from exam_blueprints where exam_id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    let mut blueprint_ready = true;
    // With a blueprint the assigned questions are a pool larger than one paper, so the blueprint's marks (not the
    // pool's) must equal the exam total; without one, the assigned marks must.
    let blueprint_enabled = bp.as_ref().is_some_and(|r| r.get::<bool, _>("enabled"));
    if let Some(bp) = bp.filter(|r| r.get::<bool, _>("enabled")) {
        let rows: Vec<BlueprintRow> =
            serde_json::from_value(bp.try_get("rows")?).map_err(AppError::internal)?;
        let total: f64 = sqlx::query_scalar("select total_marks::float8 from exams where id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
        blueprint_ready = !rows.is_empty()
            && (rows
                .iter()
                .map(|r| f64::from(r.count) * r.marks_each)
                .sum::<f64>()
                - total)
                .abs()
                < 0.009;
        let candidate_rows=sqlx::query("select q.id,q.topic,q.difficulty,case when q.observed_count>=5 and q.observed_facility is not null then q.observed_facility else (array[0.85,0.7,0.55,0.4,0.25]::numeric[])[q.difficulty] end::float8 facility from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1")
            .bind(id).fetch_all(&mut **tx).await?;
        let candidates: Vec<BlueprintCandidate> = candidate_rows
            .into_iter()
            .map(|r| BlueprintCandidate {
                topic: r.get("topic"),
                difficulty: i32::from(r.get::<i16, _>("difficulty")),
                facility: r.get("facility"),
            })
            .collect();
        blueprint_ready &= blueprint_assignment(&rows, &candidates, 0).is_some();
    }
    let ready = ready && blueprint_ready && (blueprint_enabled || marks_ok);
    if !ready {
        return Err(examcore::conflict(
            "review",
            "Exam is not ready to publish.",
        ));
    }
    sqlx::query("insert into exam_items(exam_id,question_id,sandbox,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,rubric,max_words,explanation,predicted_facility) select $1,q.id,false,eq.position,q.topic,q.difficulty,q.kind,q.stem,q.options,q.correct,coalesce(eq.marks,q.marks),q.negative_marks,q.multi_rule,q.rubric,q.max_words,q.explanation,case when q.observed_count>=5 and q.observed_facility is not null then q.observed_facility else (array[0.85,0.7,0.55,0.4,0.25]::numeric[])[q.difficulty] end from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1 order by eq.position").bind(id).execute(&mut **tx).await?;
    sqlx::query("update exams set status='published',published_at=now(),version=version+1,updated_at=now() where id=$1").bind(id).execute(&mut **tx).await?;
    Ok(())
}

fn patch_fields_allowed(phase: &str, patch: &ExamPatch) -> bool {
    match phase {
        "draft" => true,
        "scheduled" => {
            patch.starts_at.is_none()
                && patch.duration_minutes.is_none()
                && patch.total_marks.is_none()
                && patch.pass_marks.is_none()
                && patch.settings.is_none()
        }
        _ => {
            patch.starts_at.is_none()
                && patch.duration_minutes.is_none()
                && patch.total_marks.is_none()
                && patch.pass_marks.is_none()
                && patch.settings.is_none()
                && patch.title.is_none()
        }
    }
}

async fn unpublish_tx(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> AppResult<()> {
    let state: String = sqlx::query_scalar("select status from exams where id=$1 for update")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    let attempts: i64 =
        sqlx::query_scalar("select count(*) from attempts where exam_id=$1 and not sandbox")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    if attempts > 0 {
        return Err(examcore::conflict(
            "attempts",
            "An exam with real attempts cannot be unpublished.",
        ));
    }
    if state == "draft" {
        return Ok(());
    }
    if state != "published" {
        return Err(examcore::conflict(
            "state",
            "Only published exams can be unpublished.",
        ));
    }
    sqlx::query("delete from exam_items where exam_id=$1 and not sandbox")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("update exams set status='draft',published_at=null,version=version+1,updated_at=now() where id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn real_attempt_count(db: &PgPool, id: Uuid) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar("select count(*) from attempts where exam_id=$1 and not sandbox")
            .bind(id)
            .fetch_one(db)
            .await?,
    )
}

async fn complete_tx(tx: &mut Transaction<'_, Postgres>, id: Uuid, force: bool) -> AppResult<bool> {
    let row: Option<(String, OffsetDateTime)> = sqlx::query_as(
        "select status,ends_at from exams where id=$1 and deleted_at is null for update",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((status, ends_at)) = row else {
        return Err(AppError::not_found());
    };
    if status == "completed" {
        return Ok(false);
    }
    if status != "published" || (ends_at > examcore::now() && !force) {
        return Err(examcore::conflict(
            "state",
            "The exam window has not closed.",
        ));
    }
    sqlx::query("update exams set status='completed',completed_at=now(),version=version+1,updated_at=now() where id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}

async fn create(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Json(i): Json<ExamInput>,
) -> examcore::ApiJson {
    validate(&i)?;
    let mut tx = s.db.begin().await?;
    let id = create_exam_tx(&mut tx, v.0.id, &i).await?;
    tx.commit().await?;
    audit(&s, &m, v.0.id, "exam.created", id, json!({})).await;
    Ok(examcore::ok(get_data(&s.db, &v.0, id).await?))
}
async fn list(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Query(q): Query<ListQuery>,
) -> examcore::ApiJson {
    if q.status
        .as_deref()
        .is_some_and(|status| !["draft", "published", "completed", "archived"].contains(&status))
    {
        return Err(invalid("status", "Choose a valid exam status."));
    }
    let rows=sqlx::query("select e.id,e.owner_id,e.title,e.status,e.starts_at,e.ends_at,e.duration_minutes,e.total_marks::float8 total_marks,e.updated_at,(select count(*) from exam_questions x join questions q on q.id=x.question_id and q.deleted_at is null where x.exam_id=e.id) question_count,(select count(*) from enrollments x where x.exam_id=e.id and x.status='enrolled') enrolled_count,(select count(*) from attempts x where x.exam_id=e.id and not x.sandbox) attempt_count,e.results_published_at from exams e where e.deleted_at is null and ($1 or e.owner_id=$2) and ($3::text is null or e.status=$3) and ($4::uuid is null or e.id<$4) order by e.id desc limit 101").bind(v.0.is_admin()).bind(v.0.id).bind(q.status).bind(q.cursor).fetch_all(&s.db).await?;
    let mut data:Vec<Value>=rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"title":r.get::<String,_>("title"),"status":r.get::<String,_>("status"),"phase":examcore::phase(r.get::<&str,_>("status"),r.get("starts_at"),r.get("ends_at"),examcore::now()),"startsAt":examcore::iso(r.get::<OffsetDateTime,_>("starts_at")),"endsAt":examcore::iso(r.get::<OffsetDateTime,_>("ends_at")),"durationMinutes":r.get::<i32,_>("duration_minutes"),"totalMarks":r.get::<f64,_>("total_marks"),"questionCount":r.get::<i64,_>("question_count"),"enrolledCount":r.get::<i64,_>("enrolled_count"),"attemptCount":r.get::<i64,_>("attempt_count"),"resultsPublishedAt":examcore::iso_opt(r.get::<Option<OffsetDateTime>,_>("results_published_at")),"updatedAt":examcore::iso(r.get::<OffsetDateTime,_>("updated_at"))})).collect();
    let has_more = data.len() > 100;
    if has_more {
        data.pop();
    }
    let next_cursor = if has_more {
        data.last()
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    Ok(examcore::ok(json!({"items":data,"nextCursor":next_cursor})))
}
async fn get_exam(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    Ok(examcore::ok(get_data(&s.db, &v.0, id).await?))
}
async fn get_data(db: &PgPool, v: &kernel::Viewer, id: Uuid) -> AppResult<Value> {
    let e = examcore::load_exam_for_examiner(db, v, id).await?;
    let rows=sqlx::query("select coalesce(i.question_id,q.id) question_id,i.id item_id,coalesce(i.position,eq.position) position,coalesce(i.marks::float8,eq.marks::float8,q.marks::float8) marks,coalesce(i.topic,q.topic) topic,coalesce(i.difficulty,q.difficulty) difficulty,coalesce(i.kind,q.kind) kind,coalesce(i.stem,q.stem) stem,coalesce(i.options,q.options) options,coalesce(i.correct,q.correct) correct,coalesce(i.negative_marks::float8,q.negative_marks::float8) negative_marks,coalesce(i.multi_rule,q.multi_rule) multi_rule,coalesce(i.rubric,q.rubric) rubric,coalesce(i.max_words,q.max_words) max_words,coalesce(i.explanation,q.explanation) explanation,q.version,q.observed_facility::float8 observed_facility,q.observed_count,q.created_at,q.updated_at,i.created_at item_created_at from exams x left join exam_items i on i.exam_id=x.id and not i.sandbox left join exam_questions eq on x.status='draft' and eq.exam_id=x.id and i.id is null left join questions q on q.id=coalesce(i.question_id,eq.question_id) and (i.id is not null or q.deleted_at is null) where x.id=$1 order by coalesce(i.position,eq.position)").bind(id).fetch_all(db).await?;
    let q:Vec<Value>=rows.iter().filter(|r|r.get::<Option<Uuid>,_>("question_id").is_some()||r.get::<Option<Uuid>,_>("item_id").is_some()).map(|r|{let question_id:Option<Uuid>=r.get("question_id");let object_id=question_id.unwrap_or_else(||r.get("item_id"));let created=r.get::<Option<OffsetDateTime>,_>("created_at").or_else(||r.get::<Option<OffsetDateTime>,_>("item_created_at"));let updated=r.get::<Option<OffsetDateTime>,_>("updated_at").or(created);let (created,updated)=(examcore::iso_opt(created),examcore::iso_opt(updated));json!({"questionId":question_id,"position":r.get::<i32,_>("position"),"marks":r.get::<f64,_>("marks"),"question":{"id":object_id,"topic":r.get::<String,_>("topic"),"difficulty":r.get::<i16,_>("difficulty"),"kind":r.get::<String,_>("kind"),"stem":r.get::<String,_>("stem"),"options":r.get::<Value,_>("options"),"correct":r.get::<Value,_>("correct"),"marks":r.get::<f64,_>("marks"),"negativeMarks":r.get::<f64,_>("negative_marks"),"multiRule":r.get::<String,_>("multi_rule"),"rubric":r.get::<String,_>("rubric"),"maxWords":r.get::<Option<i32>,_>("max_words"),"explanation":r.get::<String,_>("explanation"),"observedFacility":r.get::<Option<f64>,_>("observed_facility"),"observedCount":r.get::<Option<i32>,_>("observed_count").unwrap_or(0),"version":r.get::<Option<i32>,_>("version").unwrap_or(1),"createdAt":examcore::ts(created),"updatedAt":examcore::ts(updated)}})}).collect();
    let enrolled_count: i64 = sqlx::query_scalar(
        "select count(*) from enrollments where exam_id=$1 and status='enrolled'",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    let attempts = real_attempt_count(db, id).await?;
    let ins: String = sqlx::query_scalar("select instructions from exams where id=$1")
        .bind(id)
        .fetch_one(db)
        .await?;
    let updated: OffsetDateTime = sqlx::query_scalar("select updated_at from exams where id=$1")
        .bind(id)
        .fetch_one(db)
        .await?;
    Ok(dto(e, ins, json!(q), enrolled_count, attempts, updated))
}
async fn assign(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
    Json(i): Json<AssignInput>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let mut tx = s.db.begin().await?;
    assign_tx(&mut tx, id, &i.items, v.0.id, v.0.is_admin()).await?;
    tx.commit().await?;
    audit(
        &s,
        &m,
        v.0.id,
        "exam.questions_assigned",
        id,
        json!({"count":i.items.len()}),
    )
    .await;
    Ok(examcore::ok(get_data(&s.db, &v.0, id).await?))
}
async fn update(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(p): Json<ExamPatch>,
) -> examcore::ApiJson {
    let e = examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let version = match h
        .get("if-match")
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.parse::<i32>().ok())
    {
        Some(x) => x,
        None => {
            return Err(AppError::bad_request(
                "A valid If-Match version is required.",
            ));
        }
    };
    if version != e.version {
        return Err(examcore::conflict(
            "version",
            "The exam changed. Reload before editing.",
        ));
    }
    let now = examcore::now();
    let phase = examcore::phase(&e.status, e.starts_at, e.ends_at, now);
    if !patch_fields_allowed(phase, &p) {
        return Err(examcore::conflict(
            "state",
            "These fields cannot be changed in the current exam phase.",
        ));
    }
    let ends = p.ends_at.unwrap_or(e.ends_at);
    if phase != "draft" && ends < e.ends_at {
        return Err(invalid("endsAt", "The exam end may only be extended."));
    }
    let title = p.title.unwrap_or(e.title).trim().to_owned();
    let ins = p.instructions.unwrap_or(
        sqlx::query_scalar("select instructions from exams where id=$1")
            .bind(id)
            .fetch_one(&s.db)
            .await?,
    );
    let duration = p.duration_minutes.unwrap_or(e.duration_minutes);
    let total = p.total_marks.unwrap_or(e.total_marks);
    let pass = p.pass_marks.unwrap_or(e.pass_marks);
    let st = p.starts_at.unwrap_or(e.starts_at);
    let i = ExamInput {
        title: title.clone(),
        instructions: ins.clone(),
        starts_at: st,
        ends_at: ends,
        duration_minutes: duration,
        total_marks: total,
        pass_marks: pass,
        settings: p.settings.unwrap_or_else(|| settings(e.settings.clone())),
    };
    validate(&i)?;
    let result=sqlx::query("update exams set title=$2,instructions=$3,starts_at=$4,ends_at=$5,duration_minutes=$6,total_marks=$7,pass_marks=$8,settings=$9,version=version+1,updated_at=now() where id=$1 and version=$10").bind(id).bind(title).bind(ins).bind(st).bind(ends).bind(duration).bind(total).bind(pass).bind(serde_json::to_value(i.settings).map_err(AppError::internal)?).bind(version).execute(&s.db).await?;
    if result.rows_affected() != 1 {
        return Err(examcore::conflict(
            "version",
            "The exam changed. Reload before editing.",
        ));
    }
    audit(&s, &m, v.0.id, "exam.updated", id, json!({})).await;
    Ok(examcore::ok(get_data(&s.db, &v.0, id).await?))
}
async fn publish(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let mut tx = s.db.begin().await?;
    publish_tx(&mut tx, id).await?;
    tx.commit().await?;
    audit(&s, &m, v.0.id, "exam.published", id, json!({})).await;
    Ok(examcore::ok(get_data(&s.db, &v.0, id).await?))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlueprintRow {
    topic: String,
    min_difficulty: i32,
    max_difficulty: i32,
    count: i32,
    marks_each: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlueprintInput {
    enabled: bool,
    rows: Vec<BlueprintRow>,
    tolerance: f64,
}

#[derive(Clone)]
struct BlueprintCandidate {
    topic: String,
    difficulty: i32,
    facility: f64,
}

fn blueprint_assignment(
    rows: &[BlueprintRow],
    candidates: &[BlueprintCandidate],
    seed: u64,
) -> Option<Vec<(usize, usize)>> {
    if rows.iter().any(|row| row.count < 1)
        || rows.iter().map(|row| row.count as usize).sum::<usize>() > candidates.len()
    {
        return None;
    }
    let mut row_pools = Vec::with_capacity(rows.len());
    let mut slots = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        let mut eligible: Vec<usize> = candidates
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.topic == row.topic
                    && (row.min_difficulty..=row.max_difficulty).contains(&item.difficulty)
            })
            .map(|(index, _)| index)
            .collect();
        examcore::shuffle(
            &mut eligible,
            seed.wrapping_add((row_index as u64).wrapping_mul(0x9e3779b97f4a7c15)),
        );
        if eligible.len() < row.count as usize {
            return None;
        }
        row_pools.push(eligible);
        for _ in 0..row.count {
            slots.push((row_index, row_pools[row_index].clone()));
        }
    }
    if slots.len() > candidates.len() {
        return None;
    }
    let mut order: Vec<usize> = (0..slots.len()).collect();
    order.sort_by_key(|slot| (slots[*slot].1.len(), slots[*slot].0, *slot));
    let mut candidate_slots = vec![None; candidates.len()];
    let mut slot_candidates = vec![None; slots.len()];
    for slot in order {
        let mut seen = vec![false; candidates.len()];
        if !augment_blueprint_slot(
            slot,
            &slots,
            &mut candidate_slots,
            &mut slot_candidates,
            &mut seen,
        ) {
            return None;
        }
    }
    slot_candidates
        .into_iter()
        .enumerate()
        .map(|(slot, candidate)| candidate.map(|candidate| (slots[slot].0, candidate)))
        .collect()
}

fn augment_blueprint_slot(
    slot: usize,
    slots: &[(usize, Vec<usize>)],
    candidate_slots: &mut [Option<usize>],
    slot_candidates: &mut [Option<usize>],
    seen: &mut [bool],
) -> bool {
    for &candidate in &slots[slot].1 {
        if seen[candidate] {
            continue;
        }
        seen[candidate] = true;
        if candidate_slots[candidate].is_none_or(|previous| {
            augment_blueprint_slot(previous, slots, candidate_slots, slot_candidates, seen)
        }) {
            candidate_slots[candidate] = Some(slot);
            slot_candidates[slot] = Some(candidate);
            return true;
        }
    }
    false
}

fn validate_blueprint(input: &BlueprintInput, total: f64) -> AppResult<()> {
    let mut errors = Vec::new();
    if !input.tolerance.is_finite() || !(0.01..=0.3).contains(&input.tolerance) {
        errors.push((
            "tolerance".into(),
            "Tolerance must be between 0.01 and 0.3.".into(),
        ));
    }
    if input.rows.len() > 100 {
        errors.push(("rows".into(), "At most 100 rows are allowed.".into()));
    }
    for (i, row) in input.rows.iter().enumerate() {
        let p = format!("rows[{i}]");
        if row.topic.trim().is_empty() || row.topic.chars().count() > 80 {
            errors.push((
                format!("{p}.topic"),
                "Topic must contain 1 to 80 characters.".into(),
            ));
        }
        if !(1..=5).contains(&row.min_difficulty)
            || !(1..=5).contains(&row.max_difficulty)
            || row.min_difficulty > row.max_difficulty
        {
            errors.push((
                format!("{p}.minDifficulty"),
                "Difficulty bounds must be 1–5 with minimum no greater than maximum.".into(),
            ));
        }
        if !(1..=500).contains(&row.count) {
            errors.push((format!("{p}.count"), "Count must be from 1 to 500.".into()));
        }
        if !row.marks_each.is_finite()
            || row.marks_each <= 0.0
            || row.marks_each > 1000.0
            || (row.marks_each * 4.0 - (row.marks_each * 4.0).round()).abs() > 1e-8
        {
            errors.push((
                format!("{p}.marksEach"),
                "Marks must be positive and in 0.25 steps.".into(),
            ));
        }
    }
    if input.enabled {
        let marks: f64 = input
            .rows
            .iter()
            .map(|r| f64::from(r.count) * r.marks_each)
            .sum();
        if (marks - total).abs() >= 0.009 {
            errors.push((
                "rows".into(),
                "Blueprint marks must equal exam total marks.".into(),
            ));
        }
        if input.rows.is_empty() {
            errors.push((
                "rows".into(),
                "An enabled blueprint needs at least one row.".into(),
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(invalid_many(errors))
    }
}

async fn get_blueprint(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    let e = examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let row = sqlx::query(
        "select enabled,rows,tolerance::float8 tolerance from exam_blueprints where exam_id=$1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await?;
    let payload = row.map(|r| json!({"enabled":r.get::<bool,_>("enabled"),"rows":r.get::<Value,_>("rows"),"tolerance":r.get::<f64,_>("tolerance")})).unwrap_or_else(|| json!({"enabled":false,"rows":[],"tolerance":0.05}));
    let _ = e;
    Ok(examcore::ok(payload))
}

async fn put_blueprint(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
    Json(input): Json<BlueprintInput>,
) -> examcore::ApiJson {
    let e = examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let mut tx = s.db.begin().await?;
    let status: Option<String> = sqlx::query_scalar(
        "select status from exams where id=$1 and deleted_at is null for update",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if status.as_deref() != Some("draft") {
        return Err(examcore::conflict(
            "state",
            "Blueprints can only be changed while the exam is a draft.",
        ));
    }
    validate_blueprint(&input, e.total_marks)?;
    let rows = serde_json::to_value(&input.rows).map_err(AppError::internal)?;
    let topics: Vec<String> = input.rows.iter().map(|r| r.topic.clone()).collect();
    let found: Vec<String> = sqlx::query_scalar("select distinct q.topic from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1 and q.topic=any($2)").bind(id).bind(&topics).fetch_all(&mut *tx).await?;
    if input.rows.iter().any(|r| !found.contains(&r.topic)) {
        return Err(invalid(
            "rows.topic",
            "Each blueprint topic must exist in the exam question pool.",
        ));
    }
    sqlx::query("insert into exam_blueprints(exam_id,enabled,rows,tolerance) values($1,$2,$3,$4) on conflict(exam_id) do update set enabled=excluded.enabled,rows=excluded.rows,tolerance=excluded.tolerance,updated_at=now()")
        .bind(id).bind(input.enabled).bind(rows).bind(input.tolerance).execute(&mut *tx).await?;
    tx.commit().await?;
    audit(
        &s,
        &m,
        v.0.id,
        "exam.blueprint_updated",
        id,
        json!({"enabled":input.enabled}),
    )
    .await;
    Ok(examcore::ok(
        json!({"enabled":input.enabled,"rows":input.rows,"tolerance":input.tolerance}),
    ))
}

async fn blueprint_preview(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let b = sqlx::query(
        "select enabled,rows,tolerance::float8 tolerance from exam_blueprints where exam_id=$1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await?;
    let (enabled, rows, tolerance) = b
        .map(|r| {
            (
                r.get::<bool, _>("enabled"),
                r.get::<Value, _>("rows"),
                r.get::<f64, _>("tolerance"),
            )
        })
        .unwrap_or((false, json!([]), 0.05));
    let spec: Vec<BlueprintRow> = serde_json::from_value(rows).map_err(AppError::internal)?;
    // The pool is the published paper once it exists; while the exam is a draft it is the assigned bank questions,
    // with the same difficulty estimate publish snapshots (observed facility once 5+ answers exist, else declared).
    let pool = sqlx::query(
        "select id,topic,difficulty,predicted_facility::float8 facility from exam_items where exam_id=$1 and not sandbox          union all          select q.id,q.topic,q.difficulty,(case when q.observed_count >= 5 and q.observed_facility is not null then q.observed_facility            else case q.difficulty when 1 then 0.85 when 2 then 0.7 when 3 then 0.55 when 4 then 0.4 else 0.25 end end)::float8 facility          from exam_questions eq join questions q on q.id=eq.question_id          where eq.exam_id=$1 and q.deleted_at is null            and not exists(select 1 from exam_items i where i.exam_id=$1 and not i.sandbox)          order by id",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await?;
    let candidates: Vec<BlueprintCandidate> = pool
        .iter()
        .map(|q| BlueprintCandidate {
            topic: q.get("topic"),
            difficulty: i32::from(q.get::<i16, _>("difficulty")),
            facility: q.get::<Option<f64>, _>("facility").unwrap_or(0.55),
        })
        .collect();
    let mut problems = Vec::new();
    let mut needed = 0usize;
    let mut target_sum = 0.0;
    for row in &spec {
        let matching: Vec<f64> = pool
            .iter()
            .filter(|q| {
                q.get::<String, _>("topic") == row.topic
                    && (row.min_difficulty..=row.max_difficulty)
                        .contains(&i32::from(q.get::<i16, _>("difficulty")))
            })
            .map(|q| q.get::<Option<f64>, _>("facility").unwrap_or(0.55))
            .collect();
        if matching.len() < row.count as usize {
            problems.push(format!(
                "Topic '{}' needs {} items in difficulty {}–{}, but only {} are available.",
                row.topic,
                row.count,
                row.min_difficulty,
                row.max_difficulty,
                matching.len()
            ));
        }
        needed += row.count.max(0) as usize;
        if !matching.is_empty() {
            target_sum +=
                matching.iter().sum::<f64>() / matching.len() as f64 * row.count.max(0) as f64;
        }
    }
    if enabled && problems.is_empty() && blueprint_assignment(&spec, &candidates, 0).is_none() {
        problems.push(
            "Blueprint rows overlap in a way that leaves too few distinct eligible questions."
                .into(),
        );
    }
    let target = if needed == 0 {
        0.0
    } else {
        target_sum / needed as f64
    };
    let mut simulated = Vec::new();
    if enabled && problems.is_empty() {
        for seed in 0..50u64 {
            let mut best_mean = target;
            let mut best_distance = f64::INFINITY;
            for variant in 0..200u64 {
                let Some(assignment) =
                    blueprint_assignment(&spec, &candidates, seed.wrapping_add(variant))
                else {
                    break;
                };
                let mean = assignment
                    .iter()
                    .map(|(_, candidate)| candidates[*candidate].facility)
                    .sum::<f64>()
                    / assignment.len().max(1) as f64;
                let distance = (mean - target).abs();
                if distance < best_distance {
                    best_distance = distance;
                    best_mean = mean;
                }
                if distance <= tolerance {
                    best_mean = mean;
                    break;
                }
            }
            simulated.push(best_mean);
        }
    }
    let spread = if simulated.is_empty() {
        0.0
    } else {
        simulated.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - simulated.iter().copied().fold(f64::INFINITY, f64::min)
    };
    Ok(examcore::ok(
        json!({"feasible":problems.is_empty(),"problems":problems,"poolSize":pool.len(),"paperSize":needed,"totalMarks":spec.iter().map(|r|f64::from(r.count)*r.marks_each).sum::<f64>(),"simulated":simulated,"spread":spread,"fairnessScore":(100.0*(1.0-(spread/0.3).min(1.0))).round()}),
    ))
}

async fn fairness(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let rows = sqlx::query("select a.id,a.predicted_facility::float8 predicted,u.display_name,case when a.total_score is not null then a.total_score::float8/e.total_marks::float8*100 else null end observed from attempts a join users u on u.id=a.candidate_id join exams e on e.id=a.exam_id where a.exam_id=$1 and not a.sandbox and a.predicted_facility is not null order by a.started_at,a.id").bind(id).fetch_all(&s.db).await?;
    let values: Vec<f64> = rows.iter().map(|r| r.get("predicted")).collect();
    let mean = values.iter().sum::<f64>() / values.len().max(1) as f64;
    let spread = if values.is_empty() {
        0.0
    } else {
        values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - values.iter().copied().fold(f64::INFINITY, f64::min)
    };
    let output: Vec<Value> = rows.iter().map(|r|json!({"attemptId":r.get::<Uuid,_>("id"),"candidate":r.get::<String,_>("display_name"),"predictedFacility":r.get::<f64,_>("predicted"),"observedPercent":r.get::<Option<f64>,_>("observed")})).collect();
    Ok(examcore::ok(
        json!({"papers":values.len(),"meanPredicted":mean,"spread":spread,"fairnessScore":(100.0*(1.0-(spread/0.3).min(1.0))).round(),"rows":output}),
    ))
}

async fn review(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let marks:f64=sqlx::query_scalar("select coalesce(sum(coalesce(eq.marks,q.marks)),0)::float8 from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1").bind(id).fetch_one(&s.db).await?;
    let (total,start,end,duration,count,candidates):(f64,OffsetDateTime,OffsetDateTime,i32,i64,i64)=sqlx::query_as("select total_marks::float8,starts_at,ends_at,duration_minutes,(select count(*) from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1),(select count(*) from enrollments where exam_id=$1 and status='enrolled') from exams where id=$1").bind(id).fetch_one(&s.db).await?;
    let missing_keys:i64=sqlx::query_scalar("select count(*) from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1 and q.kind in ('single','multi') and jsonb_array_length(q.correct)=0").bind(id).fetch_one(&s.db).await?;
    let blueprint = sqlx::query(
        "select enabled,rows,tolerance::float8 tolerance from exam_blueprints where exam_id=$1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await?;
    let topic:Value=sqlx::query_scalar("select coalesce(jsonb_agg(jsonb_build_object('topic',topic,'count',count,'marks',marks) order by topic),'[]'::jsonb) from (select q.topic,count(*)::int count,sum(coalesce(eq.marks,q.marks))::float8 marks from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1 group by q.topic) t").bind(id).fetch_one(&s.db).await?;
    let difficulty:Value=sqlx::query_scalar("select coalesce(jsonb_agg(jsonb_build_object('difficulty',difficulty,'count',count) order by difficulty),'[]'::jsonb) from (select q.difficulty,count(*)::int count from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1 group by q.difficulty) t").bind(id).fetch_one(&s.db).await?;
    let bp_enabled = blueprint
        .as_ref()
        .is_some_and(|r| r.get::<bool, _>("enabled"));
    let bp_rows = blueprint
        .as_ref()
        .map(|r| r.get::<Value, _>("rows"))
        .unwrap_or_else(|| json!([]));
    let bp_spec: Vec<BlueprintRow> = serde_json::from_value(bp_rows).map_err(AppError::internal)?;
    let bp_marks: f64 = bp_spec
        .iter()
        .map(|r| f64::from(r.count) * r.marks_each)
        .sum();
    let bp_candidates_rows = sqlx::query("select id,topic,difficulty,facility from (select id,topic,difficulty,predicted_facility::float8 facility from exam_items where exam_id=$1 and not sandbox union all select q.id,q.topic,q.difficulty,(case when q.observed_count>=5 and q.observed_facility is not null then q.observed_facility else (array[0.85,0.7,0.55,0.4,0.25]::numeric[])[q.difficulty] end)::float8 facility from exam_questions eq join questions q on q.id=eq.question_id where eq.exam_id=$1 and q.deleted_at is null and not exists(select 1 from exam_items i where i.exam_id=$1 and not i.sandbox)) p")
        .bind(id).fetch_all(&s.db).await?;
    let bp_candidates: Vec<BlueprintCandidate> = bp_candidates_rows
        .into_iter()
        .map(|r| BlueprintCandidate {
            topic: r.get("topic"),
            difficulty: i32::from(r.get::<i16, _>("difficulty")),
            facility: r.get::<Option<f64>, _>("facility").unwrap_or(0.55),
        })
        .collect();
    let bp_assignment_ok =
        !bp_enabled || blueprint_assignment(&bp_spec, &bp_candidates, 0).is_some();
    let bp_ok = !bp_enabled
        || ((bp_marks - total).abs() < 0.009 && !bp_spec.is_empty() && bp_assignment_ok);
    let checks = json!([{"key":"title","ok":true,"message":"Exam has a title."},{"key":"questions","ok":count>0,"message":format!("Exam has {} questions.",count)},{"key":"marks","ok":bp_enabled||(marks-total).abs()<0.01,"message":if bp_enabled{format!("Question pool holds {} marks; each candidate's paper is drawn by the blueprint.",marks)}else{format!("Assigned marks: {} of {}.",marks,total)}},{"key":"blueprint","ok":bp_ok,"message":if !bp_enabled{"No enabled blueprint.".to_owned()}else if bp_ok{format!("Blueprint marks: {} of {}.",bp_marks,total)}else{format!("Enabled blueprint marks: {} of {}; they must equal the exam total.",bp_marks,total)}},{"key":"window","ok":end>examcore::now(),"message":"The exam window ends in the future."},{"key":"duration","ok":i64::from(duration)*60<=(end-start).whole_seconds(),"message":"The duration fits within the exam window."},{"key":"candidates","ok":candidates>0,"message":format!("{} candidates enrolled.",candidates)},{"key":"objectiveKeys","ok":missing_keys==0,"message":if missing_keys==0{"Objective questions have answer keys.".to_owned()}else{format!("{} objective questions are missing answer keys.",missing_keys)}}]);
    let ready = checks.as_array().is_some_and(|a| {
        a.iter()
            .filter(|c| c["key"] != "candidates")
            .all(|c| c["ok"] == true)
    });
    Ok(examcore::ok(
        json!({"ready":ready,"checks":checks,"marksAssigned":marks,"topicMix":topic,"difficultyMix":difficulty}),
    ))
}
async fn unpublish(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let mut tx = s.db.begin().await?;
    unpublish_tx(&mut tx, id).await?;
    tx.commit().await?;
    audit(&s, &m, v.0.id, "exam.unpublished", id, json!({})).await;
    Ok(examcore::ok(get_data(&s.db, &v.0, id).await?))
}
async fn complete(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
    Query(q): Query<ForceQuery>,
) -> examcore::ApiJson {
    examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let mut tx = s.db.begin().await?;
    let changed = complete_tx(&mut tx, id, q.force).await?;
    tx.commit().await?;
    if changed {
        audit(
            &s,
            &m,
            v.0.id,
            "exam.completed",
            id,
            json!({"forced":q.force}),
        )
        .await;
    }
    Ok(examcore::ok(get_data(&s.db, &v.0, id).await?))
}
async fn duplicate(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    let e = examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    let mut tx = s.db.begin().await?;
    let starts = examcore::now() + Duration::days(1);
    let ends = starts + (e.ends_at - e.starts_at);
    let ins: String = sqlx::query_scalar("select instructions from exams where id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let input = ExamInput {
        title: format!("{} (copy)", e.title),
        instructions: ins,
        starts_at: starts,
        ends_at: ends,
        duration_minutes: e.duration_minutes,
        total_marks: e.total_marks,
        pass_marks: e.pass_marks,
        settings: settings(e.settings),
    };
    let new = create_exam_tx(&mut tx, v.0.id, &input).await?;
    let items: Vec<AssignItem> = sqlx::query_as::<_, (Uuid, Option<f64>)>(
        "select question_id,marks::float8 from exam_questions where exam_id=$1 order by position",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(question_id, marks)| AssignItem { question_id, marks })
    .collect();
    assign_tx(&mut tx, new, &items, v.0.id, v.0.is_admin()).await?;
    tx.commit().await?;
    audit(
        &s,
        &m,
        v.0.id,
        "exam.duplicated",
        new,
        json!({"sourceId":id}),
    )
    .await;
    Ok(examcore::ok(get_data(&s.db, &v.0, new).await?))
}
async fn remove(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    let e = examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    if e.status != "draft" {
        return Err(examcore::conflict("state", "Only drafts can be deleted."));
    }
    sqlx::query("update exams set deleted_at=now(),updated_at=now(),version=version+1 where id=$1")
        .bind(id)
        .execute(&s.db)
        .await?;
    audit(&s, &m, v.0.id, "exam.deleted", id, json!({})).await;
    Ok(examcore::ok(json!({"id":id})))
}
async fn sandbox(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
) -> examcore::ApiJson {
    let e = examcore::load_exam_for_examiner(&s.db, &v.0, id).await?;
    if e.owner_id != v.0.id {
        return Err(AppError::not_found());
    }
    let mut tx = s.db.begin().await?;
    let locked_owner: Option<Uuid> = sqlx::query_scalar(
        "select owner_id from exams where id=$1 and deleted_at is null for update",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if locked_owner != Some(v.0.id) {
        return Err(AppError::not_found());
    }
    sqlx::query("delete from attempts where exam_id=$1 and candidate_id=$2 and sandbox")
        .bind(id)
        .bind(v.0.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from exam_items where exam_id=$1 and sandbox")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if e.status == "draft" {
        sqlx::query("insert into exam_items(exam_id,question_id,sandbox,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,rubric,max_words,explanation) select $1,q.id,true,eq.position,q.topic,q.difficulty,q.kind,q.stem,q.options,q.correct,coalesce(eq.marks,q.marks),q.negative_marks,q.multi_rule,q.rubric,q.max_words,q.explanation from exam_questions eq join questions q on q.id=eq.question_id and q.deleted_at is null where eq.exam_id=$1").bind(id).execute(&mut *tx).await?;
    } else {
        sqlx::query("insert into exam_items(exam_id,question_id,sandbox,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,rubric,max_words,explanation) select exam_id,question_id,true,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,rubric,max_words,explanation from exam_items where exam_id=$1 and not sandbox").bind(id).execute(&mut *tx).await?;
    }
    let item_order: Vec<Uuid> = sqlx::query_scalar(
        "select id from exam_items where exam_id=$1 and sandbox order by position",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let mut rng = rand::rngs::OsRng;
    use rand::RngCore;
    let seed = rng.next_u64();
    let config = settings(e.settings.clone());
    let mut order = item_order;
    if config.shuffle_questions {
        examcore::shuffle(&mut order, seed);
    }
    let option_rows: Vec<(Uuid, Value)> =
        sqlx::query_as("select id,options from exam_items where exam_id=$1 and sandbox")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let mut option_order = serde_json::Map::new();
    for (item, opts) in option_rows {
        let mut ids: Vec<String> = opts
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|o| o.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        if config.shuffle_options {
            let mut item_seed = [0_u8; 8];
            item_seed.copy_from_slice(&item.as_bytes()[..8]);
            examcore::shuffle(&mut ids, seed ^ u64::from_le_bytes(item_seed));
        }
        option_order.insert(item.to_string(), json!(ids));
    }
    let mut genesis = [0u8; 32];
    rng.fill_bytes(&mut genesis);
    let attempt:Uuid=sqlx::query_scalar("insert into attempts(exam_id,candidate_id,sandbox,deadline_at,seed,item_order,option_order,journal_genesis) values($1,$2,true,now()+($3||' minutes')::interval,$4,$5,$6,$7) returning id").bind(id).bind(v.0.id).bind(e.duration_minutes).bind(seed as i64).bind(&order).bind(Value::Object(option_order)).bind(genesis.to_vec()).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    audit(&s, &m, v.0.id, "exam.sandbox_started", id, json!({})).await;
    Ok(examcore::ok(json!({"attemptId":attempt})))
}
async fn audit(
    s: &AppState,
    m: &RequestMeta,
    actor: Uuid,
    action: &'static str,
    id: Uuid,
    meta: Value,
) {
    security::audit(
        &s.db,
        m,
        AuditEntry {
            action,
            actor_id: Some(actor),
            target_type: Some("exam"),
            target_id: Some(id.to_string()),
            meta,
        },
    )
    .await;
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use examcore::kernel::{Viewer, viewer::Role};
    use sqlx::PgPool;

    #[test]
    fn blueprint_validation_enforces_tolerance_marks_and_bounds() {
        let valid = BlueprintInput {
            enabled: true,
            rows: vec![BlueprintRow {
                topic: "algebra".into(),
                min_difficulty: 1,
                max_difficulty: 3,
                count: 2,
                marks_each: 2.5,
            }],
            tolerance: 0.05,
        };
        assert!(validate_blueprint(&valid, 5.0).is_ok());
        assert!(validate_blueprint(&valid, 4.0).is_err());
        let mut invalid = valid.clone();
        invalid.tolerance = 0.5;
        assert!(validate_blueprint(&invalid, 5.0).is_err());
        let mut invalid = valid;
        invalid.rows[0].min_difficulty = 4;
        assert!(validate_blueprint(&invalid, 5.0).is_err());
    }

    async fn fixture(db: &PgPool, total: f64, marks: f64) -> (Uuid, Uuid, Uuid) {
        let owner: Uuid =
            sqlx::query_scalar("insert into users(email,role) values($1,'examiner') returning id")
                .bind(format!("{}@example.test", Uuid::new_v4()))
                .fetch_one(db)
                .await
                .expect("insert examiner");
        let question: Uuid = sqlx::query_scalar(
            "insert into questions(owner_id,topic,difficulty,kind,stem,options,correct,marks) values($1,'algebra',2,'single','Original prompt', $2, $3, $4) returning id",
        )
        .bind(owner)
        .bind(json!([{"id":"a","text":"A"},{"id":"b","text":"B"}]))
        .bind(json!(["a"]))
        .bind(marks)
        .fetch_one(db)
        .await
        .expect("insert question");
        let starts = examcore::now() + Duration::hours(2);
        let input = ExamInput {
            title: "Integration exam".into(),
            instructions: String::new(),
            starts_at: starts,
            ends_at: starts + Duration::hours(2),
            duration_minutes: 60,
            total_marks: total,
            pass_marks: 0.0,
            settings: ExamSettings::default(),
        };
        let mut tx = db.begin().await.expect("begin fixture");
        let exam = create_exam_tx(&mut tx, owner, &input)
            .await
            .expect("create exam");
        assign_tx(
            &mut tx,
            exam,
            &[AssignItem {
                question_id: question,
                marks: None,
            }],
            owner,
            false,
        )
        .await
        .expect("assign question");
        tx.commit().await.expect("commit fixture");
        (owner, exam, question)
    }

    #[test]
    fn settings_defaults_and_rejects_unknown_fields() {
        let parsed: ExamSettings = serde_json::from_value(json!({})).expect("defaults parse");
        assert!(parsed.shuffle_questions && parsed.shuffle_options && parsed.allow_offline_journal);
        assert!(parsed.show_breakdown && parsed.integrity.watermark && parsed.integrity.fullscreen);
        assert!(!parsed.integrity.canary);
        assert!(serde_json::from_value::<ExamSettings>(json!({"unexpected":true})).is_err());
    }

    #[test]
    fn input_validation_rejects_invalid_window_marks_and_late_join() {
        let at = |s: &str| {
            OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                .expect("valid test timestamp")
        };
        let input = ExamInput {
            title: "Exam".into(),
            instructions: String::new(),
            starts_at: at("2026-11-28T10:00:00Z"),
            ends_at: at("2026-11-28T11:00:00Z"),
            duration_minutes: 61,
            total_marks: 10.0,
            pass_marks: 11.0,
            settings: ExamSettings {
                late_join_minutes: Some(1441),
                ..ExamSettings::default()
            },
        };
        assert!(validate(&input).is_err());
    }

    #[test]
    fn patch_rules_restrict_published_exams_by_phase() {
        let title_patch = ExamPatch {
            title: Some("Changed".into()),
            instructions: None,
            starts_at: None,
            ends_at: None,
            duration_minutes: None,
            total_marks: None,
            pass_marks: None,
            settings: None,
        };
        let end_extension = ExamPatch {
            ends_at: Some(examcore::now() + Duration::hours(3)),
            ..empty_patch()
        };
        let total_patch = ExamPatch {
            total_marks: Some(20.0),
            ..empty_patch()
        };
        assert!(patch_fields_allowed("scheduled", &title_patch));
        assert!(!patch_fields_allowed("scheduled", &total_patch));
        assert!(!patch_fields_allowed("ongoing", &title_patch));
        assert!(patch_fields_allowed("ongoing", &end_extension));
    }

    fn empty_patch() -> ExamPatch {
        ExamPatch {
            title: None,
            instructions: None,
            starts_at: None,
            ends_at: None,
            duration_minutes: None,
            total_marks: None,
            pass_marks: None,
            settings: None,
        }
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn publish_rejects_mismatched_marks_and_snapshots_questions(db: PgPool) {
        let (_, blocked_exam, _) = fixture(&db, 10.0, 5.0).await;
        let mut tx = db.begin().await.expect("begin publish");
        let error = publish_tx(&mut tx, blocked_exam)
            .await
            .expect_err("marks mismatch must block publish");
        assert_eq!(error.code, examcore::ErrorCode::Conflict);
        tx.rollback().await.expect("rollback blocked publish");

        let (owner, ready_exam, question) = fixture(&db, 5.0, 5.0).await;
        let mut tx = db.begin().await.expect("begin publish");
        publish_tx(&mut tx, ready_exam)
            .await
            .expect("ready exam publishes");
        tx.commit().await.expect("commit publish");
        let predicted: f64 = sqlx::query_scalar(
            "select predicted_facility::float8 from exam_items where exam_id=$1 and not sandbox",
        )
        .bind(ready_exam)
        .fetch_one(&db)
        .await
        .expect("snapshot predicted facility");
        assert!((predicted - 0.7).abs() < 0.0001);
        let published_version: i32 = sqlx::query_scalar("select version from exams where id=$1")
            .bind(ready_exam)
            .fetch_one(&db)
            .await
            .expect("read published version");
        let mut tx = db.begin().await.expect("begin idempotent publish");
        publish_tx(&mut tx, ready_exam)
            .await
            .expect("already-published exam is idempotent");
        tx.commit().await.expect("commit idempotent publish");
        let item_count: i64 =
            sqlx::query_scalar("select count(*) from exam_items where exam_id=$1 and not sandbox")
                .bind(ready_exam)
                .fetch_one(&db)
                .await
                .expect("count published items");
        let version_after_retry: i32 = sqlx::query_scalar("select version from exams where id=$1")
            .bind(ready_exam)
            .fetch_one(&db)
            .await
            .expect("read idempotent version");
        assert_eq!(item_count, 1);
        assert_eq!(version_after_retry, published_version);
        sqlx::query("update questions set stem='Edited bank prompt' where id=$1")
            .bind(question)
            .execute(&db)
            .await
            .expect("edit bank question");
        let snapshot: String =
            sqlx::query_scalar("select stem from exam_items where exam_id=$1 and not sandbox")
                .bind(ready_exam)
                .fetch_one(&db)
                .await
                .expect("read paper snapshot");
        assert_eq!(snapshot, "Original prompt");
        let viewer = Viewer {
            id: owner,
            session_id: Uuid::new_v4(),
            email: "owner@example.test".into(),
            display_name: "Owner".into(),
            role: Role::Examiner,
            via_cookie: false,
        };
        let exam = get_data(&db, &viewer, ready_exam)
            .await
            .expect("read exam with frozen question");
        assert_eq!(exam["questions"][0]["question"]["stem"], "Original prompt");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn publish_rejects_infeasible_overlapping_blueprint_rows(db: PgPool) {
        let (_, exam, _) = fixture(&db, 5.0, 5.0).await;
        sqlx::query(
            "insert into exam_blueprints(exam_id,enabled,rows,tolerance) values($1,true,$2,0.05)",
        )
        .bind(exam)
        .bind(json!([
            {"topic":"algebra","minDifficulty":2,"maxDifficulty":2,"count":1,"marksEach":2.5},
            {"topic":"algebra","minDifficulty":2,"maxDifficulty":2,"count":1,"marksEach":2.5}
        ]))
        .execute(&db)
        .await
        .expect("save overlapping blueprint");
        let mut tx = db.begin().await.expect("begin publish");
        let error = publish_tx(&mut tx, exam)
            .await
            .expect_err("one item cannot fill two distinct slots");
        assert_eq!(error.code, examcore::ErrorCode::Conflict);
        tx.rollback().await.expect("rollback rejected publish");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn another_examiner_cannot_load_exam_and_unpublish_refuses_real_attempts(db: PgPool) {
        let (_, exam, _) = fixture(&db, 5.0, 5.0).await;
        let other: Uuid =
            sqlx::query_scalar("insert into users(email,role) values($1,'examiner') returning id")
                .bind(format!("{}@example.test", Uuid::new_v4()))
                .fetch_one(&db)
                .await
                .expect("insert other examiner");
        let viewer = Viewer {
            id: other,
            session_id: Uuid::new_v4(),
            email: "other@example.test".into(),
            display_name: "Other".into(),
            role: Role::Examiner,
            via_cookie: false,
        };
        let error = examcore::load_exam_for_examiner(&db, &viewer, exam)
            .await
            .expect_err("another examiner must see 404");
        assert_eq!(error.code, examcore::ErrorCode::NotFound);

        let mut tx = db.begin().await.expect("begin publish");
        publish_tx(&mut tx, exam).await.expect("publish");
        tx.commit().await.expect("commit publish");
        sqlx::query("insert into attempts(exam_id,candidate_id,sandbox,deadline_at,seed,item_order,journal_genesis) values($1,$2,false,now()+interval '1 hour',42,'{}',decode(repeat('00',32),'hex'))")
            .bind(exam)
            .bind(other)
            .execute(&db)
            .await
            .expect("insert real attempt");
        let mut tx = db.begin().await.expect("begin unpublish");
        let error = unpublish_tx(&mut tx, exam)
            .await
            .expect_err("real attempts prevent unpublish");
        assert_eq!(error.code, examcore::ErrorCode::Conflict);
        tx.rollback().await.expect("rollback unpublish");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn sandbox_attempts_do_not_contribute_to_attempt_count(db: PgPool) {
        let (_, exam, _) = fixture(&db, 5.0, 5.0).await;
        let candidate: Uuid =
            sqlx::query_scalar("insert into users(email) values($1) returning id")
                .bind(format!("{}@example.test", Uuid::new_v4()))
                .fetch_one(&db)
                .await
                .expect("insert candidate");
        for sandbox in [true, false] {
            sqlx::query("insert into attempts(exam_id,candidate_id,sandbox,deadline_at,seed,item_order,journal_genesis) values($1,$2,$3,now()+interval '1 hour',42,'{}',decode(repeat('00',32),'hex'))")
                .bind(exam)
                .bind(candidate)
                .bind(sandbox)
                .execute(&db)
                .await
                .expect("insert attempt");
        }
        assert_eq!(
            real_attempt_count(&db, exam).await.expect("count attempts"),
            1
        );
    }
}
