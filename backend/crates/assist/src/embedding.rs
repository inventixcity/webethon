use ai::{
    config::AiConfig,
    metering::{Reservation, Usage},
};
use futures::StreamExt;
use kernel::{AppError, AppResult, AppState, ErrorCode, request::RequestMeta};
use records::registry::EntityRegistry;
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use uuid::Uuid;

const MAX_INPUT: usize = 16000;
const MAX_RESPONSE: usize = 256 * 1024;
static RUNNING: AtomicBool = AtomicBool::new(false);

fn unavailable() -> AppError {
    AppError::new(ErrorCode::Unavailable, "The AI is busy. Please try again.")
}
pub(crate) fn configured(config: &AiConfig) -> bool {
    config.key.is_some()
        && config
            .embedding_model
            .as_ref()
            .is_some_and(|m| !m.trim().is_empty())
}
fn model(config: &AiConfig) -> AppResult<&str> {
    let m = config
        .embedding_model
        .as_deref()
        .filter(|m| !m.trim().is_empty() && m.len() <= 256)
        .ok_or_else(unavailable)?;
    if !config.valid || config.key.is_none() {
        return Err(unavailable());
    }
    Ok(m)
}
fn bounded(input: &str) -> String {
    input.chars().take(MAX_INPUT / 4).collect()
}
fn vector(value: &Value) -> AppResult<(String, i32)> {
    let values = value
        .get("data")
        .and_then(Value::as_array)
        .filter(|a| a.len() == 1)
        .and_then(|a| a.first())
        .and_then(|v| v.get("embedding"))
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty() && a.len() <= 16000)
        .ok_or_else(unavailable)?;
    let mut parts = Vec::with_capacity(values.len());
    let mut nonzero = false;
    for v in values {
        let n = v.as_f64().ok_or_else(unavailable)? as f32;
        if !n.is_finite() {
            return Err(unavailable());
        }
        nonzero |= n != 0.0;
        parts.push(n.to_string());
    }
    if !nonzero {
        return Err(unavailable());
    }
    Ok((format!("[{}]", parts.join(",")), values.len() as i32))
}
fn background_meta() -> RequestMeta {
    RequestMeta {
        ip: String::new(),
        user_agent: "assist-worker".into(),
        request_id: Uuid::new_v4().to_string(),
    }
}

pub(crate) async fn embed(
    state: &AppState,
    config: &AiConfig,
    owner: Uuid,
    meta: RequestMeta,
    input: &str,
) -> AppResult<(String, i32)> {
    let model = model(config)?;
    let input = bounded(input);
    let estimate = ((input.chars().count() as i64) + 2) / 3;
    let mut reservation =
        Reservation::reserve(&state.db, owner, meta, estimate, config, model).await?;
    reservation.set_usage(Usage {
        input: estimate,
        output: 0,
    });
    let key = config.key.as_ref().ok_or_else(unavailable)?;
    let result = async {
        let response = state
            .http
            .post(format!("{}/embeddings", config.base.trim_end_matches('/')))
            .bearer_auth(key.expose_secret())
            .timeout(config.timeout.min(Duration::from_secs(60)))
            .json(&json!({"model": model, "input": input}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| unavailable())?;
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        let result = vector(&value)?;
        if let Some(tokens) = value
            .pointer("/usage/prompt_tokens")
            .and_then(Value::as_i64)
            .filter(|n| (0..=1_000_000_000).contains(n))
        {
            reservation.set_usage(Usage {
                input: tokens,
                output: 0,
            });
        }
        Ok(result)
    }
    .await;
    reservation.finish().await;
    result
}

#[derive(sqlx::FromRow)]
struct Job {
    record_id: Uuid,
    generation: i64,
    attempts: i32,
    owner_id: Uuid,
    entity: String,
    data: Value,
    version: i32,
}
async fn claim(state: &AppState) -> AppResult<Option<Job>> {
    Ok(sqlx::query_as::<_, Job>("with candidate as (select q.record_id from assist_embedding_queue q where q.available_at <= now() and (q.lease_until is null or q.lease_until < now()) order by q.available_at for update skip locked limit 1), claimed as (update assist_embedding_queue q set lease_until=now()+interval '2 minutes', generation=q.generation+1 from candidate c where q.record_id=c.record_id returning q.record_id,q.generation,q.attempts) select c.record_id,c.generation,c.attempts,r.owner_id,r.entity,r.data,r.version from claimed c join records r on r.id=c.record_id")
        .fetch_optional(&state.db).await?)
}
async fn discard(state: &AppState, job: &Job) -> AppResult<()> {
    sqlx::query("delete from assist_embedding_queue where record_id=$1 and generation=$2")
        .bind(job.record_id)
        .bind(job.generation)
        .execute(&state.db)
        .await?;
    Ok(())
}
async fn retry(state: &AppState, job: &Job, error: &AppError) -> AppResult<()> {
    let quota = matches!(error.code, ErrorCode::LimitReached | ErrorCode::RateLimited);
    let delay = if matches!(error.code, ErrorCode::LimitReached) {
        3600_i64
    } else {
        (5_i64 * (1_i64 << job.attempts.clamp(0, 9))).min(3600)
    };
    sqlx::query("update assist_embedding_queue set attempts=least(attempts+1, 100), available_at=now()+make_interval(secs => $3::double precision), lease_until=null,last_error='Embedding unavailable' where record_id=$1 and generation=$2")
        .bind(job.record_id).bind(job.generation).bind(delay as f64).execute(&state.db).await?;
    if quota {
        sqlx::query("update assist_embedding_queue q set available_at=greatest(q.available_at,now()+make_interval(secs => $2::double precision)) from records r where q.record_id=r.id and r.owner_id=$1 and q.lease_until is null")
            .bind(job.owner_id).bind(if error.code == ErrorCode::LimitReached { 3600_f64 } else { 60_f64 }).execute(&state.db).await?;
    }
    Ok(())
}
async fn finish(
    state: &AppState,
    job: &Job,
    model: &str,
    literal: &str,
    dimensions: i32,
) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    // Hold the membership and team locks until the vector commits.
    let team_id: Option<Uuid> = sqlx::query_scalar("select team_id from records where id=$1")
        .bind(job.record_id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
    if let Some(team) = team_id {
        let locked: Option<Uuid> = sqlx::query_scalar("select t.id from teams t join team_members m on m.team_id=t.id join users u on u.id=m.user_id where t.id=$1 and m.user_id=$2 and t.deleted_at is null and u.deleted_at is null and u.status='active' for update of t,m,u")
            .bind(team).bind(job.owner_id).fetch_optional(&mut *tx).await?;
        if locked.is_none() {
            return Ok(());
        }
    }
    let current: Option<(i32,)> = sqlx::query_as(
        "select r.version from records r join users u on u.id=r.owner_id where r.id=$1 and r.owner_id=$2 and r.deleted_at is null and u.deleted_at is null and u.status='active' and (r.team_id is null or exists (select 1 from team_members tm join teams t on t.id=tm.team_id where tm.team_id=r.team_id and tm.user_id=r.owner_id and t.deleted_at is null)) for update of r",
    )
    .bind(job.record_id)
    .bind(job.owner_id)
    .fetch_optional(&mut *tx)
    .await?;
    if current != Some((job.version,)) {
        return Ok(());
    }
    let claimed: Option<Uuid> = sqlx::query_scalar("delete from assist_embedding_queue where record_id=$1 and generation=$2 and lease_until > now() returning record_id")
        .bind(job.record_id).bind(job.generation).fetch_optional(&mut *tx).await?;
    if claimed.is_none() {
        return Ok(());
    }
    sqlx::query("insert into assist_embedding_models(model,dimensions) values($1,$2) on conflict do nothing").bind(model).bind(dimensions).execute(&mut *tx).await?;
    let expected: i32 =
        sqlx::query_scalar("select dimensions from assist_embedding_models where model=$1")
            .bind(model)
            .fetch_one(&mut *tx)
            .await?;
    if expected != dimensions {
        return Err(unavailable());
    }
    sqlx::query("insert into assist_embeddings(record_id,model,dimensions,record_version,embedding) values($1,$2,$3,$4,$5::text::vector) on conflict(record_id) do update set model=excluded.model,dimensions=excluded.dimensions,record_version=excluded.record_version,embedding=excluded.embedding")
        .bind(job.record_id).bind(model).bind(dimensions).bind(job.version).bind(literal).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
async fn process(
    state: &AppState,
    registry: &EntityRegistry,
    config: &AiConfig,
    job: &Job,
) -> AppResult<()> {
    let active: bool = sqlx::query_scalar("select exists(select 1 from records r join users u on u.id=r.owner_id where r.id=$1 and r.deleted_at is null and u.deleted_at is null and u.status='active' and (r.team_id is null or exists (select 1 from team_members tm join teams t on t.id=tm.team_id where tm.team_id=r.team_id and tm.user_id=r.owner_id and t.deleted_at is null)))").bind(job.record_id).fetch_one(&state.db).await?;
    let Ok(def) = registry.definition(&job.entity) else {
        return discard(state, job).await;
    };
    if !active || def.searchable.is_empty() {
        return discard(state, job).await;
    }
    let input = def
        .searchable
        .iter()
        .filter_map(|field| job.data.get(field).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if input.trim().is_empty() {
        return discard(state, job).await;
    }
    let (literal, dimensions) =
        embed(state, config, job.owner_id, background_meta(), &input).await?;
    finish(state, job, model(config)?, &literal, dimensions).await
}

pub fn spawn_worker(state: AppState) -> tokio::task::JoinHandle<()> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return tokio::spawn(async {});
    }
    tokio::spawn(async move {
        let registry = match records::load_registry(&state.config.entities_path) {
            Ok(r) => r,
            Err(_) => {
                RUNNING.store(false, Ordering::Release);
                return;
            }
        };
        let config = ai::config::global();
        let mut seeded = false;
        loop {
            if configured(&config) && model(&config).is_ok() {
                if !seeded {
                    let result = sqlx::query("insert into assist_embedding_queue(record_id) select r.id from records r left join assist_embeddings e on e.record_id=r.id and e.model=$1 and e.record_version=r.version where r.deleted_at is null and e.record_id is null on conflict do nothing").bind(config.embedding_model.as_deref()).execute(&state.db).await;
                    seeded = result.is_ok();
                }
                if let Ok(Some(job)) = claim(&state).await {
                    if let Err(error) = process(&state, &registry, &config, &job).await {
                        let _ = retry(&state, &job, &error).await;
                    }
                    continue;
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::tests::{registry, state, user};
    use axum::{Json, Router, routing::post};
    use std::{collections::HashSet, sync::Arc};
    use tokio::sync::Mutex;

    fn config(base: String) -> AiConfig {
        AiConfig {
            base,
            key: Some(secrecy::SecretString::from("secret")),
            model: String::new(),
            embedding_model: Some("embed-test".into()),
            allowed: HashSet::new(),
            system: String::new(),
            max_output: 20,
            daily: 200000,
            timeout: Duration::from_secs(3),
            valid: true,
        }
    }
    async fn provider() -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let copy = seen.clone();
        let app = Router::new().route(
            "/embeddings",
            post(move |Json(body): Json<Value>| {
                let copy = copy.clone();
                async move {
                    let input = body["input"].as_str().unwrap_or_default().to_owned();
                    copy.lock().await.push(body);
                    let embedding = if input.contains("second") {
                        json!([0.0, 1.0])
                    } else {
                        json!([1.0, 0.0])
                    };
                    Json(json!({"data":[{"embedding":embedding}],"usage":{"prompt_tokens":3}}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (base, seen, task)
    }
    async fn insert(db: &sqlx::PgPool, owner: Uuid, title: &str) -> Uuid {
        sqlx::query_scalar(
            "insert into records(entity,owner_id,data) values('notes',$1,$2) returning id",
        )
        .bind(owner)
        .bind(json!({"title":title,"secret":"never sent"}))
        .fetch_one(db)
        .await
        .unwrap()
    }
    #[test]
    fn vectors_are_bounded_finite_and_nonzero() {
        assert!(vector(&json!({"data":[{"embedding":[1.0,0.0]}]})).is_ok());
        assert!(vector(&json!({"data":[{"embedding":[]}]})).is_err());
        assert!(vector(&json!({"data":[{"embedding":[0,0]}]})).is_err());
        assert!(vector(&json!({"data":[{"embedding":[1e100]}]})).is_err());
        for size in [1536, 3072, 16000] {
            assert!(vector(&json!({"data":[{"embedding":vec![1;size]}]})).is_ok());
        }
        assert!(vector(&json!({"data":[{"embedding":vec![1;16001]}]})).is_err());
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn revoked_team_owner_cannot_commit_embedding(db: sqlx::PgPool) {
        let state = state(db.clone());
        let owner = user(&db).await;
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('A','embedding-a',$1) returning id",
        )
        .bind(owner.id)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'member')")
            .bind(team)
            .bind(owner.id)
            .execute(&db)
            .await
            .unwrap();
        let id: Uuid = sqlx::query_scalar("insert into records(entity,owner_id,team_id,data) values('notes',$1,$2,$3) returning id").bind(owner.id).bind(team).bind(json!({"title":"first"})).fetch_one(&db).await.unwrap();
        let job = claim(&state).await.unwrap().unwrap();
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(owner.id)
            .execute(&db)
            .await
            .unwrap();
        finish(&state, &job, "embed-test", "[1,0]", 2)
            .await
            .unwrap();
        let count: i64 =
            sqlx::query_scalar("select count(*) from assist_embeddings where record_id=$1")
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn queue_leases_invalidate_old_results_and_retry(db: sqlx::PgPool) {
        let state = state(db.clone());
        let owner = user(&db).await;
        let id = insert(&db, owner.id, "first").await;
        let first = claim(&state).await.unwrap().unwrap();
        sqlx::query("update records set data=$2,version=version+1 where id=$1")
            .bind(id)
            .bind(json!({"title":"second"}))
            .execute(&db)
            .await
            .unwrap();
        finish(&state, &first, "embed-test", "[1,0]", 2)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("select count(*) from assist_embeddings")
                .fetch_one(&db)
                .await
                .unwrap(),
            0
        );
        let second = claim(&state).await.unwrap().unwrap();
        retry(&state, &second, &unavailable()).await.unwrap();
        assert!(claim(&state).await.unwrap().is_none());
        sqlx::query("update assist_embedding_queue set available_at=now()-interval '1 second',lease_until=now()-interval '1 second'").execute(&db).await.unwrap();
        let third = claim(&state).await.unwrap().unwrap();
        finish(&state, &second, "embed-test", "[1,0]", 2)
            .await
            .unwrap();
        finish(&state, &third, "embed-test", "[0,1]", 2)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i32>(
                "select record_version from assist_embeddings where record_id=$1"
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap(),
            2
        );
        sqlx::query("update records set deleted_at=now() where id=$1")
            .bind(id)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("select (select count(*) from assist_embeddings)+(select count(*) from assist_embedding_queue)").fetch_one(&db).await.unwrap(),0);
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn hidden_records_are_visible_only_to_their_owner(db: sqlx::PgPool) {
        let state = state(db.clone());
        let owner = user(&db).await;
        let other = user(&db).await;
        let registry = registry();
        let (base, _seen, task) = provider().await;
        let config = config(base);
        let visible = insert(&db, owner.id, "first visible").await;
        let hidden = insert(&db, owner.id, "first hidden").await;
        // Hide before the queue runs, so the embedding matches the moderated version.
        sqlx::query("update records set admin_hidden_at=now(),version=version+1 where id=$1")
            .bind(hidden)
            .execute(&db)
            .await
            .unwrap();
        let _other_record = insert(&db, other.id, "first other").await;
        while let Some(job) = claim(&state).await.unwrap() {
            process(&state, &registry, &config, &job).await.unwrap();
        }
        let owner_rows = crate::search_records_with_config(
            &state, &registry, &owner, "notes", "first", 10, &config,
        )
        .await
        .unwrap();
        let owner_ids: Vec<String> = owner_rows
            .iter()
            .map(|row| row["record"]["id"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert!(owner_ids.contains(&hidden.to_string()));
        assert!(owner_ids.contains(&visible.to_string()));
        let hidden_row = owner_rows
            .iter()
            .find(|row| row["record"]["id"] == hidden.to_string())
            .unwrap();
        assert_eq!(hidden_row["record"]["moderationHidden"], true);

        let other_rows = crate::search_records_with_config(
            &state, &registry, &other, "notes", "first", 10, &config,
        )
        .await
        .unwrap();
        assert!(
            other_rows
                .iter()
                .all(|row| row["record"]["id"] != hidden.to_string()
                    && row["record"]["id"] != visible.to_string())
        );
        assert_eq!(
            crate::owned_read(&state, &registry, &other, "notes", hidden)
                .await
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            crate::owned_read(&state, &registry, &owner, "notes", hidden)
                .await
                .unwrap()["moderationHidden"],
            true
        );

        // The keyword fallback (no embedding model) must follow the same owner rule.
        let mut plain = config;
        plain.embedding_model = None;
        let fallback_other = crate::search_records_with_config(
            &state, &registry, &other, "notes", "first", 10, &plain,
        )
        .await
        .unwrap();
        assert!(
            fallback_other
                .iter()
                .all(|row| row["record"]["id"] != hidden.to_string()
                    && row["record"]["id"] != visible.to_string())
        );
        let fallback_owner = crate::search_records_with_config(
            &state, &registry, &owner, "notes", "first", 10, &plain,
        )
        .await
        .unwrap();
        assert!(
            fallback_owner
                .iter()
                .any(|row| row["record"]["id"] == hidden.to_string())
        );
        task.abort();
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn mock_embedding_search_is_owner_bound_metered_and_dimension_checked(db: sqlx::PgPool) {
        let state = state(db.clone());
        let owner = user(&db).await;
        let other = user(&db).await;
        let registry = registry();
        let (base, seen, task) = provider().await;
        let config = config(base);
        let first = insert(&db, owner.id, "first").await;
        let second = insert(&db, owner.id, "second").await;
        let _foreign = insert(&db, other.id, "first foreign").await;
        let team: Uuid = sqlx::query_scalar("insert into teams(name,slug,created_by) values('Team','semantic-team',$1) returning id").bind(owner.id).fetch_one(&db).await.unwrap();
        let other_team: Uuid = sqlx::query_scalar("insert into teams(name,slug,created_by) values('Other','semantic-other',$1) returning id").bind(other.id).fetch_one(&db).await.unwrap();
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$3,'owner'),($2,$4,'owner'),($2,$3,'viewer')").bind(team).bind(other_team).bind(owner.id).bind(other.id).execute(&db).await.unwrap();
        let owned_team = insert(&db, owner.id, "first team").await;
        let foreign_team = insert(&db, other.id, "first other team").await;
        sqlx::query("update records set team_id=$2 where id=$1")
            .bind(owned_team)
            .bind(team)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("update records set team_id=$2 where id=$1")
            .bind(foreign_team)
            .bind(other_team)
            .execute(&db)
            .await
            .unwrap();
        while let Some(job) = claim(&state).await.unwrap() {
            process(&state, &registry, &config, &job).await.unwrap();
        }
        let requests = seen.lock().await.clone();
        assert_eq!(requests.len(), 5);
        assert!(
            requests.iter().all(|v| v["model"] == "embed-test"
                && !v["input"].as_str().unwrap().contains("never sent"))
        );
        let rows = crate::search_records_with_config(
            &state, &registry, &owner, "notes", "second", 10, &config,
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["record"]["id"], second.to_string());
        assert!(
            rows.iter()
                .any(|row| row["record"]["id"] == first.to_string())
        );
        assert!(
            rows.iter()
                .any(|row| row["record"]["id"] == owned_team.to_string())
        );
        assert!(
            !rows
                .iter()
                .any(|row| row["record"]["id"] == foreign_team.to_string())
        );
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(owner.id)
            .execute(&db)
            .await
            .unwrap();
        let after = crate::search_records_with_config(
            &state, &registry, &owner, "notes", "second", 10, &config,
        )
        .await
        .unwrap();
        assert_eq!(after.len(), 2);
        assert!(
            !after
                .iter()
                .any(|row| row["record"]["id"] == owned_team.to_string())
        );
        let usage: (i32, i64, i64) = sqlx::query_as(
            "select requests,input_tokens,output_tokens from ai_usage where user_id=$1",
        )
        .bind(owner.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(usage, (5, 15, 0));
        sqlx::query("update assist_embedding_models set dimensions=3 where model='embed-test'")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            crate::search_records_with_config(
                &state, &registry, &owner, "notes", "second", 10, &config
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::Unavailable
        );
        let mut missing = config;
        missing.embedding_model = None;
        let rows = crate::search_records_with_config(
            &state, &registry, &owner, "notes", "first", 10, &missing,
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        task.abort();
    }
}
