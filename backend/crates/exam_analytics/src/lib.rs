//! Examiner analytics calculated from finalized, non-sandbox attempts.
use axum::{Router, extract::State, routing::get};
use examcore::ExaminerViewer;
use kernel::{AppError, AppResult, AppState};
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/exams/{id}/analytics", get(exam_analytics))
        .route("/questions/{id}/stats", get(question_stats))
}

#[derive(Clone, FromRow)]
struct Attempt {
    id: Uuid,
    candidate: String,
    score: f64,
    status: String,
}
#[derive(FromRow)]
struct Item {
    id: Uuid,
    question_id: Option<Uuid>,
    topic: String,
    kind: String,
    marks: f64,
    correct: Value,
    options: Value,
    position: i32,
    difficulty: i16,
    stem: String,
}
#[derive(Clone, FromRow)]
struct Answer {
    attempt_id: Uuid,
    item_id: Uuid,
    response: Value,
    awarded: f64,
}

async fn exam_analytics(
    State(s): State<AppState>,
    v: ExaminerViewer,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> examcore::ApiJson {
    let owned: bool = sqlx::query_scalar(
        "select exists(select 1 from exams where id=$1 and owner_id=$2 and deleted_at is null)",
    )
    .bind(id)
    .bind(v.0.id)
    .fetch_one(&s.db)
    .await?;
    if !owned {
        return Err(AppError::not_found());
    }
    let items: Vec<Item> = sqlx::query_as("select id,question_id,topic,kind,marks::float8 marks,correct,options,position,difficulty,stem from exam_items where exam_id=$1 and not sandbox order by position").bind(id).fetch_all(&s.db).await?;
    let attempts: Vec<Attempt> = sqlx::query_as("select a.id,u.display_name candidate,a.total_score::float8 score,a.status from attempts a join users u on u.id=a.candidate_id where a.exam_id=$1 and not a.sandbox and a.status in ('submitted','expired')  and a.total_score is not null order by a.started_at desc,a.id").bind(id).fetch_all(&s.db).await?;
    let capped = attempts.len() > 500;
    let ids: Vec<Uuid> = attempts.iter().map(|a| a.id).collect();
    let answers: Vec<Answer> = if ids.is_empty() {
        vec![]
    } else {
        sqlx::query_as("select an.attempt_id,an.item_id,an.response,coalesce(an.manual_marks,an.auto_marks,0)::float8 awarded from answers an join attempts a on a.id=an.attempt_id where an.attempt_id=any($1) and a.exam_id=$2 and not a.sandbox").bind(&ids).bind(id).fetch_all(&s.db).await?
    };
    let scores: Vec<f64> = attempts.iter().map(|a| a.score).collect();
    let total: f64 = items.iter().map(|i| i.marks).sum();
    let mean = avg(&scores);
    let mut ordered = scores.clone();
    ordered.sort_by(f64::total_cmp);
    let pass_mark = exam_pass_mark(&s, id).await?;
    let pass: f64 = if attempts.is_empty() {
        0.
    } else {
        attempts.iter().filter(|a| a.score >= pass_mark).count() as f64 / attempts.len() as f64
    };
    let histogram: Vec<usize> = (0..10)
        .map(|b| {
            scores
                .iter()
                .filter(|x| {
                    if total <= 0. {
                        false
                    } else {
                        let p = (**x / total * 100.).clamp(0., 100.);
                        if b == 9 {
                            p >= 90.
                        } else {
                            p >= b as f64 * 10. && p < (b + 1) as f64 * 10.
                        }
                    }
                })
                .count()
        })
        .collect();
    let mut per_item = Vec::new();
    let mut facilities = Vec::new();
    for item in &items {
        let vals: Vec<(f64, f64)> = attempts
            .iter()
            .map(|a| {
                let ans = answers
                    .iter()
                    .find(|x| x.attempt_id == a.id && x.item_id == item.id);
                (
                    if item.marks > 0. {
                        ans.map_or(0., |x| x.awarded / item.marks)
                    } else {
                        0.
                    },
                    a.score,
                )
            })
            .collect();
        let facility = if attempts.is_empty() || item.marks <= 0. {
            0.
        } else {
            (vals.iter().map(|x| x.0).sum::<f64>() / attempts.len() as f64).clamp(0., 1.)
        };
        facilities.push(facility);
        let skips = attempts
            .iter()
            .filter(|a| {
                answers
                    .iter()
                    .find(|x| x.attempt_id == a.id && x.item_id == item.id)
                    .is_none_or(|x| empty(&x.response))
            })
            .count();
        let skip = if attempts.is_empty() {
            0.
        } else {
            skips as f64 / attempts.len() as f64
        };
        let disc = discrimination(&vals);
        let mut picks = Vec::new();
        if let Some(opts) = item.options.as_array() {
            for opt in opts {
                if let Some(key) = opt.get("id").and_then(Value::as_str) {
                    let count = answers
                        .iter()
                        .filter(|a| {
                            a.item_id == item.id && selected(&a.response).iter().any(|x| x == key)
                        })
                        .count();
                    picks.push(json!({"id":key,"text":opt.get("text").and_then(Value::as_str).unwrap_or(""),"picks":count,"correct":item.correct.as_array().is_some_and(|c|c.iter().any(|x|x.as_str()==Some(key)))}));
                }
            }
        }
        let dead = attempts.len() >= 5
            && picks
                .iter()
                .any(|x| x["correct"] == false && x["picks"] == 0);
        let mut flags = Vec::new();
        if !attempts.is_empty() && facility > 0.9 {
            flags.push("too_easy")
        }
        if !attempts.is_empty() && facility < 0.2 {
            flags.push("too_hard")
        }
        if disc.is_some_and(|d| d < 0.) {
            flags.push("negative_discrimination")
        }
        if skip > 0.25 {
            flags.push("often_skipped")
        }
        if dead {
            flags.push("dead_distractor")
        }
        per_item.push(json!({"itemId":item.id,"position":item.position,"kind":item.kind,"stem":item.stem,"topic":item.topic,"declaredDifficulty":item.difficulty,"facility":if attempts.is_empty(){None}else{Some(facility)},"discrimination":disc,"skipRate":skip,"attempts":attempts.len(),"options":picks,"flags":flags}));
    }
    let mut topics = Vec::new();
    for topic in items
        .iter()
        .map(|x| x.topic.as_str())
        .collect::<std::collections::BTreeSet<_>>()
    {
        let its: Vec<&Item> = items.iter().filter(|x| x.topic == topic).collect();
        let mut sum = 0.;
        let mut n = 0.;
        for a in &attempts {
            let mut got = 0.;
            let mut max = 0.;
            for i in &its {
                max += i.marks;
                got += answers
                    .iter()
                    .find(|x| x.attempt_id == a.id && x.item_id == i.id)
                    .map_or(0., |x| x.awarded);
            }
            if max > 0. {
                sum += got / max * 100.;
                n += 1.;
            }
        }
        topics.push(json!({"topic":topic,"meanPercent":if n>0.{sum/n}else{0.},"items":its.len()}));
    }
    let pair_attempts = attempts.iter().take(500).cloned().collect::<Vec<_>>();
    let pair_ids = pair_attempts.iter().map(|a| a.id).collect::<Vec<_>>();
    let pair_answers = answers
        .iter()
        .filter(|answer| pair_ids.contains(&answer.attempt_id))
        .cloned()
        .collect::<Vec<_>>();
    let pairs = collusion(&pair_attempts, &items, &pair_answers);
    let reliability = reliability(&attempts, &items, &answers);
    update_bank(&s, &items).await?;
    let histogram: Vec<Value> = histogram
        .into_iter()
        .enumerate()
        .map(|(i, count)| json!({"from":i*10,"to":(i+1)*10,"count":count}))
        .collect();
    Ok(examcore::ok(
        json!({"examId":id,"attempts":attempts.len(),"submitted":attempts.iter().filter(|a|a.status=="submitted"||a.status=="expired").count(),"similarPairsCapped":capped,"mean":mean,"median":median(&ordered).unwrap_or(0.),"stdDev":stddev(&scores),"highest":scores.iter().copied().reduce(f64::max).unwrap_or(0.),"lowest":scores.iter().copied().reduce(f64::min).unwrap_or(0.),"passRate":pass,"histogram":histogram,"reliability":reliability,"items":per_item,"topics":topics,"similarPairs":pairs,"similarPairsNote":if capped {"Indicators for review, not evidence. Pair analysis capped at 500 attempts."} else {"Indicators for review, not evidence."}}),
    ))
}

async fn exam_pass_mark(s: &AppState, id: Uuid) -> AppResult<f64> {
    Ok(
        sqlx::query_scalar("select pass_marks::float8 from exams where id=$1")
            .bind(id)
            .fetch_one(&s.db)
            .await?,
    )
}
fn avg(x: &[f64]) -> f64 {
    if x.is_empty() {
        0.
    } else {
        x.iter().sum::<f64>() / x.len() as f64
    }
}
fn median(x: &[f64]) -> Option<f64> {
    if x.is_empty() {
        None
    } else {
        Some(if x.len().is_multiple_of(2) {
            (x[x.len() / 2 - 1] + x[x.len() / 2]) / 2.
        } else {
            x[x.len() / 2]
        })
    }
}
fn stddev(x: &[f64]) -> f64 {
    let m = avg(x);
    if x.is_empty() {
        0.
    } else {
        (x.iter().map(|n| (n - m).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }
}
fn selected(v: &Value) -> Vec<String> {
    v.get("selected")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn empty(v: &Value) -> bool {
    selected(v).is_empty()
        && v.get("text")
            .and_then(Value::as_str)
            .is_none_or(|x| x.trim().is_empty())
}
fn discrimination(rows: &[(f64, f64)]) -> Option<f64> {
    if rows.len() < 4 {
        return None;
    }
    let mut sorted = rows.to_vec();
    sorted.sort_by(|a, b| a.1.total_cmp(&b.1));
    let n = ((sorted.len() as f64 * 0.27).ceil() as usize).max(1);
    Some(
        avg(&sorted[sorted.len() - n..]
            .iter()
            .map(|x| x.0)
            .collect::<Vec<_>>())
            - avg(&sorted[..n].iter().map(|x| x.0).collect::<Vec<_>>()),
    )
}
fn reliability(at: &[Attempt], items: &[Item], ans: &[Answer]) -> Option<f64> {
    if at.len() < 3 {
        return None;
    }
    let cols: Vec<Vec<f64>> = items
        .iter()
        .map(|i| {
            at.iter()
                .map(|a| {
                    ans.iter()
                        .find(|x| x.attempt_id == a.id && x.item_id == i.id)
                        .map_or(0., |x| {
                            if i.marks == 0. {
                                0.
                            } else {
                                x.awarded / i.marks
                            }
                        })
                })
                .collect()
        })
        .collect();
    if cols.len() < 2 {
        return None;
    }
    let vars: f64 = cols.iter().map(|c| variance(c)).sum();
    let totals: Vec<f64> = (0..at.len())
        .map(|n| cols.iter().map(|c| c[n]).sum())
        .collect();
    let tv = variance(&totals);
    if tv == 0. || vars == 0. {
        None
    } else {
        Some(cols.len() as f64 / (cols.len() - 1) as f64 * (1. - vars / tv))
    }
}
fn variance(x: &[f64]) -> f64 {
    if x.is_empty() {
        return 0.;
    }
    let m = avg(x);
    x.iter().map(|v| (v - m).powi(2)).sum::<f64>() / x.len() as f64
}
fn collusion(at: &[Attempt], items: &[Item], ans: &[Answer]) -> Vec<Value> {
    let obj: Vec<&Item> = items.iter().filter(|i| i.kind != "written").collect();
    let mut out = Vec::new();
    for i in 0..at.len() {
        for j in i + 1..at.len() {
            let (mut same, mut both_wrong) = (0, 0);
            for item in &obj {
                let a = ans
                    .iter()
                    .find(|x| x.attempt_id == at[i].id && x.item_id == item.id);
                let b = ans
                    .iter()
                    .find(|x| x.attempt_id == at[j].id && x.item_id == item.id);
                if let (Some(a), Some(b)) = (a, b) {
                    let sa = selected(&a.response);
                    let sb = selected(&b.response);
                    let correct = item
                        .correct
                        .as_array()
                        .map(|x| {
                            x.iter()
                                .filter_map(Value::as_str)
                                .collect::<std::collections::BTreeSet<_>>()
                        })
                        .unwrap_or_default();
                    let wa: std::collections::BTreeSet<_> = sa.iter().map(String::as_str).collect();
                    let wb: std::collections::BTreeSet<_> = sb.iter().map(String::as_str).collect();
                    let wrong_a = !wa.is_empty() && wa != correct;
                    let wrong_b = !wb.is_empty() && wb != correct;
                    if wrong_a && wrong_b {
                        both_wrong += 1;
                        if wa == wb {
                            same += 1;
                        }
                    }
                }
            }
            let ratio = same as f64 / (both_wrong.max(1) as f64);
            if same >= 3 && ratio >= 0.75 {
                out.push(json!({"a":at[i].candidate,"b":at[j].candidate,"identicalWrong":same,"ratio":ratio,"label":"Indicators for review, not evidence"}));
            }
        }
    }
    out.sort_by(|a, b| {
        b["identicalWrong"]
            .as_i64()
            .cmp(&a["identicalWrong"].as_i64())
    });
    out.truncate(20);
    out
}
async fn update_bank(s: &AppState, items: &[Item]) -> AppResult<()> {
    let questions: Vec<Uuid> = items.iter().filter_map(|i| i.question_id).collect();
    if questions.is_empty() {
        return Ok(());
    }
    sqlx::query("update questions q set observed_facility=x.facility,observed_count=x.n from (select ei.question_id,count(a.id)::int n,avg(greatest(0,least(1,coalesce(an.manual_marks,an.auto_marks,0)::float8/ei.marks::float8))) facility from exam_items ei join attempts a on a.exam_id=ei.exam_id and not a.sandbox and a.status in ('submitted','expired')  left join answers an on an.attempt_id=a.id and an.item_id=ei.id where ei.question_id=any($1) and not ei.sandbox group by ei.question_id) x where q.id=x.question_id").bind(questions).execute(&s.db).await?;
    Ok(())
}

async fn question_stats(
    State(s): State<AppState>,
    v: ExaminerViewer,
    axum::extract::Path(qid): axum::extract::Path<Uuid>,
) -> examcore::ApiJson {
    let mut rows:Vec<Value>=sqlx::query_scalar("select jsonb_build_object('examId',e.id,'examTitle',e.title,'facility',case when count(a.id)=0 then null else greatest(0,least(1,avg(coalesce(an.manual_marks,an.auto_marks,0)::float8/ei.marks::float8))) end,'attemptCount',count(a.id)) from exam_items ei join exams e on e.id=ei.exam_id left join attempts a on a.exam_id=e.id and a.status in ('submitted','expired')  and not a.sandbox left join answers an on an.attempt_id=a.id and an.item_id=ei.id where ei.question_id=$1 and not ei.sandbox and e.owner_id=$2 group by e.id,e.title,e.starts_at order by e.starts_at").bind(qid).bind(v.0.id).fetch_all(&s.db).await?;
    if rows.is_empty() {
        let exists: bool = sqlx::query_scalar(
            "select exists(select 1 from questions where id=$1 and owner_id=$2)",
        )
        .bind(qid)
        .bind(v.0.id)
        .fetch_one(&s.db)
        .await?;
        if !exists {
            return Err(AppError::not_found());
        }
    }
    for row in &mut rows {
        let eid = row["examId"]
            .as_str()
            .and_then(|x| Uuid::parse_str(x).ok())
            .ok_or_else(|| AppError::internal("invalid exam id"))?;
        let vals:Vec<(f64,f64)>=sqlx::query_as("select coalesce(an.manual_marks,an.auto_marks,0)::float8/ei.marks::float8,a.total_score::float8 from exam_items ei join exams e on e.id=ei.exam_id join attempts a on a.exam_id=e.id and a.status in ('submitted','expired')  and not a.sandbox left join answers an on an.attempt_id=a.id and an.item_id=ei.id where ei.question_id=$1 and ei.exam_id=$2 and not ei.sandbox").bind(qid).bind(eid).fetch_all(&s.db).await?;
        row["discrimination"] = json!(discrimination(&vals));
    }
    Ok(examcore::ok(json!({"questionId":qid,"history":rows})))
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use kernel::{config::Config, email::LogSender};
    use std::sync::Arc;
    use tower::ServiceExt;
    #[test]
    fn fixed_score_fixture_uses_population_statistics() {
        let scores = [0., 1., 2., 3.];
        assert_eq!(median(&scores), Some(1.5));
        assert!((stddev(&scores) - 1.1180339887).abs() < 1e-9);
        assert_eq!(
            discrimination(&[(0., 0.), (0., 1.), (1., 2.), (1., 3.)]),
            Some(1.)
        );
        assert_eq!(discrimination(&[(1., 0.), (1., 1.), (1., 2.)]), None);
    }

    #[test]
    fn ten_mark_item_discrimination_compares_normalized_facility() {
        let awarded_scores = [(10., 4.), (10., 3.), (0., 2.), (0., 1.)];
        let normalized = awarded_scores
            .iter()
            .map(|(awarded, total)| (awarded / 10., *total))
            .collect::<Vec<_>>();
        assert_eq!(discrimination(&normalized), Some(1.));
    }
    #[test]
    fn collusion_fixture_detects_identical_wrong_choices() {
        let ids = [Uuid::new_v4(), Uuid::new_v4()];
        let attempts = vec![
            Attempt {
                id: ids[0],
                candidate: "Mina".into(),
                score: 0.,
                status: "submitted".into(),
            },
            Attempt {
                id: ids[1],
                candidate: "Omar".into(),
                score: 0.,
                status: "submitted".into(),
            },
        ];
        let items: Vec<Item> = (0..3)
            .map(|n| Item {
                id: Uuid::from_u128(n + 1),
                question_id: None,
                topic: "logic".into(),
                kind: "single".into(),
                marks: 1.,
                correct: json!(["a"]),
                options: json!([]),
                position: n as i32,
                difficulty: 1,
                stem: "Question".into(),
            })
            .collect();
        let answers: Vec<Answer> = items
            .iter()
            .flat_map(|item| {
                ids.iter().map(move |attempt_id| Answer {
                    attempt_id: *attempt_id,
                    item_id: item.id,
                    response: json!({"selected":["b"]}),
                    awarded: 0.,
                })
            })
            .collect();
        let pairs = collusion(&attempts, &items, &answers);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0]["identicalWrong"], 3);
        assert_eq!(pairs[0]["ratio"], 1.0);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn analytics_excludes_sandbox_and_hides_other_examiner_data(db: sqlx::PgPool) {
        let owner:Uuid=sqlx::query_scalar("insert into users(email,role) values('analytics-owner@example.test','examiner') returning id").fetch_one(&db).await.unwrap();
        let other:Uuid=sqlx::query_scalar("insert into users(email,role) values('analytics-other@example.test','examiner') returning id").fetch_one(&db).await.unwrap();
        let candidate:Uuid=sqlx::query_scalar("insert into users(email,display_name) values('analytics-candidate@example.test','Candidate Fixture') returning id").fetch_one(&db).await.unwrap();
        let exam:Uuid=sqlx::query_scalar("insert into exams(owner_id,title,starts_at,ends_at,duration_minutes,total_marks,pass_marks) values($1,'Fixture',now()-interval '1 hour',now()+interval '1 hour',30,1,0) returning id").bind(owner).fetch_one(&db).await.unwrap();
        let question:Uuid=sqlx::query_scalar("insert into questions(owner_id,topic,difficulty,kind,stem,options,correct,marks) values($1,'Fixture',1,'single','Fixture?', '[{\"id\":\"a\",\"text\":\"A\"},{\"id\":\"b\",\"text\":\"B\"}]','[\"a\"]',1) returning id").bind(owner).fetch_one(&db).await.unwrap();
        let item:Uuid=sqlx::query_scalar("insert into exam_items(exam_id,question_id,position,topic,difficulty,kind,stem,options,correct,marks,negative_marks,multi_rule,rubric) values($1,$2,0,'Fixture',1,'single','Fixture?','[{\"id\":\"a\",\"text\":\"A\"},{\"id\":\"b\",\"text\":\"B\"}]','[\"a\"]',1,0,'all_or_nothing','') returning id").bind(exam).bind(question).fetch_one(&db).await.unwrap();
        let real:Uuid=sqlx::query_scalar("insert into attempts(exam_id,candidate_id,status,finalized_by,deadline_at,seed,item_order,journal_genesis,total_score,grading_status) values($1,$2,'submitted','candidate',now(),1,$3,$4,1,'complete') returning id").bind(exam).bind(candidate).bind(vec![item]).bind(vec![0_u8;32]).fetch_one(&db).await.unwrap();
        sqlx::query("insert into answers(attempt_id,item_id,response,client_seq,auto_marks) values($1,$2,'{\"selected\":[\"a\"]}',1,1)").bind(real).bind(item).execute(&db).await.unwrap();
        sqlx::query("insert into attempts(exam_id,candidate_id,sandbox,status,finalized_by,deadline_at,seed,item_order,journal_genesis,total_score,grading_status) values($1,$2,true,'submitted','candidate',now(),2,$3,$4,1,'complete')").bind(exam).bind(candidate).bind(vec![item]).bind(vec![1_u8;32]).execute(&db).await.unwrap();
        let (session, hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(owner).bind(hash.as_slice()).execute(&db).await.unwrap();
        let (other_session, other_hash) = kernel::crypto::new_token();
        sqlx::query("insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')").bind(other).bind(other_hash.as_slice()).execute(&db).await.unwrap();
        let state = AppState {
            db: db.clone(),
            config: Arc::new(Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        };
        let app = router().with_state(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/exams/{exam}/analytics"))
                    .header("authorization", format!("Bearer {session}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["data"]["attempts"], 1);
        assert_eq!(value["data"]["items"][0]["facility"], 1.0);
        let repeat = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/exams/{exam}/analytics"))
                    .header("authorization", format!("Bearer {session}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(repeat.status(), axum::http::StatusCode::OK);
        let observed: (i32, f64) = sqlx::query_as(
            "select observed_count,observed_facility::float8 from questions where id=$1",
        )
        .bind(question)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(observed.0, 1);
        assert_eq!(observed.1, 1.0);
        let history = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/questions/{question}/stats"))
                    .header("authorization", format!("Bearer {session}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(history.status(), axum::http::StatusCode::OK);
        let history_body = axum::body::to_bytes(history.into_body(), 1_000_000)
            .await
            .unwrap();
        let history_value: Value = serde_json::from_slice(&history_body).unwrap();
        assert_eq!(history_value["data"]["history"][0]["facility"], 1.0);
        assert_eq!(
            history_value["data"]["history"][0]["discrimination"],
            Value::Null
        );
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/exams/{exam}/analytics"))
                    .header("authorization", format!("Bearer {other_session}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), axum::http::StatusCode::NOT_FOUND);
        let denied_question = app
            .oneshot(
                Request::builder()
                    .uri(format!("/questions/{question}/stats"))
                    .header("authorization", format!("Bearer {other_session}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied_question.status(), axum::http::StatusCode::NOT_FOUND);
    }
}
