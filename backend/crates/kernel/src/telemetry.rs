//! Aggregated HTTP outcomes. Counts include redirects; health probes are excluded.
use sqlx::PgPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HttpStats {
    pub total: i64,
    pub errors: i64,
    pub rate_limited: i64,
}

/// Counts in the trailing window, clamped to 1 through 10080 minutes.
pub async fn stats(db: &PgPool, window_minutes: i64) -> Result<HttpStats, sqlx::Error> {
    let (total, errors, rate_limited): (i64, i64, i64) = sqlx::query_as(
        "select coalesce(sum(count), 0)::bigint, coalesce(sum(count) filter (where status >= 500), 0)::bigint, coalesce(sum(count) filter (where status = 429), 0)::bigint from http_request_stats where minute >= date_trunc('minute', now()) - ($1 - 1) * interval '1 minute'",
    ).bind(window_minutes.clamp(1, 10080)).fetch_one(db).await?;
    Ok(HttpStats {
        total,
        errors,
        rate_limited,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = "../../migrations")]
    async fn sums_statuses_and_excludes_old_minutes(db: PgPool) {
        // A two-minute window: current-minute rows stay inside it even if the minute rolls over
        // between the insert and the query. The row from two minutes ago falls outside it.
        sqlx::query("insert into http_request_stats values (date_trunc('minute', now()), 'GET', '/test', 200, 3), (date_trunc('minute', now()), 'GET', '/test', 429, 2), (date_trunc('minute', now()), 'GET', '/test', 503, 1), (date_trunc('minute', now()) - interval '2 minutes', 'GET', '/test', 500, 9)").execute(&db).await.unwrap();
        assert_eq!(
            stats(&db, 2).await.unwrap(),
            HttpStats {
                total: 6,
                errors: 1,
                rate_limited: 2
            }
        );
    }
}
