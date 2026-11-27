use crate::config::AiConfig;
use kernel::{
    AppError, AppResult, ErrorCode,
    request::RequestMeta,
    security::{self, AuditEntry, Limit},
};
use serde::Serialize;
use serde_json::json;
use sqlx::PgPool;
use std::time::{Duration, Instant};
use time::Date;
use uuid::Uuid;

#[derive(Clone, Copy, Serialize)]
pub struct Usage {
    pub input: i64,
    pub output: i64,
}
struct Settlement {
    db: PgPool,
    user: Uuid,
    day: Date,
    reserved: Usage,
    usage: Usage,
    meta: RequestMeta,
    model: String,
    started: Instant,
}
pub struct Reservation {
    settlement: Option<Settlement>,
}
impl Reservation {
    pub async fn reserve(
        db: &PgPool,
        user: Uuid,
        meta: RequestMeta,
        input: i64,
        config: &AiConfig,
        model: &str,
    ) -> AppResult<Self> {
        let db = db.clone();
        let output = config.max_output;
        let daily = config.daily;
        let model = model.to_owned();
        // The reservation query must finish even if the HTTP handler is cancelled while Postgres commits.
        // A detached task's unclaimed Reservation is dropped and settled automatically.
        tokio::spawn(async move {
            security::enforce_rate_limit(&db, &format!("ai:{user}"), Limit { limit: 20, window: Duration::from_secs(60) }).await?;
            let day = time::OffsetDateTime::now_utc().date();
            let found: Option<i32> = sqlx::query_scalar(
                "insert into ai_usage (user_id, day, requests, input_tokens, output_tokens)
                 select $1, $2, 1, $3, $4 where $3::bigint + $4::bigint <= $5
                 on conflict (user_id, day) do update set requests = ai_usage.requests + 1,
                   input_tokens = ai_usage.input_tokens + $3, output_tokens = ai_usage.output_tokens + $4
                 where ai_usage.input_tokens + ai_usage.output_tokens + $3 + $4 <= $5
                 returning requests")
                .bind(user).bind(day).bind(input).bind(output).bind(daily).fetch_optional(&db).await?;
            if found.is_none() { return Err(AppError::new(ErrorCode::LimitReached, "You've used today's AI allowance.")); }
            let usage = Usage { input, output };
            Ok(Self { settlement: Some(Settlement { db, user, day, reserved: usage, usage, meta, model, started: Instant::now() }) })
        }).await.map_err(|_| AppError::internal("AI reservation task failed"))?
    }
    pub fn set_usage(&mut self, usage: Usage) {
        if let Some(state) = self.settlement.as_mut() {
            state.usage = usage;
        }
    }
    pub fn usage(&self) -> Usage {
        self.settlement
            .as_ref()
            .map(|state| state.usage)
            .unwrap_or(Usage {
                input: 0,
                output: 0,
            })
    }
    pub async fn finish(mut self) {
        if let Some(state) = self.settlement.take() {
            // Once spawned, accounting survives cancellation during the database write.
            let _ = tokio::spawn(state.finish()).await;
        }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(state) = self.settlement.take() {
            tokio::spawn(state.finish());
        }
    }
}
impl Settlement {
    async fn finish(self) {
        let result = sqlx::query("update ai_usage set input_tokens = input_tokens + $3, output_tokens = output_tokens + $4 where user_id = $1 and day = $2")
            .bind(self.user).bind(self.day).bind(self.usage.input - self.reserved.input).bind(self.usage.output - self.reserved.output).execute(&self.db).await;
        if result.is_err() {
            tracing::error!("AI usage settlement failed; reservation retained");
        }
        tracing::info!(model = %self.model, latency_ms = self.started.elapsed().as_millis(), input_tokens = self.usage.input, output_tokens = self.usage.output, "AI request finished");
        security::audit(
            &self.db,
            &self.meta,
            AuditEntry {
                action: "ai.request",
                actor_id: Some(self.user),
                target_type: None,
                target_id: None,
                meta: json!({"inputTokens": self.usage.input, "outputTokens": self.usage.output}),
            },
        )
        .await;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn meta() -> RequestMeta {
        RequestMeta {
            ip: "127.0.0.1".into(),
            user_agent: "metering-test".into(),
            request_id: "metering-test-request".into(),
        }
    }
    async fn user(db: &PgPool) -> Uuid {
        sqlx::query_scalar("insert into users(email) values($1) returning id")
            .bind(format!("{}@example.com", Uuid::new_v4()))
            .fetch_one(db)
            .await
            .unwrap()
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn settlement_uses_reserved_day_across_midnight(db: PgPool) {
        let user = user(&db).await;
        let config = AiConfig::test("http://localhost".into());
        let mut reservation = Reservation::reserve(&db, user, meta(), 50, &config, "test")
            .await
            .unwrap();
        let yesterday = time::OffsetDateTime::now_utc().date() - time::Duration::days(1);
        sqlx::query("update ai_usage set day=$2 where user_id=$1")
            .bind(user)
            .bind(yesterday)
            .execute(&db)
            .await
            .unwrap();
        reservation.settlement.as_mut().unwrap().day = yesterday;
        sqlx::query("insert into ai_usage(user_id,day,requests,input_tokens,output_tokens) values($1,$2,1,20,10)").bind(user).bind(time::OffsetDateTime::now_utc().date()).execute(&db).await.unwrap();
        reservation.set_usage(Usage {
            input: 4,
            output: 2,
        });
        reservation.finish().await;
        let rows: Vec<(Date, i64, i64)> = sqlx::query_as(
            "select day,input_tokens,output_tokens from ai_usage where user_id=$1 order by day",
        )
        .bind(user)
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows[0], (yesterday, 4, 2));
        assert_eq!((rows[1].1, rows[1].2), (20, 10));
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn cancellation_while_reservation_waits_does_not_lose_accounting(db: PgPool) {
        let user = user(&db).await;
        let config = AiConfig::test("http://localhost".into());
        Reservation::reserve(&db, user, meta(), 10, &config, "test")
            .await
            .unwrap()
            .finish()
            .await;
        let mut transaction = db.begin().await.unwrap();
        sqlx::query("select user_id from ai_usage where user_id=$1 for update")
            .bind(user)
            .execute(&mut *transaction)
            .await
            .unwrap();
        let task_db = db.clone();
        let task = tokio::spawn(async move {
            Reservation::reserve(&task_db, user, meta(), 10, &config, "test").await
        });
        // Observe the second rate-limit hit so the inner reservation task is running before cancellation.
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let count: Option<i32> = sqlx::query_scalar("select max(hits) from rate_limits")
                    .fetch_one(&db)
                    .await
                    .unwrap();
                if count.is_some_and(|count| count >= 2) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        transaction.commit().await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let count: i64 = sqlx::query_scalar(
                    "select count(*) from audit_log where actor_id=$1 and action='ai.request'",
                )
                .bind(user)
                .fetch_one(&db)
                .await
                .unwrap();
                if count == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let row: (i32, i64, i64) = sqlx::query_as(
            "select requests,input_tokens,output_tokens from ai_usage where user_id=$1",
        )
        .bind(user)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(row, (2, 20, 60));
    }
}
