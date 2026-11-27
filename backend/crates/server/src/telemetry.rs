use sqlx::{PgPool, Postgres, QueryBuilder};
use std::{
    collections::HashMap,
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::sync::mpsc;

const CAPACITY: usize = 4096;
const BATCH: usize = 512;

#[derive(Hash, PartialEq, Eq)]
struct Outcome {
    minute: i64,
    method: &'static str,
    route: String,
    status: u16,
}

#[derive(Clone)]
pub(crate) struct Collector {
    tx: mpsc::Sender<Outcome>,
    dropped: Arc<AtomicU64>,
}

impl Collector {
    pub(crate) fn start(db: PgPool) -> Self {
        let (tx, mut rx) = mpsc::channel::<Outcome>(CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        let worker_dropped = dropped.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            let mut pending = HashMap::new();
            loop {
                tokio::select! {
                    item = rx.recv() => match item {
                        Some(item) => {
                            *pending.entry(item).or_insert(0_i64) += 1;
                            if pending.len() >= BATCH { flush(&db, &mut pending, &worker_dropped).await; }
                        }
                        None => { flush(&db, &mut pending, &worker_dropped).await; break; }
                    },
                    _ = interval.tick() => flush(&db, &mut pending, &worker_dropped).await,
                }
            }
        });
        Self { tx, dropped }
    }
    pub(crate) fn record(&self, method: &axum::http::Method, route: String, status: u16) {
        let method = match *method {
            axum::http::Method::GET => "GET",
            axum::http::Method::POST => "POST",
            axum::http::Method::PUT => "PUT",
            axum::http::Method::PATCH => "PATCH",
            axum::http::Method::DELETE => "DELETE",
            axum::http::Method::HEAD => "HEAD",
            axum::http::Method::OPTIONS => "OPTIONS",
            _ => "OTHER",
        };
        let item = Outcome {
            minute: time::OffsetDateTime::now_utc()
                .unix_timestamp()
                .div_euclid(60),
            method,
            route,
            status,
        };
        if self.tx.try_send(item).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            metrics::counter!("http_stats_dropped_total").increment(1);
        }
    }
}

async fn flush(db: &PgPool, pending: &mut HashMap<Outcome, i64>, dropped: &AtomicU64) {
    if pending.is_empty() {
        return;
    }
    let mut query = QueryBuilder::<Postgres>::new(
        "insert into http_request_stats (minute, method, route, status, count) ",
    );
    query.push_values(pending.iter(), |mut b, (key, count)| {
        b.push("to_timestamp(")
            .push_bind_unseparated(key.minute * 60)
            .push_unseparated("::bigint::double precision)")
            .push_bind(key.method)
            .push_bind(&key.route)
            .push_bind(key.status as i16)
            .push_bind(*count);
    });
    query.push(" on conflict (minute, method, route, status) do update set count = http_request_stats.count + excluded.count");
    let result = tokio::time::timeout(Duration::from_secs(2), query.build().execute(db)).await;
    if !matches!(result, Ok(Ok(_))) {
        let count = pending.values().sum::<i64>() as u64;
        dropped.fetch_add(count, Ordering::Relaxed);
        metrics::counter!("http_stats_dropped_total").increment(count);
        tracing::warn!(count, "HTTP statistics batch dropped");
    }
    pending.clear();
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn full_queue_drops_without_blocking() {
        let (tx, _rx) = mpsc::channel(1);
        let dropped = Arc::new(AtomicU64::new(0));
        let collector = Collector {
            tx,
            dropped: dropped.clone(),
        };
        collector.record(&axum::http::Method::GET, "<unmatched>".into(), 400);
        collector.record(&axum::http::Method::GET, "<unmatched>".into(), 429);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn batches_merge_and_drain_on_close(db: PgPool) {
        let collector = Collector::start(db.clone());
        for status in [200, 400, 403, 429, 200] {
            collector.record(
                &axum::http::Method::GET,
                "/api/v1/items/{id}".into(),
                status,
            );
        }
        drop(collector);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let count: i64 = sqlx::query_scalar(
                    "select coalesce(sum(count), 0)::bigint from http_request_stats",
                )
                .fetch_one(&db)
                .await
                .unwrap();
                if count == 5 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let count: i64 =
            sqlx::query_scalar("select count from http_request_stats where status = 200")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 2);
    }
}
