use futures::FutureExt;
use kernel::{
    AppState,
    config::Config,
    email::{Email, EmailSender, SendFuture},
};
use secrecy::ExposeSecret;
use sqlx::postgres::PgPoolOptions;
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use tracing_subscriber::EnvFilter;

mod housekeeping;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
async fn run() -> anyhow::Result<()> {
    let config = Arc::new(Config::from_env()?);
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,tower_http=info"));
    if config.is_production() {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .pretty()
            .init();
    }
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "serve".to_owned());
    if command == "healthcheck" {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()?
            .get(format!("http://127.0.0.1:{}/healthz", config.bind.port()))
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    if command != "serve" && command != "migrate" {
        anyhow::bail!("Unknown command: {command}");
    }
    let options = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Duration::from_secs(300))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("set statement_timeout = '10s'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        });
    let start = tokio::time::Instant::now();
    let db = loop {
        match options
            .clone()
            .connect(config.database_url.expose_secret())
            .await
        {
            Ok(pool) => break pool,
            Err(error) if start.elapsed() < Duration::from_secs(30) => {
                tracing::warn!(%error, "database unavailable; retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(error) => return Err(error.into()),
        }
    };
    // RUN_MIGRATIONS enables automatic migrations on startup; `api migrate` always runs them.
    let migrate = match std::env::var("RUN_MIGRATIONS") {
        Ok(value) => value == "true",
        Err(_) => !config.is_production(),
    };
    if command == "migrate" || migrate {
        sqlx::migrate!("../../migrations").run(&db).await?;
    }
    if command == "migrate" {
        db.close().await;
        return Ok(());
    }
    let registry = Arc::new(records::load_registry(&config.entities_path)?);
    let schedules_path =
        std::env::var_os("SCHEDULES_PATH").unwrap_or_else(|| "config/schedules.json".into());
    let schedules = jobs::parse_schedules(&std::fs::read_to_string(schedules_path)?)?;
    anyhow::ensure!(
        config.resend_api_key.is_some() || config.smtp_url.is_some(),
        "Configure an email provider before starting the server"
    );
    jobs::upgrade_legacy_email(&db, &config).await?;
    let real_sender = auth::email_sender(&config)?;
    let mut jobs_registry = jobs::Registry::new();
    jobs::register_email(
        &mut jobs_registry,
        Arc::new(BoundedEmailSender(real_sender)),
        config.clone(),
    )?;
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("invigil-api")
            .build()?,
        email: Arc::new(jobs::QueueEmailSender::new(db.clone(), config.clone())),
        hashing: hashing_semaphore(),
    };
    webhooks::register_jobs(&mut jobs_registry, state.clone())?;
    let recorder = metrics_exporter_prometheus::PrometheusBuilder::new().install_recorder()?;
    let metrics = axum::Router::new().route(
        "/metrics",
        axum::routing::get(move || {
            let recorder = recorder.clone();
            async move { recorder.render() }
        }),
    );
    let api_listener = tokio::net::TcpListener::bind(config.bind).await?;
    let metrics_listener = tokio::net::TcpListener::bind(config.metrics_bind).await?;
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let (jobs_shutdown_tx, jobs_shutdown_rx) = tokio::sync::watch::channel(false);
    let worker = tokio::spawn(supervise_jobs(
        db.clone(),
        jobs_registry.clone(),
        jobs_shutdown_rx.clone(),
        jobs::KindFilter::Only(jobs::EMAIL_KIND.to_owned()),
    ));
    let other_worker = tokio::spawn(supervise_jobs(
        db.clone(),
        jobs_registry,
        jobs_shutdown_rx.clone(),
        jobs::KindFilter::Except(jobs::EMAIL_KIND.to_owned()),
    ));
    let scheduler = tokio::spawn(run_scheduler(db.clone(), schedules, jobs_shutdown_rx));
    let storage = files::storage_from_env()?;
    let mut hub_shutdown = shutdown_tx.subscribe();
    let hub = realtime::spawn_listener(db.clone(), async move {
        let _ = hub_shutdown.recv().await;
    })
    .await?;
    // Keeps assistant embeddings fresh in the background; stopped at shutdown.
    let embedding_worker = assist::spawn_worker(state.clone());
    let mut housekeeping_shutdown = shutdown_tx.subscribe();
    let housekeeping_db = db.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(600));
        loop {
            tokio::select! {
                _ = housekeeping_shutdown.recv() => break,
                _ = every.tick() => housekeeping::run(&housekeeping_db).await,
            }
        }
    });
    let mut api_shutdown = shutdown_tx.subscribe();
    let mut metrics_shutdown = shutdown_tx.subscribe();
    let mut api = tokio::spawn(async move {
        axum::serve(
            api_listener,
            server::build_app(state, registry, storage, hub)
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = api_shutdown.recv().await;
        })
        .await
    });
    let mut metrics_task = tokio::spawn(async move {
        axum::serve(metrics_listener, metrics)
            .with_graceful_shutdown(async move {
                let _ = metrics_shutdown.recv().await;
            })
            .await
    });
    tokio::select! {
        _ = shutdown_signal() => {},
        result = &mut api => tracing::error!(?result, "API server stopped"),
        result = &mut metrics_task => tracing::error!(?result, "metrics server stopped"),
    }
    let _ = shutdown_tx.send(());
    let _ = jobs_shutdown_tx.send(true);
    if tokio::time::timeout(Duration::from_secs(20), async {
        if !api.is_finished() {
            let _ = (&mut api).await;
        }
        if !metrics_task.is_finished() {
            let _ = (&mut metrics_task).await;
        }
    })
    .await
    .is_err()
    {
        tracing::warn!("HTTP servers did not stop in time");
        api.abort();
        metrics_task.abort();
    }
    let mut worker = worker;
    let mut other_worker = other_worker;
    let mut scheduler = scheduler;
    if tokio::time::timeout(Duration::from_secs(25), async {
        let _ = tokio::join!(&mut worker, &mut other_worker, &mut scheduler);
    })
    .await
    .is_err()
    {
        tracing::warn!("background jobs did not stop in time");
        worker.abort();
        other_worker.abort();
        scheduler.abort();
    }
    // Give the statistics worker a bounded opportunity to drain its queue.
    tokio::time::sleep(Duration::from_secs(3)).await;
    embedding_worker.abort();
    db.close().await;
    Ok(())
}

const EMAIL_TIMEOUT: Duration = Duration::from_secs(15);
const JOB_LEASE: Duration = Duration::from_secs(60);

fn hashing_semaphore() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(2))
}

struct BoundedEmailSender(Arc<dyn EmailSender>);
impl EmailSender for BoundedEmailSender {
    fn send<'a>(&'a self, email: &'a Email) -> SendFuture<'a> {
        Box::pin(async move {
            tokio::time::timeout(EMAIL_TIMEOUT, self.0.send(email))
                .await
                .map_err(|_| anyhow::anyhow!("email delivery timed out"))?
        })
    }
}

async fn supervise_jobs(
    db: sqlx::PgPool,
    registry: jobs::Registry,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    filter: jobs::KindFilter,
) {
    loop {
        if *shutdown.borrow() {
            break;
        }
        let task = std::panic::AssertUnwindSafe(jobs::run_filtered(
            db.clone(),
            registry.clone(),
            shutdown.clone(),
            JOB_LEASE,
            Duration::from_secs(2),
            filter.clone(),
        ))
        .catch_unwind();
        match task.await {
            Ok(Ok(())) if *shutdown.borrow() || shutdown.has_changed().is_err() => break,
            Ok(Ok(())) => tracing::warn!("job worker stopped unexpectedly; retrying"),
            Ok(Err(error)) => tracing::warn!(%error, "job worker stopped; retrying"),
            Err(_) => tracing::error!("job worker panicked; retrying"),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
            _ = shutdown.changed() => {},
        }
    }
}

async fn run_scheduler(
    db: sqlx::PgPool,
    schedules: Vec<jobs::Schedule>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        tokio::select! {
            changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } },
            _ = interval.tick() => {
                if let Err(error) = jobs::tick_schedules(&db, &schedules).await {
                    tracing::warn!(%error, "schedule tick failed; retrying");
                }
            }
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = signal.recv() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod hashing_tests {
    #[test]
    fn hashing_is_bounded() {
        assert_eq!(super::hashing_semaphore().available_permits(), 2);
    }
}
