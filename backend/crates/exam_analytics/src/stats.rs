use axum::{
    extract::{FromRequestParts, Path, Query, State},
    http::request::Parts,
};
use examcore::{AdminViewer, ExaminerViewer};
use kernel::{AppError, AppState, ErrorCode};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TimeseriesQuery {
    bucket: Option<i64>,
}

pub(super) struct HiddenAdmin;
impl FromRequestParts<AppState> for HiddenAdmin {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        AdminViewer::from_request_parts(parts, state)
            .await
            .map(|_| Self)
            .map_err(|error| {
                if error.code == ErrorCode::Forbidden {
                    AppError::not_found()
                } else {
                    error
                }
            })
    }
}

pub(super) async fn timeseries(
    State(state): State<AppState>,
    viewer: ExaminerViewer,
    Path(exam_id): Path<Uuid>,
    Query(query): Query<TimeseriesQuery>,
) -> examcore::ApiJson {
    let requested = query.bucket.unwrap_or(60);
    if !(10..=3600).contains(&requested) {
        return Err(AppError::new(
            ErrorCode::ValidationFailed,
            "Bucket must be between 10 and 3600 seconds.",
        ));
    }
    let window: Option<(String, String, f64)> = sqlx::query_as(
        "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), to_char(least(ends_at,clock_timestamp()) at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), greatest(0,extract(epoch from least(ends_at,clock_timestamp())-starts_at))::float8 from exams where id=$1 and owner_id=$2 and deleted_at is null",
    )
    .bind(exam_id)
    .bind(viewer.0.id)
    .fetch_optional(&state.db)
    .await?;
    let Some((from, until, elapsed)) = window else {
        return Err(AppError::not_found());
    };
    let bucket = requested.max((elapsed / 500.0).ceil() as i64).max(1);
    let rows: Vec<Value> = sqlx::query_scalar(
        r#"with win as (
             select $1::timestamptz as started, $2::timestamptz as stopped, $3::bigint as width
           ), buckets as (
             select started + n * width * interval '1 second' as bucket_at,
                    least(started + (n + 1) * width * interval '1 second', stopped) as bucket_end
             from win, lateral generate_series(0, greatest(0, ceil(extract(epoch from stopped-started)/width)::int - 1)) n
             where stopped > started
           )
           select jsonb_build_object(
             'at',to_char(b.bucket_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'answersSaved',(select count(*) from answers an join attempts a on a.id=an.attempt_id where a.exam_id=$4 and not a.sandbox and an.saved_at>=b.bucket_at and an.saved_at<b.bucket_end),
             'activeCandidates',(select count(distinct h.attempt_id) from attempt_heartbeats h join attempts a on a.id=h.attempt_id where a.exam_id=$4 and not a.sandbox and h.online and h.at>=b.bucket_at and h.at<b.bucket_end),
             'connectionDrops',(select count(*) from attempt_events ev join attempts a on a.id=ev.attempt_id where a.exam_id=$4 and not a.sandbox and ev.kind='offline' and ev.recorded_at>=b.bucket_at and ev.recorded_at<b.bucket_end),
             'submissions',(select count(*) from attempts a where a.exam_id=$4 and not a.sandbox and a.submitted_at>=b.bucket_at and a.submitted_at<b.bucket_end)
           ) from buckets b order by b.bucket_at"#,
    )
    .bind(&from)
    .bind(&until)
    .bind(bucket)
    .bind(exam_id)
    .fetch_all(&state.db)
    .await?;
    Ok(examcore::ok(json!({
        "examId": exam_id,
        "bucketSeconds": bucket,
        "from": from,
        "to": until,
        "buckets": rows
    })))
}

pub(super) async fn examiner_overview(
    State(state): State<AppState>,
    viewer: ExaminerViewer,
) -> examcore::ApiJson {
    let submissions: Vec<Value> = sqlx::query_scalar(
        r#"with days as (select generate_series(date_trunc('day',now() at time zone 'UTC')-interval '13 days',date_trunc('day',now() at time zone 'UTC'),interval '1 day') as d_day)
           select jsonb_build_object('day',to_char(d.d_day,'YYYY-MM-DD'),'count',count(a.id))
           from days d left join attempts a on a.submitted_at >= d.d_day at time zone 'UTC' and a.submitted_at < (d.d_day+interval '1 day') at time zone 'UTC' and not a.sandbox
             and a.exam_id in (select own.id from exams own where own.owner_id=$1 and own.deleted_at is null)
           left join exams e on e.id=a.exam_id and e.owner_id=$1 and e.deleted_at is null
           group by d.d_day order by d.d_day"#,
    ).bind(viewer.0.id).fetch_all(&state.db).await?;
    let pass_rates: Vec<Value> = sqlx::query_scalar(
        r#"select jsonb_build_object('examId',e.id,'title',e.title,'completedAt',to_char(e.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'passRate',coalesce(avg(case when a.total_score>=e.pass_marks then 1.0 else 0.0 end),0.0),'submissions',count(a.id))
           from exams e left join attempts a on a.exam_id=e.id and not a.sandbox and a.status in ('submitted','expired') and a.total_score is not null
           where e.owner_id=$1 and e.deleted_at is null and e.status='completed' group by e.id order by e.completed_at desc limit 6"#,
    ).bind(viewer.0.id).fetch_all(&state.db).await?;
    let candidates: i64 = sqlx::query_scalar(
        "select count(*) from attempts a join exams e on e.id=a.exam_id where e.owner_id=$1 and e.deleted_at is null and e.starts_at<=now() and e.ends_at>now() and not a.sandbox and a.status='in_progress' and a.last_heartbeat_at>now()-interval '90 seconds'",
    ).bind(viewer.0.id).fetch_one(&state.db).await?;
    Ok(examcore::ok(json!({
        "submissionsPerDay": submissions,
        "passRateByExam": pass_rates,
        "candidatesNow": candidates
    })))
}

pub(super) async fn admin_overview(
    State(state): State<AppState>,
    _viewer: HiddenAdmin,
) -> examcore::ApiJson {
    let signins: Vec<Value> = sqlx::query_scalar(
        r#"with hours as (select generate_series(date_trunc('hour',now())-interval '23 hours',date_trunc('hour',now()),interval '1 hour') as h_hour)
           select jsonb_build_object('at',to_char(h.h_hour at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'count',count(a.id))
           from hours h left join audit_log a on a.action='auth.signin' and a.at>=h.h_hour and a.at<h.h_hour+interval '1 hour'
           group by h.h_hour order by h.h_hour"#,
    ).fetch_all(&state.db).await?;
    let active_sessions: i64 = sqlx::query_scalar(
        "select count(*) from sessions s join users u on u.id=s.user_id where s.revoked_at is null and s.expires_at>now() and u.status='active' and u.deleted_at is null",
    ).fetch_one(&state.db).await?;
    let accounts: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('role',role,'count',n) from (select case when role='admin' or lower(email::text)=any($1::text[]) then 'admin' when role='examiner' then 'examiner' else 'candidate' end as role,count(*) as n from users where deleted_at is null group by 1) x order by role",
    )
    .bind(state.config.admin_emails.iter().map(|email| email.to_lowercase()).collect::<Vec<_>>())
    .fetch_all(&state.db)
    .await?;
    let phases: Vec<Value> = sqlx::query_scalar(
        r#"select jsonb_build_object('phase',phase,'count',n) from (
             select case when status='draft' then 'draft' when status='archived' then 'archived' when status='completed' then 'completed'
                         when starts_at>now() then 'scheduled' when ends_at<=now() then 'closed' else 'ongoing' end as phase, count(*) as n
             from exams where deleted_at is null group by 1) p order by phase"#,
    ).fetch_all(&state.db).await?;
    Ok(examcore::ok(json!({
        "signInsPerHour": signins,
        "activeSessions": active_sessions,
        "accountsByRole": accounts,
        "examsByPhase": phases
    })))
}
