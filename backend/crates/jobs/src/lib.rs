//! Durable, at-least-once background jobs. Handlers must be idempotent.
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kernel::config::Config;
use kernel::email::{Email, EmailSender, SendFuture};
use rand::RngCore;
use rand::{Rng, rngs::OsRng};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc, time::Duration};
use time::OffsetDateTime;
use tokio::sync::watch;
use uuid::Uuid;

pub const EMAIL_KIND: &str = "kernel.email";
const MAX_PAYLOAD: usize = 65536;
pub type HandlerFuture = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;
pub type Handler = Arc<dyn Fn(Value) -> HandlerFuture + Send + Sync>;

/// Identity of one lease. Database writes by a handler must check this token and expiry.
#[derive(Clone, Copy)]
pub struct ClaimContext {
    pub id: Uuid,
    pub token: Uuid,
    pub attempt: i32,
}
/// Retry delays are controlled by the handler; permanent failures are dead-lettered.
pub enum Outcome {
    Done,
    RetryAfter(Duration),
    PermanentFailure,
}
pub type ClaimFuture = Pin<Box<dyn Future<Output = anyhow::Result<Outcome>> + Send>>;
pub type ClaimHandler = Arc<dyn Fn(Value, ClaimContext) -> ClaimFuture + Send + Sync>;

/// A duplicate queued key returns the existing job id. Keys are scoped by kind.
pub async fn enqueue(
    db: &PgPool,
    kind: &str,
    payload: Value,
    run_at: Option<OffsetDateTime>,
    dedupe_key: Option<&str>,
) -> anyhow::Result<Uuid> {
    let mut conn = db.acquire().await?;
    enqueue_in_tx(&mut conn, kind, payload, run_at, dedupe_key).await
}

/// Enqueue using the caller's transaction or connection.
pub async fn enqueue_in_tx(
    conn: &mut sqlx::PgConnection,
    kind: &str,
    payload: Value,
    run_at: Option<OffsetDateTime>,
    dedupe_key: Option<&str>,
) -> anyhow::Result<Uuid> {
    anyhow::ensure!(
        !kind.is_empty() && kind.len() <= 100 && kind != EMAIL_KIND,
        "invalid job kind"
    );
    anyhow::ensure!(
        dedupe_key.is_none_or(|k| !k.is_empty() && k.len() <= 200),
        "invalid dedupe key"
    );
    anyhow::ensure!(
        serde_json::to_vec(&payload)?.len() <= MAX_PAYLOAD,
        "job payload too large"
    );
    // PostgreSQL's jsonb text representation may be larger than compact JSON.
    let id = sqlx::query_scalar::<_, Uuid>("insert into jobs(kind,payload,run_at,dedupe_key) values ($1,$2,coalesce($3,now()),$4) on conflict (kind,dedupe_key) where status = 'queued' and dedupe_key is not null do update set dedupe_key=excluded.dedupe_key returning id")
        .bind(kind).bind(payload).bind(run_at).bind(dedupe_key).fetch_one(conn).await?;
    Ok(id)
}

#[derive(Default, Clone)]
pub struct Registry {
    handlers: HashMap<String, Handler>,
    claim_handlers: HashMap<String, ClaimHandler>,
}
impl Registry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register(&mut self, kind: impl Into<String>, handler: Handler) -> anyhow::Result<()> {
        let kind = kind.into();
        anyhow::ensure!(
            !kind.is_empty()
                && kind.len() <= 100
                && !self.handlers.contains_key(&kind)
                && !self.claim_handlers.contains_key(&kind),
            "invalid or duplicate handler"
        );
        self.handlers.insert(kind, handler);
        Ok(())
    }
    pub fn register_claim_handler(
        &mut self,
        kind: impl Into<String>,
        handler: ClaimHandler,
    ) -> anyhow::Result<()> {
        let kind = kind.into();
        anyhow::ensure!(
            !kind.is_empty()
                && kind.len() <= 100
                && !self.handlers.contains_key(&kind)
                && !self.claim_handlers.contains_key(&kind),
            "invalid or duplicate handler"
        );
        self.claim_handlers.insert(kind, handler);
        Ok(())
    }
}

struct Claim {
    id: Uuid,
    token: Uuid,
    kind: String,
    payload: Value,
    attempts: i32,
}
#[derive(Clone)]
pub enum KindFilter {
    All,
    Only(String),
    Except(String),
}

async fn claim_filtered(
    db: &PgPool,
    lease: Duration,
    filter: &KindFilter,
) -> anyhow::Result<Option<Claim>> {
    let (only, except) = match filter {
        KindFilter::All => (None, None),
        KindFilter::Only(k) => (Some(k.as_str()), None),
        KindFilter::Except(k) => (None, Some(k.as_str())),
    };
    let token = Uuid::new_v4();
    let seconds = i64::try_from(lease.as_secs())?;
    anyhow::ensure!((1..=86400).contains(&seconds), "invalid lease");
    // Exhausted abandoned claims are dead-lettered before looking for more work.
    sqlx::query("update jobs set status='dead', finished_at=now(), locked_by=null, locked_until=null, last_error='Job failed.', payload=case when kind='kernel.email' then '{}'::jsonb else payload end where status='running' and locked_until <= now() and attempts >= max_attempts and ($1::text is null or kind=$1) and ($2::text is null or kind<>$2)").bind(only).bind(except).execute(db).await?;
    let row = sqlx::query("with candidate as (select id from jobs where ($3::text is null or kind=$3) and ($4::text is null or kind<>$4) and attempts < max_attempts and ((status in ('queued','failed') and run_at <= now()) or (status='running' and locked_until <= now())) order by run_at, created_at for update skip locked limit 1) update jobs j set status='running', attempts=j.attempts+1, locked_by=$1, locked_until=now()+($2 * interval '1 second') from candidate c where j.id=c.id returning j.id,j.kind,j.payload,j.attempts,j.max_attempts")
      .bind(token).bind(seconds as f64).bind(only).bind(except).fetch_optional(db).await?;
    row.map(|r| {
        Ok(Claim {
            id: r.try_get("id")?,
            token,
            kind: r.try_get("kind")?,
            payload: r.try_get("payload")?,
            attempts: r.try_get("attempts")?,
        })
    })
    .transpose()
}
#[cfg(test)]
async fn claim(db: &PgPool, lease: Duration) -> anyhow::Result<Option<Claim>> {
    claim_filtered(db, lease, &KindFilter::All).await
}
async fn finish_outcome(db: &PgPool, c: &Claim, outcome: Outcome) -> anyhow::Result<bool> {
    let (success, permanent, delay) = match outcome {
        Outcome::Done => (true, false, 0),
        Outcome::PermanentFailure => (false, true, 0),
        Outcome::RetryAfter(delay) => (false, false, delay.as_secs().min(86400)),
    };
    let result = sqlx::query("update jobs set status=case when $3 then 'done' when $4 or attempts >= max_attempts then 'dead' else 'failed' end, finished_at=case when $3 or $4 or attempts >= max_attempts then now() else null end, run_at=case when $3 then run_at else now()+($5 * interval '1 second') end, locked_by=null, locked_until=null, last_error=case when $3 then null else 'Job failed.' end, payload=case when ($3 or $4 or attempts >= max_attempts) and kind='kernel.email' then '{}'::jsonb else payload end where id=$1 and status='running' and locked_by=$2 and locked_until > now()")
       .bind(c.id).bind(c.token).bind(success).bind(permanent).bind(delay as f64).execute(db).await?;
    Ok(result.rows_affected() == 1)
}
#[cfg(test)]
async fn finish(db: &PgPool, c: &Claim, success: bool) -> anyhow::Result<bool> {
    finish_outcome(
        db,
        c,
        if success {
            Outcome::Done
        } else {
            Outcome::RetryAfter(Duration::from_secs(retry_delay(c.attempts)))
        },
    )
    .await
}
fn retry_delay(attempt: i32) -> u64 {
    let base = 30_u64.saturating_mul(1_u64 << (attempt.clamp(1, 8) - 1));
    base + OsRng.gen_range(0..=base / 2)
}

/// Runs one worker until shutdown. An in-flight handler is allowed to finish; callers should await the task.
/// The lease must exceed handler runtime. Expired work can be delivered again on another replica.
pub async fn run(
    db: PgPool,
    registry: Registry,
    shutdown: watch::Receiver<bool>,
    lease: Duration,
    poll: Duration,
) -> anyhow::Result<()> {
    run_filtered(db, registry, shutdown, lease, poll, KindFilter::All).await
}

/// Run a worker restricted to a single kind or all other kinds.
pub async fn run_filtered(
    db: PgPool,
    registry: Registry,
    mut shutdown: watch::Receiver<bool>,
    lease: Duration,
    poll: Duration,
    filter: KindFilter,
) -> anyhow::Result<()> {
    anyhow::ensure!(!poll.is_zero(), "invalid poll interval");
    loop {
        if *shutdown.borrow() || shutdown.has_changed().is_err() {
            return Ok(());
        }
        if let Some(c) = claim_filtered(&db, lease, &filter).await? {
            let fallback = || Outcome::RetryAfter(Duration::from_secs(retry_delay(c.attempts)));
            let outcome = if let Some(handler) = registry.claim_handlers.get(&c.kind) {
                handler(
                    c.payload.clone(),
                    ClaimContext {
                        id: c.id,
                        token: c.token,
                        attempt: c.attempts,
                    },
                )
                .await
                .unwrap_or_else(|_| fallback())
            } else if let Some(handler) = registry.handlers.get(&c.kind) {
                if handler(c.payload.clone()).await.is_ok() {
                    Outcome::Done
                } else {
                    fallback()
                }
            } else {
                fallback()
            };
            let _ = finish_outcome(&db, &c, outcome).await?;
        } else {
            tokio::select! { _ = tokio::time::sleep(poll) => {}, changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { return Ok(()); } } }
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmailPayload {
    to: String,
    subject: String,
    html: String,
    text: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SealedEmail {
    version: u8,
    #[serde(default)]
    key_id: Option<String>,
    nonce: String,
    ciphertext: String,
}
fn cipher(config: &Config, id: &str) -> anyhow::Result<Aes256Gcm> {
    let secret = config
        .code_pepper_for(id)
        .ok_or_else(|| anyhow::anyhow!("email key unavailable"))?;
    let key = kernel::crypto::hmac_sha256(
        secret.expose_secret().as_bytes(),
        &[b"invigil/jobs/email/aes-256-gcm/v1"],
    );
    Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow::anyhow!("invalid email key"))
}
fn aad(id: Uuid) -> Vec<u8> {
    let mut value = id.as_bytes().to_vec();
    value.extend_from_slice(EMAIL_KIND.as_bytes());
    value
}
fn seal(config: &Config, id: Uuid, payload: &EmailPayload) -> anyhow::Result<Value> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let bytes = serde_json::to_vec(payload)?;
    let ciphertext = cipher(config, &config.code_pepper_id)?
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &bytes,
                aad: &aad(id),
            },
        )
        .map_err(|_| anyhow::anyhow!("email encryption failed"))?;
    let sealed = serde_json::to_value(SealedEmail {
        version: 2,
        key_id: Some(config.code_pepper_id.clone()),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })?;
    anyhow::ensure!(
        serde_json::to_string(&sealed)?.len() <= 65000,
        "email payload too large"
    );
    Ok(sealed)
}
fn open(config: &Config, id: Uuid, value: Value) -> anyhow::Result<EmailPayload> {
    let sealed: SealedEmail =
        serde_json::from_value(value).map_err(|_| anyhow::anyhow!("invalid email envelope"))?;
    anyhow::ensure!(
        sealed.version == 1 || sealed.version == 2,
        "invalid email envelope"
    );
    let key_id = match (sealed.version, sealed.key_id.as_deref()) {
        (1, None) => "v1",
        (_, Some(id)) => id,
        _ => anyhow::bail!("invalid email envelope"),
    };
    let nonce = STANDARD
        .decode(&sealed.nonce)
        .map_err(|_| anyhow::anyhow!("invalid email envelope"))?;
    let nonce: [u8; 12] = nonce
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid email envelope"))?;
    let ciphertext = STANDARD
        .decode(&sealed.ciphertext)
        .map_err(|_| anyhow::anyhow!("invalid email envelope"))?;
    let bytes = cipher(config, key_id)?
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad(id),
            },
        )
        .map_err(|_| anyhow::anyhow!("email authentication failed"))?;
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid email payload"))
}
/// Convert legacy plaintext mail under row locks before starting workers.
pub async fn upgrade_legacy_email(db: &PgPool, config: &Config) -> anyhow::Result<()> {
    let mut cursor: Option<Uuid> = None;
    loop {
        let mut tx = db.begin().await?;
        let rows = sqlx::query("select id,payload,status from jobs where kind=$1 and ($2::uuid is null or id > $2) order by id for update limit 100")
            .bind(EMAIL_KIND).bind(cursor).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            tx.commit().await?;
            return Ok(());
        }
        for row in rows {
            let id: Uuid = row.try_get("id")?;
            cursor = Some(id);
            let status: String = row.try_get("status")?;
            let value: Value = row.try_get("payload")?;
            if status == "done" || status == "dead" {
                sqlx::query("update jobs set payload='{}'::jsonb where id=$1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            } else if let Ok(payload) = serde_json::from_value::<EmailPayload>(value.clone()) {
                let encrypted = seal(config, id, &payload)?;
                sqlx::query("update jobs set payload=$2 where id=$1")
                    .bind(id)
                    .bind(encrypted)
                    .execute(&mut *tx)
                    .await?;
            } else if let Ok(envelope) = serde_json::from_value::<SealedEmail>(value.clone()) {
                let key_id = envelope.key_id.as_deref().unwrap_or("v1");
                anyhow::ensure!(
                    config.code_pepper_for(key_id).is_some(),
                    "email key unavailable"
                );
                if open(config, id, value).is_err() {
                    sqlx::query("update jobs set payload='{}'::jsonb,status='dead',finished_at=now(),locked_by=null,locked_until=null,last_error='Job failed.' where id=$1").bind(id).execute(&mut *tx).await?;
                }
            } else {
                sqlx::query("update jobs set payload='{}'::jsonb,status='dead',finished_at=now(),locked_by=null,locked_until=null,last_error='Job failed.' where id=$1").bind(id).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
    }
}
/// Enqueues mail encrypted with the active, versioned code pepper.
pub struct QueueEmailSender {
    db: PgPool,
    config: Arc<Config>,
}
impl QueueEmailSender {
    pub fn new(db: PgPool, config: Arc<Config>) -> Self {
        Self { db, config }
    }
}
impl EmailSender for QueueEmailSender {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            let payload = EmailPayload {
                to: email.to.clone(),
                subject: email.subject.clone(),
                html: email.html.clone(),
                text: email.text.clone(),
            };
            let id = Uuid::new_v4();
            let encrypted = seal(&self.config, id, &payload)?;
            sqlx::query("insert into jobs(id,kind,payload) values ($1,$2,$3)")
                .bind(id)
                .bind(EMAIL_KIND)
                .bind(encrypted)
                .execute(&self.db)
                .await?;
            Ok(())
        })
    }
}
pub fn register_email(
    registry: &mut Registry,
    sender: Arc<dyn EmailSender>,
    config: Arc<Config>,
) -> anyhow::Result<()> {
    registry.register_claim_handler(
        EMAIL_KIND,
        Arc::new(move |value, claim| {
            let sender = sender.clone();
            let config = config.clone();
            Box::pin(async move {
                let p = match open(&config, claim.id, value) {
                    Ok(p) => p,
                    Err(_) => return Ok(Outcome::PermanentFailure),
                };
                sender
                    .send(&Email {
                        to: p.to,
                        subject: p.subject,
                        html: p.html,
                        text: p.text,
                    })
                    .await?;
                Ok(Outcome::Done)
            })
        }),
    )
}

/// A bounded five-field UTC cron schedule. Numeric lists, ranges and steps are supported.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    pub id: String,
    pub kind: String,
    pub cron: String,
    pub payload: Value,
}
fn field_matches(field: &str, value: u32, min: u32, max: u32) -> anyhow::Result<bool> {
    let mut matched = false;
    anyhow::ensure!(
        !field.is_empty() && field.len() <= 128,
        "invalid cron field"
    );
    for part in field.split(',') {
        let mut split = part.split('/');
        let range = split.next().unwrap_or("");
        let step = match split.next() {
            Some(s) => s.parse::<u32>()?,
            None => 1,
        };
        anyhow::ensure!(
            step > 0 && step <= max + 1 && split.next().is_none(),
            "invalid cron step"
        );
        let (a, b) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (a.parse::<u32>()?, b.parse::<u32>()?)
        } else {
            let n = range.parse::<u32>()?;
            (n, n)
        };
        anyhow::ensure!(a >= min && a <= b && b <= max, "invalid cron range");
        matched |= value >= a && value <= b && (value - a).is_multiple_of(step);
    }
    Ok(matched)
}
fn matches_cron(expr: &str, tick: OffsetDateTime) -> anyhow::Result<bool> {
    let f: Vec<_> = expr.split_whitespace().collect();
    anyhow::ensure!(f.len() == 5, "cron must have five fields");
    let minute = field_matches(f[0], u32::from(tick.minute()), 0, 59)?;
    let hour = field_matches(f[1], u32::from(tick.hour()), 0, 23)?;
    let day = field_matches(f[2], u32::from(tick.day()), 1, 31)?;
    let month = field_matches(f[3], u32::from(u8::from(tick.month())), 1, 12)?;
    let weekday = field_matches(
        f[4],
        u32::from(tick.weekday().number_days_from_sunday()),
        0,
        6,
    )?;
    let date = if f[2] == "*" || f[4] == "*" {
        day && weekday
    } else {
        day || weekday
    };
    Ok(minute && hour && month && date)
}
/// Parses and validates up to 100 schedules before starting the scheduler.
pub fn parse_schedules(json: &str) -> anyhow::Result<Vec<Schedule>> {
    anyhow::ensure!(json.len() <= 1_000_000, "schedules too large");
    let schedules: Vec<Schedule> = serde_json::from_str(json)?;
    anyhow::ensure!(schedules.len() <= 100, "too many schedules");
    let mut ids = std::collections::HashSet::new();
    for s in &schedules {
        anyhow::ensure!(
            !s.id.is_empty() && s.id.len() <= 100 && ids.insert(&s.id),
            "invalid schedule id"
        );
        anyhow::ensure!(
            !s.kind.is_empty()
                && s.kind != EMAIL_KIND
                && s.kind.len() <= 100
                && s.cron.len() <= 256
                && serde_json::to_vec(&s.payload)?.len() <= MAX_PAYLOAD,
            "invalid schedule"
        );
        matches_cron(&s.cron, OffsetDateTime::UNIX_EPOCH)?;
    }
    Ok(schedules)
}
/// Advances each schedule by up to 1,440 minutes; repeat periodically to catch up after downtime.
/// A transaction-scoped advisory lease serializes replicas, and each tick commits with its job.
pub async fn tick_schedules(db: &PgPool, schedules: &[Schedule]) -> anyhow::Result<()> {
    for s in schedules {
        anyhow::ensure!(s.kind != EMAIL_KIND, "invalid schedule kind");
        let mut tx = db.begin().await?;
        let locked: bool =
            sqlx::query_scalar("select pg_try_advisory_xact_lock(hashtextextended($1, 78323))")
                .bind(&s.id)
                .fetch_one(&mut *tx)
                .await?;
        if !locked {
            continue;
        }
        let now: OffsetDateTime = sqlx::query_scalar("select date_trunc('minute', now())")
            .fetch_one(&mut *tx)
            .await?;
        let last: Option<OffsetDateTime> =
            sqlx::query_scalar("select last_tick from jobs_schedule_state where schedule_id=$1")
                .bind(&s.id)
                .fetch_optional(&mut *tx)
                .await?;
        let mut tick = last.unwrap_or(now - time::Duration::minutes(1));
        for _ in 0..1440 {
            if tick >= now {
                break;
            }
            tick += time::Duration::minutes(1);
            if matches_cron(&s.cron, tick)? {
                let inserted=sqlx::query("insert into jobs_schedule_ticks(schedule_id,tick) values ($1,$2) on conflict do nothing").bind(&s.id).bind(tick).execute(&mut *tx).await?;
                if inserted.rows_affected() == 1 {
                    sqlx::query("insert into jobs(kind,payload,run_at) values ($1,$2,$3)")
                        .bind(&s.kind)
                        .bind(&s.payload)
                        .bind(tick)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
        sqlx::query("insert into jobs_schedule_state(schedule_id,last_tick) values ($1,$2) on conflict (schedule_id) do update set last_tick=excluded.last_tick").bind(&s.id).bind(tick).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn cron_and_backoff() {
        assert!(matches_cron("0 0 * * *", OffsetDateTime::UNIX_EPOCH).unwrap());
        assert!(!matches_cron("1 0 * * *", OffsetDateTime::UNIX_EPOCH).unwrap());
        assert!(
            parse_schedules(r#"[{"id":"a","kind":"k","cron":"* * * * *","payload":{}}]"#).is_ok()
        );
        assert!(
            parse_schedules(r#"[{"id":"a","kind":"k","cron":"99 * * * *","payload":{}}]"#).is_err()
        );
        assert!((30..=45).contains(&retry_delay(1)));
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn dedupe_reclaim_fence_and_retry(db: PgPool) {
        let a = enqueue(&db, "test", serde_json::json!({}), None, Some("key"))
            .await
            .unwrap();
        assert_eq!(
            a,
            enqueue(&db, "test", serde_json::json!({}), None, Some("key"))
                .await
                .unwrap()
        );
        assert!(
            enqueue(
                &db,
                "test",
                serde_json::json!("x".repeat(65537)),
                None,
                None
            )
            .await
            .is_err()
        );
        let (one, two) = tokio::join!(
            claim(&db, Duration::from_secs(60)),
            claim(&db, Duration::from_secs(60))
        );
        let one = one.unwrap();
        let two = two.unwrap();
        assert_ne!(one.is_some(), two.is_some());
        let old = one.or(two).unwrap();
        sqlx::query("update jobs set locked_until=now()-interval '1 second' where id=$1")
            .bind(a)
            .execute(&db)
            .await
            .unwrap();
        let new = claim(&db, Duration::from_secs(60)).await.unwrap().unwrap();
        assert!(!finish(&db, &old, true).await.unwrap());
        assert!(finish(&db, &new, false).await.unwrap());
        let (status, attempts): (String, i32) =
            sqlx::query_as("select status,attempts from jobs where id=$1")
                .bind(a)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!((status.as_str(), attempts), ("failed", 2));
        sqlx::query("update jobs set attempts=7,run_at=now() where id=$1")
            .bind(a)
            .execute(&db)
            .await
            .unwrap();
        let final_claim = claim(&db, Duration::from_secs(60)).await.unwrap().unwrap();
        assert!(finish(&db, &final_claim, false).await.unwrap());
        let status: String = sqlx::query_scalar("select status from jobs where id=$1")
            .bind(a)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(status, "dead");
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn schedules_survive_repeat(db: PgPool) {
        let schedules =
            parse_schedules(r#"[{"id":"a","kind":"k","cron":"* * * * *","payload":{}}]"#).unwrap();
        let (a, b) = tokio::join!(
            tick_schedules(&db, &schedules),
            tick_schedules(&db, &schedules)
        );
        a.unwrap();
        b.unwrap();
        tick_schedules(&db, &schedules).await.unwrap();
        let count: i64 = sqlx::query_scalar("select count(*) from jobs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        sqlx::query("update jobs_schedule_state set last_tick=last_tick-interval '3 minutes' where schedule_id='a'").execute(&db).await.unwrap();
        tick_schedules(&db, &schedules).await.unwrap();
        let count: i64 = sqlx::query_scalar("select count(*) from jobs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(count >= 3);
    }
    struct Sender(Arc<AtomicUsize>);
    impl EmailSender for Sender {
        fn send<'a>(&'a self, _: &'a Email) -> SendFuture<'a> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn email_delivery(db: PgPool) {
        let sent = Arc::new(AtomicUsize::new(0));
        let mut registry = Registry::new();
        let config = Arc::new(Config::from_env().unwrap());
        register_email(
            &mut registry,
            Arc::new(Sender(sent.clone())),
            config.clone(),
        )
        .unwrap();
        QueueEmailSender::new(db.clone(), config)
            .send(&Email {
                to: "a@b".into(),
                subject: "subject".into(),
                html: "secret".into(),
                text: "secret".into(),
            })
            .await
            .unwrap();
        let c = claim(&db, Duration::from_secs(60)).await.unwrap().unwrap();
        assert!(!c.payload.to_string().contains("secret"));
        let mut corrupted = c.payload.clone();
        corrupted["ciphertext"] = serde_json::json!("AA==");
        let corrupt_outcome = registry.claim_handlers[EMAIL_KIND](
            corrupted,
            ClaimContext {
                id: c.id,
                token: c.token,
                attempt: c.attempts,
            },
        )
        .await
        .unwrap();
        assert!(matches!(corrupt_outcome, Outcome::PermanentFailure));
        let outcome = registry.claim_handlers[EMAIL_KIND](
            c.payload.clone(),
            ClaimContext {
                id: c.id,
                token: c.token,
                attempt: c.attempts,
            },
        )
        .await
        .unwrap();
        assert!(matches!(outcome, Outcome::Done));
        finish(&db, &c, true).await.unwrap();
        assert_eq!(sent.load(Ordering::SeqCst), 1);
        let payload: Value = sqlx::query_scalar("select payload from jobs where id=$1")
            .bind(c.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(payload, serde_json::json!({}));
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn legacy_upgrade_and_corruption(db: PgPool) {
        let config = Config::from_env().unwrap();
        let legacy = serde_json::json!({"to":"a@b", "subject":"s", "html":"code 123456", "text":"invite-token"});
        let id: Uuid =
            sqlx::query_scalar("insert into jobs(kind,payload) values ($1,$2) returning id")
                .bind(EMAIL_KIND)
                .bind(legacy)
                .fetch_one(&db)
                .await
                .unwrap();
        let invalid: Uuid =
            sqlx::query_scalar("insert into jobs(kind,payload) values ($1,$2) returning id")
                .bind(EMAIL_KIND)
                .bind(serde_json::json!({"text":"secret"}))
                .fetch_one(&db)
                .await
                .unwrap();
        upgrade_legacy_email(&db, &config).await.unwrap();
        let value: Value = sqlx::query_scalar("select payload from jobs where id=$1")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(!value.to_string().contains("123456"));
        assert!(!value.to_string().contains("invite-token"));
        assert_eq!(
            open(&config, id, value.clone()).unwrap().text,
            "invite-token"
        );
        assert!(open(&config, Uuid::new_v4(), value).is_err());
        let (status, payload): (String, Value) =
            sqlx::query_as("select status,payload from jobs where id=$1")
                .bind(invalid)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "dead");
        assert_eq!(payload, serde_json::json!({}));
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn filtered_worker_does_not_wait_for_other_kind(db: PgPool) {
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let delivered = Arc::new(tokio::sync::Notify::new());
        let mut registry = Registry::new();
        let a = started.clone();
        let b = release.clone();
        registry
            .register(
                "webhook",
                Arc::new(move |_| {
                    let a = a.clone();
                    let b = b.clone();
                    Box::pin(async move {
                        a.notify_one();
                        b.notified().await;
                        Ok(())
                    })
                }),
            )
            .unwrap();
        let d = delivered.clone();
        registry
            .register(
                EMAIL_KIND,
                Arc::new(move |_| {
                    let d = d.clone();
                    Box::pin(async move {
                        d.notify_one();
                        Ok(())
                    })
                }),
            )
            .unwrap();
        enqueue(&db, "webhook", serde_json::json!({}), None, None)
            .await
            .unwrap();
        sqlx::query("insert into jobs(kind,payload) values ($1,'{}')")
            .bind(EMAIL_KIND)
            .execute(&db)
            .await
            .unwrap();
        let (stop, rx) = watch::channel(false);
        let other = tokio::spawn(run_filtered(
            db.clone(),
            registry.clone(),
            rx.clone(),
            Duration::from_secs(60),
            Duration::from_millis(10),
            KindFilter::Except(EMAIL_KIND.into()),
        ));
        tokio::time::timeout(Duration::from_secs(3), started.notified())
            .await
            .unwrap();
        let email = tokio::spawn(run_filtered(
            db,
            registry,
            rx,
            Duration::from_secs(60),
            Duration::from_millis(10),
            KindFilter::Only(EMAIL_KIND.into()),
        ));
        tokio::time::timeout(Duration::from_secs(3), delivered.notified())
            .await
            .unwrap();
        stop.send(true).unwrap();
        release.notify_one();
        other.await.unwrap().unwrap();
        email.await.unwrap().unwrap();
    }
}
