use crate::routes::Delivery;
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use kernel::{AppError, AppResult, AppState, crypto};
use rand::{Rng, rngs::OsRng};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use std::{sync::Arc, time::Duration};
use time::OffsetDateTime;
use uuid::Uuid;

const KIND: &str = "webhooks.delivery";
const OUTBOX_KIND: &str = "webhooks.record_outbox";
const DISABLE_KIND: &str = "webhooks.disable_check";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DisableJob {
    hook_id: Uuid,
    failure_since: OffsetDateTime,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    delivery_id: Uuid,
    event_id: Uuid,
    created_at: OffsetDateTime,
}

/// Test deliveries carry a synthetic payload, not a record event.
pub(crate) async fn enqueue_test(
    tx: &mut Transaction<'_, Postgres>,
    hook_id: Uuid,
) -> AppResult<Delivery> {
    let event_id = Uuid::new_v4();
    let delivery: Delivery = sqlx::query_as("insert into webhook_deliveries(webhook_id,event_id,status,is_test) values($1,$2,'pending',true) returning id,event_id,status,response_code,duration_ms,attempt,next_retry_at,created_at,updated_at")
        .bind(hook_id).bind(event_id).fetch_one(&mut **tx).await?;
    let delivery_id: Uuid =
        sqlx::query_scalar("select id from webhook_deliveries where webhook_id=$1 and event_id=$2")
            .bind(hook_id)
            .bind(event_id)
            .fetch_one(&mut **tx)
            .await?;
    let job = Job {
        delivery_id,
        event_id,
        created_at: OffsetDateTime::now_utc(),
    };
    sqlx::query("insert into jobs(kind,payload) values($1,$2)")
        .bind(KIND)
        .bind(serde_json::to_value(job).map_err(AppError::internal)?)
        .execute(&mut **tx)
        .await?;
    Ok(delivery)
}

/// Register once in the jobs registry. Each attempt uses the secret current when it starts.
pub fn register_jobs(registry: &mut jobs::Registry, state: AppState) -> anyhow::Result<()> {
    let entities = Arc::new(records::load_registry(&state.config.entities_path)?);
    register_jobs_with_registry(registry, state, entities)
}

/// Register with the same entity policy used by the records API.
pub fn register_jobs_with_registry(
    registry: &mut jobs::Registry,
    state: AppState,
    entities: Arc<records::EntityRegistry>,
) -> anyhow::Result<()> {
    let poll_state = state.clone();
    let poll_entities = entities.clone();
    registry.register_claim_handler(
        OUTBOX_KIND,
        Arc::new(move |_, claim| {
            let state = poll_state.clone();
            let entities = poll_entities.clone();
            Box::pin(async move { poll_outbox(&state, &entities, claim).await })
        }),
    )?;
    let delivery_state = state.clone();
    registry.register_claim_handler(
        KIND,
        Arc::new(move |value, claim| {
            let state = delivery_state.clone();
            let entities = entities.clone();
            Box::pin(async move {
                dispatch(&state, &entities, serde_json::from_value(value)?, claim).await
            })
        }),
    )?;
    registry.register_claim_handler(
        DISABLE_KIND,
        Arc::new(move |value, claim| {
            let state = state.clone();
            Box::pin(
                async move { disable_check(&state, serde_json::from_value(value)?, claim).await },
            )
        }),
    )
}

#[derive(sqlx::FromRow)]
struct Event {
    id: Uuid,
    record_id: Uuid,
    entity: String,
    owner_id: Uuid,
    team_id: Option<Uuid>,
    /// 'created', 'updated' or 'deleted'; the event type is `record.<op>`.
    op: String,
    created_at: OffsetDateTime,
}

async fn current_record(
    state: &AppState,
    entities: &records::EntityRegistry,
    event: &Event,
    hook: Uuid,
) -> anyhow::Result<Option<serde_json::Value>> {
    // Check scope and creator status independently of record visibility, including admin viewers.
    let user: Option<(Uuid, String, String, String)> = sqlx::query_as(
        "select u.id,u.email::text,u.display_name,u.role from webhooks w join users u on u.id=w.owner_id join records r on r.id=$2 and r.entity=$3 and r.owner_id=$4 and r.team_id is not distinct from $5 join users record_owner on record_owner.id=r.owner_id and record_owner.status='active' and record_owner.deleted_at is null where w.id=$1 and w.active and u.status='active' and u.deleted_at is null and r.deleted_at is null and r.admin_hidden_at is null and ((w.team_id is null and r.team_id is null and w.owner_id=r.owner_id) or (w.team_id=r.team_id and exists(select 1 from team_members m join teams t on t.id=m.team_id where m.team_id=w.team_id and m.user_id=w.owner_id and m.role in ('admin','owner') and t.deleted_at is null)))")
        .bind(hook).bind(event.record_id).bind(&event.entity).bind(event.owner_id).bind(event.team_id)
        .fetch_optional(&state.db).await?;
    let Some((id, email, display_name, role)) = user else {
        return Ok(None);
    };
    let is_admin = role == "admin"
        || state
            .config
            .admin_emails
            .contains(&email.to_ascii_lowercase());
    let viewer = kernel::viewer::Viewer {
        id,
        session_id: Uuid::nil(),
        email,
        display_name,
        role: if is_admin {
            kernel::viewer::Role::Admin
        } else {
            kernel::viewer::Role::User
        },
        via_cookie: false,
    };
    match records::api::read(
        state,
        entities,
        Some(&viewer),
        &event.entity,
        event.record_id,
    )
    .await
    {
        Ok(record) => Ok(Some(record)),
        Err(e)
            if matches!(
                e.code,
                kernel::ErrorCode::NotFound | kernel::ErrorCode::Forbidden
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

/// A deleted record can't be read back, so its scope comes from the outbox row. Only the id and entity are sent.
/// Admin-hidden records stay hidden, even after they are deleted.
async fn deleted_in_scope(state: &AppState, event: &Event, hook: Uuid) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar("select exists(select 1 from webhooks w join users u on u.id=w.owner_id where w.id=$1 and w.active and u.status='active' and u.deleted_at is null and ((w.team_id is null and $4::uuid is null and w.owner_id=$3) or (w.team_id=$4 and exists(select 1 from team_members m join teams t on t.id=m.team_id where m.team_id=w.team_id and m.user_id=w.owner_id and m.role in ('admin','owner') and t.deleted_at is null))) and not exists(select 1 from records r where r.id=$2 and r.admin_hidden_at is not null))")
        .bind(hook).bind(event.record_id).bind(event.owner_id).bind(event.team_id)
        .fetch_one(&state.db).await?)
}

/// Whether this hook may get this event now. Delivery checks access again, so this is only a filter.
async fn hook_may_receive(
    state: &AppState,
    entities: &records::EntityRegistry,
    event: &Event,
    hook: Uuid,
) -> anyhow::Result<bool> {
    if event.op == "deleted" {
        deleted_in_scope(state, event, hook).await
    } else {
        Ok(current_record(state, entities, event, hook)
            .await?
            .is_some())
    }
}

async fn domain_body(
    state: &AppState,
    entities: &records::EntityRegistry,
    hook: Uuid,
    event_id: Uuid,
) -> anyhow::Result<Option<Vec<u8>>> {
    let event: Option<Event> = sqlx::query_as("select id,record_id,entity,owner_id,team_id,op,created_at from webhook_record_outbox where id=$1")
        .bind(event_id).fetch_optional(&state.db).await?;
    let Some(event) = event else {
        return Ok(None);
    };
    let data = if event.op == "deleted" {
        if !deleted_in_scope(state, &event, hook).await? {
            return Ok(None);
        }
        json!({"id":event.record_id,"entity":event.entity})
    } else {
        let Some(record) = current_record(state, entities, &event, hook).await? else {
            return Ok(None);
        };
        record
    };
    Ok(Some(serde_json::to_vec(
        &json!({"id":event.id,"type":format!("record.{}", event.op),"createdAt":event.created_at.format(&time::format_description::well_known::Rfc3339)?,"data":data}),
    )?))
}

async fn poll_outbox(
    state: &AppState,
    entities: &records::EntityRegistry,
    claim: jobs::ClaimContext,
) -> anyhow::Result<jobs::Outcome> {
    let mut tx = state.db.begin().await?;
    if !claim_valid(&mut tx, claim).await? {
        return Ok(jobs::Outcome::PermanentFailure);
    }
    let events: Vec<Event> = sqlx::query_as("select id,record_id,entity,owner_id,team_id,op,created_at from webhook_record_outbox where processed_at is null order by created_at,id limit 100 for update skip locked")
        .fetch_all(&mut *tx).await?;
    for event in events {
        // A subscription matches the event name, the wildcard, or that name for one entity.
        let name = format!("record.{}", event.op);
        let filters = vec![
            "*".to_string(),
            name.clone(),
            format!("{name}:*"),
            format!("{name}:{}", event.entity),
        ];
        let hooks: Vec<Uuid> = sqlx::query_scalar("select id from webhooks where active and ((team_id is null and $1::uuid is null and owner_id=$2) or (team_id is not null and team_id=$1)) and events && $3::text[]")
            .bind(event.team_id).bind(event.owner_id).bind(filters).fetch_all(&mut *tx).await?;
        for hook in hooks {
            if !hook_may_receive(state, entities, &event, hook).await? {
                continue;
            }
            let delivery_id: Option<Uuid> = sqlx::query_scalar("insert into webhook_deliveries(webhook_id,event_id,status) values($1,$2,'pending') on conflict(webhook_id,event_id) do nothing returning id")
                .bind(hook).bind(event.id).fetch_optional(&mut *tx).await?;
            if let Some(delivery_id) = delivery_id {
                let payload = serde_json::to_value(Job {
                    delivery_id,
                    event_id: event.id,
                    created_at: event.created_at,
                })?;
                jobs::enqueue_in_tx(
                    &mut tx,
                    KIND,
                    payload,
                    None,
                    Some(&format!("{}:{}", event.id, hook)),
                )
                .await?;
            }
        }
        sqlx::query("update webhook_record_outbox set processed_at=now() where id=$1")
            .bind(event.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(jobs::Outcome::Done)
}

fn retry_seconds(attempt: i32) -> u64 {
    let base = match attempt {
        1 => 60,
        2 => 300,
        3 => 1800,
        4 => 7200,
        5 => 14400,
        6 => 21600,
        _ => 41040,
    };
    // Symmetric jitter keeps the overall retry window close to one day.
    OsRng.gen_range(base * 9 / 10..=base * 11 / 10)
}

async fn dispatch(
    state: &AppState,
    entities: &records::EntityRegistry,
    job: Job,
    claim: jobs::ClaimContext,
) -> anyhow::Result<jobs::Outcome> {
    // The creator must still be active and a current team administrator.
    let row: Option<(Uuid, String, Vec<u8>)> = sqlx::query_as("select w.id,w.url,w.secret_ciphertext from webhook_deliveries d join webhooks w on w.id=d.webhook_id join users u on u.id=w.owner_id where d.id=$1 and d.event_id=$2 and w.active and u.status='active' and u.deleted_at is null and (w.team_id is null or exists(select 1 from team_members m join teams t on t.id=m.team_id where m.team_id=w.team_id and m.user_id=w.owner_id and m.role in ('admin','owner') and t.deleted_at is null))")
        .bind(job.delivery_id).bind(job.event_id).fetch_optional(&state.db).await?;
    let Some((hook_id, url, encrypted)) = row else {
        let mut tx = state.db.begin().await?;
        let valid: bool = sqlx::query_scalar("select exists(select 1 from jobs where id=$1 and status='running' and locked_by=$2 and locked_until > now() for update)")
            .bind(claim.id).bind(claim.token).fetch_one(&mut *tx).await?;
        if valid {
            sqlx::query("update webhook_deliveries set status='failed', attempt=$2, next_retry_at=null where id=$1")
                .bind(job.delivery_id).bind(claim.attempt).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        return Ok(jobs::Outcome::PermanentFailure);
    };
    let key = crypto::hmac_sha256(
        state.config.code_pepper.expose_secret().as_bytes(),
        &[b"webhooks.secret.aes256gcm.v1"],
    );
    let secret = Aes256Gcm::new_from_slice(&key).ok().and_then(|cipher| {
        let nonce: [u8; 12] = encrypted.get(..12)?.try_into().ok()?;
        cipher
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &encrypted[12..],
                    aad: hook_id.as_bytes(),
                },
            )
            .ok()
    });
    let Some(secret) = secret else {
        let mut tx = state.db.begin().await?;
        if claim_valid(&mut tx, claim).await? {
            sqlx::query("update webhook_deliveries set status='failed', attempt=$2, next_retry_at=null where id=$1")
                .bind(job.delivery_id).bind(claim.attempt).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        return Ok(jobs::Outcome::PermanentFailure);
    };
    let is_test: bool = sqlx::query_scalar("select is_test from webhook_deliveries where id=$1")
        .bind(job.delivery_id)
        .fetch_one(&state.db)
        .await?;
    let body = if is_test {
        test_body(job.event_id, job.created_at)?
    } else {
        let Some(body) = domain_body(state, entities, hook_id, job.event_id).await? else {
            let mut tx = state.db.begin().await?;
            if claim_valid(&mut tx, claim).await? {
                sqlx::query("update webhook_deliveries set status='failed',attempt=$2,next_retry_at=null where id=$1")
                    .bind(job.delivery_id).bind(claim.attempt).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            return Ok(jobs::Outcome::PermanentFailure);
        };
        body
    };
    let timestamp = OffsetDateTime::now_utc().unix_timestamp().to_string();
    let result = crate::deliver(
        &url,
        state.config.is_production(),
        &job.event_id.to_string(),
        &timestamp,
        &secret,
        &body,
    )
    .await;
    let code = result.as_ref().ok().map(|r| i32::from(r.status));
    let duration = result
        .as_ref()
        .ok()
        .map(|r| i32::try_from(r.duration_ms).unwrap_or(i32::MAX));
    let success = code.is_some_and(|c| (200..300).contains(&c));
    let retryable = code.is_none_or(|c| c == 408 || c == 429 || c >= 500);
    let retry = !success && retryable && claim.attempt < 8;
    let delay = retry_seconds(claim.attempt);
    let mut tx = state.db.begin().await?;
    // Locking the job serializes this write with claim and prevents expired workers overwriting it.
    let valid: bool = sqlx::query_scalar("select exists(select 1 from jobs where id=$1 and status='running' and locked_by=$2 and locked_until > now() for update)")
        .bind(claim.id).bind(claim.token).fetch_one(&mut *tx).await?;
    if !valid {
        return Ok(jobs::Outcome::PermanentFailure);
    }
    sqlx::query("update webhook_deliveries set status=$2,response_code=$3,duration_ms=$4,attempt=$5,next_retry_at=case when $6 then now()+($7 * interval '1 second') else null end where id=$1")
        .bind(job.delivery_id).bind(if success { "delivered" } else if retry { "pending" } else { "failed" }).bind(code).bind(duration).bind(claim.attempt).bind(retry).bind(delay as f64).execute(&mut *tx).await?;
    if success {
        sqlx::query("update webhooks set failure_since=null where id=$1")
            .bind(hook_id)
            .execute(&mut *tx)
            .await?;
    } else {
        let since: Option<OffsetDateTime> = sqlx::query_scalar("update webhooks set failure_since=now() where id=$1 and failure_since is null and active returning failure_since")
            .bind(hook_id).fetch_optional(&mut *tx).await?;
        if let Some(failure_since) = since {
            let payload = serde_json::to_value(DisableJob {
                hook_id,
                failure_since,
            })?;
            sqlx::query(
                "insert into jobs(kind,payload,run_at) values($1,$2,$3 + interval '3 days')",
            )
            .bind(DISABLE_KIND)
            .bind(payload)
            .bind(failure_since)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(if success {
        jobs::Outcome::Done
    } else if retry {
        jobs::Outcome::RetryAfter(Duration::from_secs(delay))
    } else {
        jobs::Outcome::PermanentFailure
    })
}

fn test_body(event_id: Uuid, created_at: OffsetDateTime) -> anyhow::Result<Vec<u8>> {
    Ok(serde_json::to_vec(
        &json!({"id":event_id,"type":"webhook.test","createdAt":created_at.format(&time::format_description::well_known::Rfc3339)?,"data":{}}),
    )?)
}

async fn claim_valid(
    tx: &mut Transaction<'_, Postgres>,
    claim: jobs::ClaimContext,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar("select exists(select 1 from jobs where id=$1 and status='running' and locked_by=$2 and locked_until > now() for update)")
        .bind(claim.id).bind(claim.token).fetch_one(&mut **tx).await?)
}

async fn disable_check(
    state: &AppState,
    job: DisableJob,
    claim: jobs::ClaimContext,
) -> anyhow::Result<jobs::Outcome> {
    let mut tx = state.db.begin().await?;
    if !claim_valid(&mut tx, claim).await? {
        return Ok(jobs::Outcome::PermanentFailure);
    }
    let disabled: Option<Uuid> = sqlx::query_scalar("update webhooks set active=false where id=$1 and active and failure_since=$2 and failure_since <= now()-interval '3 days' returning id")
        .bind(job.hook_id).bind(job.failure_since).fetch_optional(&mut *tx).await?;
    if let Some(id) = disabled {
        sqlx::query("insert into audit_log(action,target_type,target_id,meta) values('webhook.disabled','webhook',$1,'{}'::jsonb)")
            .bind(id.to_string()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(jobs::Outcome::Done)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use sqlx::PgPool;

    #[test]
    fn test_event_timestamp_is_rfc3339_text() {
        let body = test_body(Uuid::nil(), OffsetDateTime::UNIX_EPOCH).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["createdAt"], "1970-01-01T00:00:00Z");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn worker_terminal_decryption_failure(db: PgPool) {
        let state = AppState {
            db: db.clone(),
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let owner: Uuid = sqlx::query_scalar("insert into users(email,display_name) values('worker@example.com','Worker') returning id")
            .fetch_one(&db).await.unwrap();
        let hook: Uuid = sqlx::query_scalar("insert into webhooks(owner_id,url,events,secret_ciphertext) values($1,'http://localhost:1/',array['*'],decode('00','hex')) returning id")
            .bind(owner).fetch_one(&db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        enqueue_test(&mut tx, hook).await.unwrap();
        tx.commit().await.unwrap();
        let mut registry = jobs::Registry::new();
        register_jobs_with_registry(
            &mut registry,
            state,
            Arc::new(
                records::EntityRegistry::from_json(include_str!("../../../config/entities.json"))
                    .unwrap(),
            ),
        )
        .unwrap();
        let (shutdown, rx) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(jobs::run(
            db.clone(),
            registry,
            rx,
            Duration::from_secs(30),
            Duration::from_millis(10),
        ));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status: String = sqlx::query_scalar("select status from jobs where kind=$1")
                    .bind(KIND)
                    .fetch_one(&db)
                    .await
                    .unwrap();
                if status == "dead" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        shutdown.send(true).unwrap();
        task.await.unwrap().unwrap();
        let delivery: (String, i32) =
            sqlx::query_as("select status,attempt from webhook_deliveries where webhook_id=$1")
                .bind(hook)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(delivery, ("failed".into(), 1));
        // A terminal decryption failure must not leave a delivery that a later run could pick up.
        let pending: i64 = sqlx::query_scalar(
            "select count(*) from webhook_deliveries where webhook_id=$1 and status='pending'",
        )
        .bind(hook)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(pending, 0);
    }

    /// Stands in for the job runner: a live lease that `claim_valid` accepts.
    async fn running_claim(db: &PgPool) -> jobs::ClaimContext {
        let token = Uuid::new_v4();
        let id: Uuid = sqlx::query_scalar("insert into jobs(kind,payload,status,locked_by,locked_until,attempts) values($1,'{}'::jsonb,'running',$2,now()+interval '1 hour',1) returning id")
            .bind(DISABLE_KIND)
            .bind(token)
            .fetch_one(db)
            .await
            .unwrap();
        jobs::ClaimContext {
            id,
            token,
            attempt: 1,
        }
    }

    /// Creates a webhook whose failure streak began `days_ago` days ago.
    async fn failing_webhook(db: &PgPool, email: &str, days_ago: f64) -> (Uuid, OffsetDateTime) {
        let owner: Uuid = sqlx::query_scalar(
            "insert into users(email,display_name) values($1,'Owner') returning id",
        )
        .bind(email)
        .fetch_one(db)
        .await
        .unwrap();
        let hook: Uuid = sqlx::query_scalar("insert into webhooks(owner_id,url,events,secret_ciphertext,failure_since) values($1,'https://example.com/hook',array['*'],decode('00','hex'),now()-($2*interval '1 day')) returning id")
            .bind(owner)
            .bind(days_ago)
            .fetch_one(db)
            .await
            .unwrap();
        // Read back so the job carries exactly the stored (microsecond) value.
        let since: OffsetDateTime =
            sqlx::query_scalar("select failure_since from webhooks where id=$1")
                .bind(hook)
                .fetch_one(db)
                .await
                .unwrap();
        (hook, since)
    }

    fn test_state(db: PgPool) -> AppState {
        AppState {
            db,
            config: Arc::new(kernel::config::Config::from_env().unwrap()),
            http: reqwest::Client::new(),
            email: Arc::new(kernel::email::LogSender),
            hashing: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    async fn is_active(db: &PgPool, hook: Uuid) -> bool {
        sqlx::query_scalar("select active from webhooks where id=$1")
            .bind(hook)
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn disabled_audit_rows(db: &PgPool, hook: Uuid) -> i64 {
        sqlx::query_scalar(
            "select count(*) from audit_log where action='webhook.disabled' and target_id=$1",
        )
        .bind(hook.to_string())
        .fetch_one(db)
        .await
        .unwrap()
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn disable_check_needs_three_days_and_the_same_streak(db: PgPool) {
        let state = test_state(db.clone());

        // Two days into the streak: the check runs too early and must leave the hook alone.
        let (young, since) = failing_webhook(&db, "young@example.com", 2.0).await;
        let outcome = disable_check(
            &state,
            DisableJob {
                hook_id: young,
                failure_since: since,
            },
            running_claim(&db).await,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, jobs::Outcome::Done));
        assert!(is_active(&db, young).await);
        assert_eq!(disabled_audit_rows(&db, young).await, 0);

        // Four days into the same streak: disable it and record why.
        let (old, since) = failing_webhook(&db, "old@example.com", 4.0).await;
        let outcome = disable_check(
            &state,
            DisableJob {
                hook_id: old,
                failure_since: since,
            },
            running_claim(&db).await,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, jobs::Outcome::Done));
        assert!(!is_active(&db, old).await);
        assert_eq!(disabled_audit_rows(&db, old).await, 1);

        // A success reset the streak after this job was scheduled, so the stale job must not disable it.
        let (reset, current) = failing_webhook(&db, "reset@example.com", 4.0).await;
        let stale = current - time::Duration::days(1);
        let outcome = disable_check(
            &state,
            DisableJob {
                hook_id: reset,
                failure_since: stale,
            },
            running_claim(&db).await,
        )
        .await
        .unwrap();
        assert!(matches!(outcome, jobs::Outcome::Done));
        assert!(is_active(&db, reset).await);
        assert_eq!(disabled_audit_rows(&db, reset).await, 0);
    }

    fn entities() -> Arc<records::EntityRegistry> {
        Arc::new(
            records::EntityRegistry::from_json(include_str!("../../../config/entities.json"))
                .unwrap(),
        )
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn record_http_lifecycle_and_duplicate_rollback(db: PgPool) {
        use axum::{
            Extension,
            body::{Body, to_bytes},
            http::Request,
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tower::ServiceExt;
        let state = test_state(db.clone());
        let owner: Uuid = sqlx::query_scalar("insert into users(email,display_name) values('lifecycle@example.com','Owner') returning id").fetch_one(&db).await.unwrap();
        let viewer = kernel::Viewer {
            id: owner,
            session_id: Uuid::nil(),
            email: "lifecycle@example.com".into(),
            display_name: "Owner".into(),
            role: kernel::viewer::Role::User,
            via_cookie: false,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = stream.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..pos]).to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= pos + 4 + length {
                        let value: serde_json::Value =
                            serde_json::from_slice(&bytes[pos + 4..pos + 4 + length]).unwrap();
                        assert_eq!(value["type"], "record.created");
                        assert_eq!(value["data"]["data"]["title"], "Hello");
                        assert!(value["createdAt"].as_str().unwrap().ends_with('Z'));
                        break;
                    }
                }
            }
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let app = crate::router()
            .merge(records::router(entities()))
            .layer(Extension(viewer))
            .with_state(state.clone());
        let request = |method: &str, path: &str, value: serde_json::Value| {
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap()
        };
        let response = app.clone().oneshot(request("POST", "/webhooks", json!({"url":format!("http://localhost:{port}/"),"events":["record.created:notes"]}))).await.unwrap();
        assert_eq!(response.status(), 200);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 100000).await.unwrap()).unwrap();
        let hook = body["data"]["webhook"]["id"].as_str().unwrap();
        let response = app
            .clone()
            .oneshot(request(
                "POST",
                "/entities/notes",
                json!({"data":{"title":"Hello"}}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
        let mut tx = db.begin().await.unwrap();
        sqlx::query("insert into records(entity,owner_id,data) values('notes',$1,'{}')")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        let count: i64 = sqlx::query_scalar("select count(*) from webhook_record_outbox")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        poll_outbox(&state, &entities(), running_claim(&db).await)
            .await
            .unwrap();
        sqlx::query("update webhook_record_outbox set processed_at=null")
            .execute(&db)
            .await
            .unwrap();
        poll_outbox(&state, &entities(), running_claim(&db).await)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("select count(*) from webhook_deliveries")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let mut registry = jobs::Registry::new();
        register_jobs_with_registry(&mut registry, state, entities()).unwrap();
        let (stop, rx) = tokio::sync::watch::channel(false);
        let worker = tokio::spawn(jobs::run(
            db.clone(),
            registry,
            rx,
            Duration::from_secs(30),
            Duration::from_millis(10),
        ));
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let status: String = sqlx::query_scalar("select status from webhook_deliveries")
                    .fetch_one(&db)
                    .await
                    .unwrap();
                if status == "delivered" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stop.send(true).unwrap();
        worker.await.unwrap().unwrap();
        let response = app
            .oneshot(request(
                "GET",
                &format!("/webhooks/{hook}/deliveries"),
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 100000).await.unwrap()).unwrap();
        assert_eq!(body["data"][0]["status"], "delivered");
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn fanout_scope_and_revocation(db: PgPool) {
        let state = test_state(db.clone());
        let owner: Uuid =
            sqlx::query_scalar("insert into users(email) values('owner@scope.test') returning id")
                .fetch_one(&db)
                .await
                .unwrap();
        let stranger: Uuid = sqlx::query_scalar(
            "insert into users(email) values('stranger@scope.test') returning id",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let team: Uuid = sqlx::query_scalar(
            "insert into teams(name,slug,created_by) values('Team','scope-team',$1) returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query("insert into team_members(team_id,user_id,role) values($1,$2,'admin')")
            .bind(team)
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        let personal: Uuid = sqlx::query_scalar("insert into webhooks(owner_id,url,events,secret_ciphertext) values($1,'https://example.com',array['record.created'],decode('00','hex')) returning id").bind(owner).fetch_one(&db).await.unwrap();
        sqlx::query("insert into webhooks(owner_id,url,events,secret_ciphertext) values($1,'https://example.com',array['*'],decode('00','hex'))").bind(stranger).execute(&db).await.unwrap();
        let team_hook: Uuid = sqlx::query_scalar("insert into webhooks(owner_id,team_id,url,events,secret_ciphertext) values($1,$2,'https://example.com',array['record.created:*'],decode('00','hex')) returning id").bind(owner).bind(team).fetch_one(&db).await.unwrap();
        sqlx::query("insert into records(entity,owner_id,data) values('notes',$1,'{}')")
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into records(entity,owner_id,team_id,data) values('notes',$1,$2,'{}')")
            .bind(owner)
            .bind(team)
            .execute(&db)
            .await
            .unwrap();
        poll_outbox(&state, &entities(), running_claim(&db).await)
            .await
            .unwrap();
        let hooks: Vec<Uuid> =
            sqlx::query_scalar("select webhook_id from webhook_deliveries order by webhook_id")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(hooks.len(), 2);
        assert!(hooks.contains(&personal));
        assert!(hooks.contains(&team_hook));
        let event: Uuid =
            sqlx::query_scalar("select event_id from webhook_deliveries where webhook_id=$1")
                .bind(team_hook)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(
            domain_body(&state, &entities(), team_hook, event)
                .await
                .unwrap()
                .is_some()
        );
        sqlx::query("delete from team_members where team_id=$1 and user_id=$2")
            .bind(team)
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        assert!(
            domain_body(&state, &entities(), team_hook, event)
                .await
                .unwrap()
                .is_none()
        );
        let event: Uuid =
            sqlx::query_scalar("select event_id from webhook_deliveries where webhook_id=$1")
                .bind(personal)
                .fetch_one(&db)
                .await
                .unwrap();
        sqlx::query("update records set admin_hidden_at=now() where id=(select record_id from webhook_record_outbox where id=$1)").bind(event).execute(&db).await.unwrap();
        assert!(
            domain_body(&state, &entities(), personal, event)
                .await
                .unwrap()
                .is_none()
        );
    }

    /// The payload the newest delivery for `hook` would send, as JSON.
    async fn newest_body(state: &AppState, hook: Uuid) -> serde_json::Value {
        let event: Uuid = sqlx::query_scalar("select event_id from webhook_deliveries where webhook_id=$1 order by created_at desc,id desc limit 1")
            .bind(hook)
            .fetch_one(&state.db)
            .await
            .unwrap();
        let body = domain_body(state, &entities(), hook, event)
            .await
            .unwrap()
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn record_create_update_delete_each_queue_one_delivery(db: PgPool) {
        use axum::{
            Extension,
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let state = test_state(db.clone());
        let owner: Uuid = sqlx::query_scalar("insert into users(email,display_name) values('events@example.com','Owner') returning id").fetch_one(&db).await.unwrap();
        let stranger: Uuid = sqlx::query_scalar("insert into users(email,display_name) values('events-stranger@example.com','Stranger') returning id").fetch_one(&db).await.unwrap();
        let viewer = kernel::Viewer {
            id: owner,
            session_id: Uuid::nil(),
            email: "events@example.com".into(),
            display_name: "Owner".into(),
            role: kernel::viewer::Role::User,
            via_cookie: false,
        };
        let app = crate::router()
            .merge(records::router(entities()))
            .layer(Extension(viewer))
            .with_state(state.clone());
        let json_request = |method: &str, path: &str, value: serde_json::Value| {
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap()
        };
        let mut hook_ids = Vec::new();
        for events in [
            json!([
                "record.created:notes",
                "record.updated:notes",
                "record.deleted:notes"
            ]),
            json!(["record.created:notes"]),
        ] {
            let response = app
                .clone()
                .oneshot(json_request(
                    "POST",
                    "/webhooks",
                    json!({"url":"http://localhost:9/","events":events}),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 100000).await.unwrap())
                    .unwrap();
            hook_ids.push(
                body["data"]["webhook"]["id"]
                    .as_str()
                    .unwrap()
                    .parse::<Uuid>()
                    .unwrap(),
            );
        }
        let (all_events, created_only) = (hook_ids[0], hook_ids[1]);
        // A wildcard on someone else's account must never receive this owner's events.
        sqlx::query("insert into webhooks(owner_id,url,events,secret_ciphertext) values($1,'http://localhost:9/',array['*'],decode('00','hex'))")
            .bind(stranger).execute(&db).await.unwrap();

        // Create.
        let response = app
            .clone()
            .oneshot(json_request(
                "POST",
                "/entities/notes",
                json!({"data":{"title":"First"}}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
        let record: Uuid = sqlx::query_scalar("select id from records where owner_id=$1")
            .bind(owner)
            .fetch_one(&db)
            .await
            .unwrap();
        poll_outbox(&state, &entities(), running_claim(&db).await)
            .await
            .unwrap();
        assert_eq!(
            newest_body(&state, all_events).await["type"],
            "record.created"
        );
        assert_eq!(delivery_count(&db, all_events).await, 1);
        assert_eq!(delivery_count(&db, created_only).await, 1);

        // Update: the payload is the record as it is at delivery time.
        let version: i32 = sqlx::query_scalar("select version from records where id=$1")
            .bind(record)
            .fetch_one(&db)
            .await
            .unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/entities/notes/{record}"))
                    .header("content-type", "application/json")
                    .header("if-match", version.to_string())
                    .body(Body::from(json!({"data":{"title":"Second"}}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        poll_outbox(&state, &entities(), running_claim(&db).await)
            .await
            .unwrap();
        let updated = newest_body(&state, all_events).await;
        assert_eq!(updated["type"], "record.updated");
        assert_eq!(updated["data"]["data"]["title"], "Second");
        assert_eq!(delivery_count(&db, all_events).await, 2);
        assert_eq!(delivery_count(&db, created_only).await, 1);

        // Delete (soft): one event, and the payload carries identifiers only.
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/entities/notes/{record}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());
        poll_outbox(&state, &entities(), running_claim(&db).await)
            .await
            .unwrap();
        let deleted = newest_body(&state, all_events).await;
        assert_eq!(deleted["type"], "record.deleted");
        assert_eq!(deleted["data"], json!({"id":record,"entity":"notes"}));
        assert_eq!(delivery_count(&db, all_events).await, 3);
        assert_eq!(delivery_count(&db, created_only).await, 1);
        assert_eq!(delivery_count(&db, stranger_hook(&db).await).await, 0);

        // Exactly one outbox row per change.
        let ops: Vec<String> = sqlx::query_scalar(
            "select op from webhook_record_outbox where record_id=$1 order by created_at,id",
        )
        .bind(record)
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(ops, ["created", "updated", "deleted"]);
    }

    async fn delivery_count(db: &PgPool, hook: Uuid) -> i64 {
        sqlx::query_scalar("select count(*) from webhook_deliveries where webhook_id=$1")
            .bind(hook)
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn stranger_hook(db: &PgPool) -> Uuid {
        sqlx::query_scalar("select w.id from webhooks w join users u on u.id=w.owner_id where u.email='events-stranger@example.com'")
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn hard_delete_is_announced_once_and_not_after_soft_delete(db: PgPool) {
        let state = test_state(db.clone());
        let owner: Uuid = sqlx::query_scalar("insert into users(email,display_name) values('purge@example.com','Owner') returning id").fetch_one(&db).await.unwrap();
        let hook: Uuid = sqlx::query_scalar("insert into webhooks(owner_id,url,events,secret_ciphertext) values($1,'http://localhost:9/',array['record.deleted'],decode('00','hex')) returning id")
            .bind(owner).fetch_one(&db).await.unwrap();
        // Soft delete, then hard delete: the second write must not announce the record again.
        let soft: Uuid = sqlx::query_scalar(
            "insert into records(entity,owner_id,data) values('notes',$1,'{}') returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query("update records set deleted_at=now() where id=$1")
            .bind(soft)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("delete from records where id=$1")
            .bind(soft)
            .execute(&db)
            .await
            .unwrap();
        // A live record removed outright is still announced.
        let hard: Uuid = sqlx::query_scalar(
            "insert into records(entity,owner_id,data) values('notes',$1,'{}') returning id",
        )
        .bind(owner)
        .fetch_one(&db)
        .await
        .unwrap();
        sqlx::query("delete from records where id=$1")
            .bind(hard)
            .execute(&db)
            .await
            .unwrap();
        let ops: Vec<(Uuid, String)> =
            sqlx::query_as("select record_id,op from webhook_record_outbox order by created_at,id")
                .fetch_all(&db)
                .await
                .unwrap();
        let expected_ops = [
            (soft, "created".to_string()),
            (soft, "deleted".to_string()),
            (hard, "created".to_string()),
            (hard, "deleted".to_string()),
        ];
        assert_eq!(ops, expected_ops);

        poll_outbox(&state, &entities(), running_claim(&db).await)
            .await
            .unwrap();
        // Only the subscribed event type is delivered, once per record.
        let events: Vec<Uuid> =
            sqlx::query_scalar("select event_id from webhook_deliveries where webhook_id=$1")
                .bind(hook)
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(events.len(), 2);
        let mut seen = Vec::new();
        for event in events {
            let body = domain_body(&state, &entities(), hook, event)
                .await
                .unwrap()
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let id: Uuid = value["data"]["id"].as_str().unwrap().parse().unwrap();
            seen.push((value["type"].as_str().unwrap().to_string(), id));
        }
        seen.sort();
        let mut expected = vec![
            ("record.deleted".to_string(), soft),
            ("record.deleted".to_string(), hard),
        ];
        expected.sort();
        assert_eq!(seen, expected);
    }

    #[test]
    fn retry_schedule_spans_one_day() {
        let total: u64 = (1..8).map(retry_seconds).sum();
        assert!((77760..=95040).contains(&total));
    }

    #[test]
    fn retry_jitter_stays_in_window_and_varies() {
        for (attempt, base) in [
            (1, 60u64),
            (2, 300),
            (3, 1800),
            (4, 7200),
            (5, 14400),
            (6, 21600),
            (7, 41040),
        ] {
            let samples: Vec<u64> = (0..200).map(|_| retry_seconds(attempt)).collect();
            let (low, high) = (base * 9 / 10, base * 11 / 10);
            assert!(
                samples.iter().all(|s| (low..=high).contains(s)),
                "attempt {attempt}: {samples:?} outside {low}..={high}"
            );
            // Jitter must be symmetric: samples land on both sides of the base delay.
            assert!(samples.iter().any(|&s| s < base), "attempt {attempt}");
            assert!(samples.iter().any(|&s| s > base), "attempt {attempt}");
            let distinct: std::collections::HashSet<u64> = samples.iter().copied().collect();
            assert!(distinct.len() > 1, "attempt {attempt}: no jitter");
        }
    }
}
