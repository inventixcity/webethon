//! Examiner question bank and all-or-nothing question import.
use axum::{
    Router,
    extract::{Path, Query, State},
    http::{HeaderMap, header},
    routing::{get, post},
};
use examcore::{ExaminerViewer, invalid_many};
use kernel::{
    AppError, AppResult, AppState, ErrorCode,
    extract::{Json, ResponseJson},
    request::RequestMeta,
    security::{AuditEntry, Limit, audit, enforce_rate_limit},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;

pub const SEED_QUESTIONS: &str = include_str!("../seed/questions.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionOption {
    pub id: String,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionInput {
    pub topic: String,
    pub difficulty: i16,
    pub kind: String,
    pub stem: String,
    pub options: Vec<QuestionOption>,
    pub correct: Vec<String>,
    pub marks: f64,
    #[serde(default)]
    pub negative_marks: f64,
    #[serde(default = "default_rule")]
    pub multi_rule: String,
    #[serde(default)]
    pub rubric: String,
    pub max_words: Option<i32>,
    #[serde(default)]
    pub explanation: String,
}
fn default_rule() -> String {
    "all_or_nothing".into()
}
#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: Uuid,
    pub topic: String,
    pub difficulty: i16,
    pub kind: String,
    pub stem: String,
    pub options: Value,
    pub correct: Value,
    pub marks: f64,
    pub negative_marks: f64,
    pub multi_rule: String,
    pub rubric: String,
    pub max_words: Option<i32>,
    pub explanation: String,
    pub observed_facility: Option<f64>,
    pub observed_count: i32,
    pub version: i32,
    pub created_at: time::OffsetDateTime,
    pub updated_at: time::OffsetDateTime,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    rows: Vec<Value>,
    #[serde(default)]
    dry_run: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RowError {
    row: usize,
    path: String,
    message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    dry_run: bool,
    created: usize,
    updated: usize,
    errors: Vec<RowError>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    topic: Option<String>,
    difficulty: Option<i16>,
    kind: Option<String>,
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}
fn validate(i: &QuestionInput) -> Vec<(String, String)> {
    let mut e = Vec::new();
    let chars = |s: &str| s.chars().count();
    if i.topic.trim() != i.topic || !(1..=80).contains(&chars(&i.topic)) {
        e.push(("topic".into(), "Use 1–80 trimmed characters.".into()))
    }
    if !(1..=5).contains(&i.difficulty) {
        e.push((
            "difficulty".into(),
            "Choose a difficulty from 1 to 5.".into(),
        ))
    }
    if !["single", "multi", "written"].contains(&i.kind.as_str()) {
        e.push(("kind".into(), "Choose single, multi or written.".into()))
    }
    if !(1..=4000).contains(&chars(&i.stem)) {
        e.push(("stem".into(), "Use 1–4000 characters.".into()))
    }
    if i.kind == "written" {
        if !i.options.is_empty() {
            e.push((
                "options".into(),
                "Written questions cannot have options.".into(),
            ))
        }
        if !i.correct.is_empty() {
            e.push((
                "correct".into(),
                "Written questions cannot have correct options.".into(),
            ))
        }
    } else if !(2..=10).contains(&i.options.len()) {
        e.push(("options".into(), "Use 2–10 options.".into()))
    }
    let mut ids = HashSet::new();
    for (n, o) in i.options.iter().enumerate() {
        let p = format!("options[{n}]");
        if o.id.is_empty()
            || o.id.len() > 8
            || !o
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            e.push((
                format!("{p}.id"),
                "Use 1–8 lowercase letters or digits.".into(),
            ))
        }
        if !ids.insert(o.id.as_str()) {
            e.push((format!("{p}.id"), "Option ids must be unique.".into()))
        }
        if !(1..=500).contains(&chars(&o.text)) {
            e.push((format!("{p}.text"), "Use 1–500 characters.".into()))
        }
    }
    let mut correct = HashSet::new();
    for (n, c) in i.correct.iter().enumerate() {
        if !ids.contains(c.as_str()) {
            e.push((
                format!("correct[{n}]"),
                "Choose an existing option id.".into(),
            ))
        }
        if !correct.insert(c) {
            e.push((
                format!("correct[{n}]"),
                "Correct option ids must be unique.".into(),
            ))
        }
    }
    if i.kind == "single" && i.correct.len() != 1 {
        e.push((
            "correct".into(),
            "Single questions require exactly one correct option.".into(),
        ))
    }
    if i.kind == "multi" && i.correct.is_empty() {
        e.push((
            "correct".into(),
            "Multi questions require at least one correct option.".into(),
        ))
    }
    if !i.marks.is_finite() || i.marks <= 0. || i.marks > 1000. || (i.marks * 4.).fract() != 0. {
        e.push((
            "marks".into(),
            "Use a value above 0 and at most 1000 in 0.25 steps.".into(),
        ))
    }
    if !i.negative_marks.is_finite()
        || i.negative_marks < 0.
        || i.negative_marks > i.marks
        || (i.negative_marks * 4.).fract() != 0.
    {
        e.push((
            "negativeMarks".into(),
            "Use 0 through marks in 0.25 steps.".into(),
        ))
    }
    if !["all_or_nothing", "partial", "partial_penalty"].contains(&i.multi_rule.as_str()) {
        e.push(("multiRule".into(), "Choose a valid multi rule.".into()))
    }
    if chars(&i.rubric) > 4000 {
        e.push(("rubric".into(), "Use at most 4000 characters.".into()))
    }
    if i.max_words.is_some_and(|n| !(1..=5000).contains(&n)) {
        e.push(("maxWords".into(), "Use 1–5000 or null.".into()))
    }
    if chars(&i.explanation) > 4000 {
        e.push(("explanation".into(), "Use at most 4000 characters.".into()))
    }
    e
}
fn value(s: &str) -> String {
    format!(
        "%{}%",
        s.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}
fn cols() -> &'static str {
    "id,topic,difficulty,kind,stem,options,correct,marks::float8 as marks,negative_marks::float8 as negative_marks,multi_rule,rubric,max_words,explanation,observed_facility::float8 as observed_facility,observed_count,version,created_at,updated_at"
}
pub async fn insert_question(
    tx: &mut PgConnection,
    owner_id: Uuid,
    i: &QuestionInput,
) -> AppResult<Question> {
    Ok(sqlx::query_as::<_,Question>(&format!("insert into questions(owner_id,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,rubric,max_words,explanation) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning {}",cols())).bind(owner_id).bind(&i.topic).bind(i.difficulty).bind(&i.kind).bind(&i.stem).bind(json!(i.options)).bind(json!(i.correct)).bind(i.marks).bind(i.negative_marks).bind(&i.multi_rule).bind(&i.rubric).bind(i.max_words).bind(&i.explanation).fetch_one(tx).await?)
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/questions", get(list).post(create))
        .route("/questions/topics", get(topics))
        .route("/questions/import", post(import))
        .route("/questions/{id}", get(get_one).patch(update).delete(remove))
}
async fn audit_it(
    s: &AppState,
    m: &RequestMeta,
    v: &ExaminerViewer,
    action: &str,
    id: Option<Uuid>,
) {
    audit(
        &s.db,
        m,
        AuditEntry {
            action,
            actor_id: Some(v.0.id),
            target_type: Some("question"),
            target_id: id.map(|x| x.to_string()),
            meta: json!({}),
        },
    )
    .await;
}
async fn list(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Query(q): Query<ListQuery>,
) -> AppResult<ResponseJson<Page<Question>>> {
    if q.topic
        .as_ref()
        .is_some_and(|x| x.trim() != x || x.is_empty() || x.chars().count() > 80)
    {
        return Err(examcore::invalid("topic", "Use 1–80 trimmed characters."));
    }
    if q.difficulty.is_some_and(|x| !(1..=5).contains(&x)) {
        return Err(examcore::invalid(
            "difficulty",
            "Choose a difficulty from 1 to 5.",
        ));
    }
    if q.kind
        .as_ref()
        .is_some_and(|x| !["single", "multi", "written"].contains(&x.as_str()))
    {
        return Err(examcore::invalid(
            "kind",
            "Choose single, multi or written.",
        ));
    }
    if q.q.as_ref().is_some_and(|x| x.chars().count() > 200) {
        return Err(examcore::invalid("q", "Use at most 200 characters."));
    }
    let limit = q.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(examcore::invalid("limit", "Use 1–100."));
    }
    let owner = if v.0.is_admin() { None } else { Some(v.0.id) };
    let cursor = match q.cursor {
        Some(c) => Some(
            decode_cursor(&c).ok_or_else(|| examcore::invalid("cursor", "Cursor is invalid."))?,
        ),
        None => None,
    };
    let sql = format!(
        "select {} from questions where deleted_at is null and ($1::uuid is null or owner_id=$1) and ($2::text is null or topic=$2) and ($3::smallint is null or difficulty=$3) and ($4::text is null or kind=$4) and ($5::text is null or stem ilike $5 escape chr(92) or topic ilike $5 escape chr(92)) and ($6::timestamptz is null or created_at < $6 or (created_at = $6 and id > $7)) order by created_at desc,id limit $8",
        cols()
    );
    let rows = sqlx::query_as::<_, Question>(&sql)
        .bind(owner)
        .bind(q.topic)
        .bind(q.difficulty)
        .bind(q.kind)
        .bind(q.q.map(|x| value(&x)))
        .bind(cursor.map(|x| x.0))
        .bind(cursor.map(|x| x.1))
        .bind(limit + 1)
        .fetch_all(&s.db)
        .await?;
    let mut rows = rows;
    let next = if rows.len() as i64 > limit {
        rows.pop();
        rows.last().map(encode_cursor)
    } else {
        None
    };
    Ok(ResponseJson(Page {
        items: rows,
        next_cursor: next,
    }))
}
fn encode_cursor(q: &Question) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
        "{}|{}",
        q.created_at.unix_timestamp_nanos(),
        q.id
    ))
}
fn decode_cursor(c: &str) -> Option<(time::OffsetDateTime, Uuid)> {
    use base64::Engine;
    let s = String::from_utf8(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(c)
            .ok()?,
    )
    .ok()?;
    let (a, b) = s.split_once('|')?;
    Some((
        time::OffsetDateTime::from_unix_timestamp_nanos(a.parse().ok()?).ok()?,
        Uuid::parse_str(b).ok()?,
    ))
}
async fn create(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Json(i): Json<QuestionInput>,
) -> AppResult<ResponseJson<Question>> {
    let e = validate(&i);
    if !e.is_empty() {
        return Err(invalid_many(e));
    }
    let mut tx = s.db.begin().await?;
    let q = insert_question(&mut tx, v.0.id, &i).await?;
    tx.commit().await?;
    audit_it(&s, &m, &v, "questions.create", Some(q.id)).await;
    Ok(ResponseJson(q))
}
async fn get_one(
    State(s): State<AppState>,
    v: ExaminerViewer,
    Path(id): Path<Uuid>,
) -> AppResult<ResponseJson<Question>> {
    let owner = if v.0.is_admin() { None } else { Some(v.0.id) };
    let q=sqlx::query_as::<_,Question>(&format!("select {} from questions where id=$1 and deleted_at is null and ($2::uuid is null or owner_id=$2)",cols())).bind(id).bind(owner).fetch_optional(&s.db).await?.ok_or_else(AppError::not_found)?;
    Ok(ResponseJson(q))
}
async fn update(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(i): Json<QuestionInput>,
) -> AppResult<ResponseJson<Question>> {
    let version = match h
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .and_then(|x| x.parse::<i32>().ok())
    {
        Some(n) => n,
        None => {
            return Err(AppError::new(
                ErrorCode::PreconditionRequired,
                "If-Match is required.",
            ));
        }
    };
    let e = validate(&i);
    if !e.is_empty() {
        return Err(invalid_many(e));
    }
    let mut tx = s.db.begin().await?;
    let owner = if v.0.is_admin() { None } else { Some(v.0.id) };
    let changed=sqlx::query_as::<_,Question>(&format!("update questions set topic=$3,difficulty=$4,kind=$5,stem=$6,options=$7,correct=$8,marks=$9,negative_marks=$10,multi_rule=$11,rubric=$12,max_words=$13,explanation=$14,version=version+1,updated_at=now() where id=$1 and version=$2 and deleted_at is null and ($15::uuid is null or owner_id=$15) returning {}",cols())).bind(id).bind(version).bind(&i.topic).bind(i.difficulty).bind(&i.kind).bind(&i.stem).bind(json!(i.options)).bind(json!(i.correct)).bind(i.marks).bind(i.negative_marks).bind(&i.multi_rule).bind(&i.rubric).bind(i.max_words).bind(&i.explanation).bind(owner).fetch_optional(&mut *tx).await?;
    let Some(q) = changed else {
        let exists:bool=sqlx::query_scalar("select exists(select 1 from questions where id=$1 and deleted_at is null and ($2::uuid is null or owner_id=$2))").bind(id).bind(owner).fetch_one(&mut *tx).await?;
        tx.rollback().await?;
        return if exists {
            Err(AppError::new(
                ErrorCode::VersionConflict,
                "The question has changed.",
            ))
        } else {
            Err(AppError::not_found())
        };
    };
    tx.commit().await?;
    audit_it(&s, &m, &v, "questions.update", Some(id)).await;
    Ok(ResponseJson(q))
}
async fn remove(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Path(id): Path<Uuid>,
) -> AppResult<ResponseJson<Value>> {
    let owner = if v.0.is_admin() { None } else { Some(v.0.id) };
    let n=sqlx::query("update questions set deleted_at=now(),version=version+1,updated_at=now() where id=$1 and deleted_at is null and ($2::uuid is null or owner_id=$2)").bind(id).bind(owner).execute(&s.db).await?.rows_affected();
    if n == 0 {
        return Err(AppError::not_found());
    }
    audit_it(&s, &m, &v, "questions.delete", Some(id)).await;
    Ok(ResponseJson(json!({"deleted":true})))
}
async fn topics(
    State(s): State<AppState>,
    v: ExaminerViewer,
) -> AppResult<ResponseJson<Vec<Value>>> {
    let owner = if v.0.is_admin() { None } else { Some(v.0.id) };
    let rows=sqlx::query_as::<_,(String,i64)>("select topic,count(*) from questions where deleted_at is null and ($1::uuid is null or owner_id=$1) group by topic order by topic").bind(owner).fetch_all(&s.db).await?;
    Ok(ResponseJson(
        rows.into_iter()
            .map(|(topic, count)| json!({"topic":topic,"count":count}))
            .collect(),
    ))
}
fn parse_row(v: Value) -> Result<QuestionInput, String> {
    if v.get("optionA").is_some() || v.get("correct").is_some_and(Value::is_string) {
        let get = |k: &str| v.get(k).cloned().unwrap_or(Value::Null);
        let strv = |k: &str| {
            get(k)
                .as_str()
                .map(str::to_owned)
                .or_else(|| get(k).as_number().map(ToString::to_string))
                .unwrap_or_default()
        };
        let mut options = Vec::new();
        for (n, l) in ["A", "B", "C", "D", "E", "F"].iter().enumerate() {
            let t = strv(&format!("option{l}"));
            if !t.is_empty() {
                options.push(QuestionOption {
                    id: ((b'a' + n as u8) as char).to_string(),
                    text: t,
                })
            }
        }
        let correct = strv("correct")
            .split(',')
            .map(|x| x.trim().to_ascii_lowercase())
            .filter(|x| !x.is_empty())
            .collect();
        let number = |k: &str, default: f64| {
            get(k)
                .as_f64()
                .or_else(|| strv(k).parse().ok())
                .unwrap_or(default)
        };
        let kind = strv("kind");
        Ok(QuestionInput {
            topic: strv("topic"),
            difficulty: number("difficulty", 0.) as i16,
            kind,
            stem: strv("stem"),
            options,
            correct,
            marks: number("marks", 0.),
            negative_marks: number("negativeMarks", 0.),
            multi_rule: if strv("multiRule").is_empty() {
                default_rule()
            } else {
                strv("multiRule")
            },
            rubric: strv("rubric"),
            max_words: if get("maxWords").is_null() {
                None
            } else {
                strv("maxWords").parse().ok()
            },
            explanation: strv("explanation"),
        })
    } else {
        serde_json::from_value(v).map_err(|_| "Invalid question object.".into())
    }
}
async fn import(
    State(s): State<AppState>,
    v: ExaminerViewer,
    m: RequestMeta,
    Json(r): Json<ImportRequest>,
) -> AppResult<ResponseJson<ImportResult>> {
    enforce_rate_limit(
        &s.db,
        &format!("questions-import:{}", v.0.id),
        Limit {
            limit: 20,
            window: Duration::from_secs(3600),
        },
    )
    .await?;
    if r.rows.len() > 500 {
        return Err(examcore::invalid("rows", "Import at most 500 rows."));
    }
    let mut parsed = Vec::new();
    let mut errors = Vec::new();
    for (n, row) in r.rows.into_iter().enumerate() {
        match parse_row(row) {
            Ok(q) => {
                for (p, msg) in validate(&q) {
                    errors.push(RowError {
                        row: n + 1,
                        path: p,
                        message: msg,
                    })
                }
                parsed.push(q)
            }
            Err(msg) => errors.push(RowError {
                row: n + 1,
                path: "".into(),
                message: msg,
            }),
        }
    }
    if r.dry_run || !errors.is_empty() {
        return Ok(ResponseJson(ImportResult {
            dry_run: r.dry_run,
            created: 0,
            updated: 0,
            errors,
        }));
    }
    let mut tx = s.db.begin().await?;
    for q in &parsed {
        insert_question(&mut tx, v.0.id, q).await?;
    }
    tx.commit().await?;
    audit_it(&s, &m, &v, "questions.import", None).await;
    Ok(ResponseJson(ImportResult {
        dry_run: false,
        created: parsed.len(),
        updated: 0,
        errors: vec![],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use kernel::{config::Config, email::LogSender};
    use std::sync::Arc;
    use tower::ServiceExt;

    fn valid_input() -> QuestionInput {
        QuestionInput {
            topic: "Algorithms".into(),
            difficulty: 2,
            kind: "single".into(),
            stem: "Which search has logarithmic time on sorted input?".into(),
            options: vec![
                QuestionOption {
                    id: "a".into(),
                    text: "Linear search".into(),
                },
                QuestionOption {
                    id: "b".into(),
                    text: "Binary search".into(),
                },
            ],
            correct: vec!["b".into()],
            marks: 2.0,
            negative_marks: 0.5,
            multi_rule: "all_or_nothing".into(),
            rubric: String::new(),
            max_words: None,
            explanation: String::new(),
        }
    }

    #[test]
    fn validates_all_question_fields_and_precise_option_paths() {
        let mut input = valid_input();
        input.options[1].text.clear();
        input.options[1].id = "BAD!".into();
        input.correct = vec!["missing".into()];
        input.marks = 1.1;
        let errors = validate(&input);
        let paths: Vec<&str> = errors.iter().map(|(path, _)| path.as_str()).collect();
        assert!(paths.contains(&"options[1].text"));
        assert!(paths.contains(&"options[1].id"));
        assert!(paths.contains(&"correct[0]"));
        assert!(paths.contains(&"marks"));
    }

    #[test]
    fn validates_written_questions_and_multi_rules() {
        let mut written = valid_input();
        written.kind = "written".into();
        written.options.clear();
        written.correct.clear();
        written.rubric = "Award marks for a justified recurrence.".into();
        assert!(validate(&written).is_empty());
        written.options.push(QuestionOption {
            id: "a".into(),
            text: "Invalid".into(),
        });
        assert!(validate(&written).iter().any(|(path, _)| path == "options"));

        let mut multi = valid_input();
        multi.kind = "multi".into();
        multi.correct.clear();
        assert!(validate(&multi).iter().any(|(path, _)| path == "correct"));
    }

    #[test]
    fn parses_flat_csv_rows_and_rejects_bad_question_objects() {
        let flat = json!({
            "topic":"Algorithms", "difficulty":"3", "kind":"multi",
            "stem":"Pick both sorting algorithms.", "optionA":"Merge sort",
            "optionB":"Insertion sort", "correct":"A,B", "marks":"2.5"
        });
        let parsed = parse_row(flat).expect("flat row should parse");
        assert_eq!(parsed.difficulty, 3);
        assert_eq!(parsed.correct, vec!["a", "b"]);
        assert_eq!(parsed.marks, 2.5);

        let malformed = json!({"topic":"Algorithms", "unexpected":true});
        assert!(parse_row(malformed).is_err());
    }

    #[test]
    fn cursor_round_trip_and_search_escaping() {
        let id = Uuid::new_v4();
        let created =
            time::OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("valid timestamp");
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            format!("{}|{}", created.unix_timestamp_nanos(), id),
        );
        let decoded = decode_cursor(&encoded).expect("cursor should decode");
        assert_eq!(decoded, (created, id));
        assert_eq!(value("a%_b"), "%a\\%\\_b%");
        assert!(decode_cursor("invalid").is_none());
    }

    #[test]
    fn bundled_seed_has_thirty_valid_questions_and_six_written_rubrics() {
        let items: Vec<QuestionInput> =
            serde_json::from_str(SEED_QUESTIONS).expect("seed JSON parses");
        assert_eq!(items.len(), 30);
        assert!(items.iter().all(|item| validate(item).is_empty()));
        assert_eq!(
            items.iter().filter(|item| item.kind == "written").count(),
            6
        );
        assert!(
            items
                .iter()
                .filter(|item| item.kind == "written")
                .all(|item| !item.rubric.is_empty())
        );
        let topics: HashSet<&str> = items.iter().map(|item| item.topic.as_str()).collect();
        assert_eq!(topics.len(), 5);
    }

    async fn http(
        state: &AppState,
        method: &str,
        uri: &str,
        token: &str,
        body: Value,
        if_match: Option<&str>,
    ) -> axum::response::Response {
        let mut request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json");
        if let Some(version) = if_match {
            request = request.header("if-match", version);
        }
        router()
            .with_state(state.clone())
            .oneshot(
                request
                    .body(Body::from(body.to_string()))
                    .expect("request builds"),
            )
            .await
            .expect("router responds")
    }

    async fn create_actor(db: &sqlx::PgPool, email: &str, role: &str) -> (Uuid, String) {
        let id: Uuid =
            sqlx::query_scalar("insert into users(email,role) values($1,$2) returning id")
                .bind(email)
                .bind(role)
                .fetch_one(db)
                .await
                .expect("actor insert succeeds");
        let (token, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')")
            .bind(id)
            .bind(hash.as_slice())
            .execute(db)
            .await
            .expect("session insert succeeds");
        (id, token)
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn authorization_versioning_and_import_are_safe(db: sqlx::PgPool) {
        use axum::http::StatusCode;

        let (owner, owner_token) = create_actor(&db, "owner@questions.test", "examiner").await;
        let (_, other_token) = create_actor(&db, "other@questions.test", "examiner").await;
        let (_, candidate_token) = create_actor(&db, "candidate@questions.test", "user").await;
        let state = AppState {
            db: db.clone(),
            config: Arc::new(Config::from_env().expect("test config loads")),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };

        let input_value = serde_json::to_value(valid_input()).expect("valid input serializes");
        let created = http(
            &state,
            "POST",
            "/questions",
            &owner_token,
            input_value.clone(),
            None,
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let created_body: Value = serde_json::from_slice(
            &axum::body::to_bytes(created.into_body(), 1_000_000)
                .await
                .expect("response body"),
        )
        .expect("response JSON");
        let question_id = created_body["id"].as_str().expect("question id");
        let path = format!("/questions/{question_id}");
        assert_eq!(
            http(&state, "GET", &path, &other_token, json!({}), None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            http(&state, "GET", &path, &candidate_token, json!({}), None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );

        assert_eq!(
            http(
                &state,
                "PATCH",
                &path,
                &owner_token,
                input_value.clone(),
                None
            )
            .await
            .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        assert_eq!(
            http(
                &state,
                "PATCH",
                &path,
                &owner_token,
                input_value.clone(),
                Some("1")
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            http(
                &state,
                "PATCH",
                &path,
                &owner_token,
                input_value.clone(),
                Some("1")
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );

        let before: i64 = sqlx::query_scalar("select count(*) from questions where owner_id=$1")
            .bind(owner)
            .fetch_one(&db)
            .await
            .expect("count questions");
        let valid_row = input_value;
        let dryrun = json!({"rows":[valid_row.clone()],"dryRun":true});
        let response = http(
            &state,
            "POST",
            "/questions/import",
            &owner_token,
            dryrun,
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let after_dryrun: i64 =
            sqlx::query_scalar("select count(*) from questions where owner_id=$1")
                .bind(owner)
                .fetch_one(&db)
                .await
                .expect("count after dry run");
        assert_eq!(before, after_dryrun);

        let mut bad = valid_row;
        bad["topic"] = json!("");
        let response = http(&state, "POST", "/questions/import", &owner_token, json!({"rows":[serde_json::to_value(valid_input()).expect("serialize"),bad],"dryRun":false}), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let after_bad_batch: i64 =
            sqlx::query_scalar("select count(*) from questions where owner_id=$1")
                .bind(owner)
                .fetch_one(&db)
                .await
                .expect("count after bad import");
        assert_eq!(before, after_bad_batch);
    }
}
