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
    validate_exam_secrets()?;
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
    // After tracing is up, so a missing development key is logged instead of silently replaced.
    examcore::init_keys();
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
    if command != "serve" && command != "migrate" && command != "seed-demo" {
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
    if command == "seed-demo" {
        seed_demo_accounts(&db, &config).await?;
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
        let mut attempt_sweep = tokio::time::interval(Duration::from_secs(20));
        let mut retention = tokio::time::interval(Duration::from_secs(600));
        loop {
            tokio::select! {
                _ = housekeeping_shutdown.recv() => break,
                _ = retention.tick() => housekeeping::run(&housekeeping_db).await,
                _ = attempt_sweep.tick() => {
                    match exam_attempts::sweep(&housekeeping_db).await {
                        Ok(count) if count > 0 => tracing::info!(count, "expired exam attempts finalized"),
                        Ok(_) => {},
                        Err(error) => tracing::warn!(%error, "exam attempt sweep failed; will retry"),
                    }
                },
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

async fn seed_demo_accounts(db: &sqlx::PgPool, config: &Arc<Config>) -> anyhow::Result<()> {
    let exists: bool = sqlx::query_scalar(
        "select exists(select 1 from users where lower(email::text)='admin@invigil.app')",
    )
    .fetch_one(db)
    .await?;
    if exists {
        println!("Demo seed skipped: admin@invigil.app already exists.");
        return Ok(());
    }
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
        http: reqwest::Client::new(),
        email: Arc::new(kernel::email::LogSender),
        hashing: hashing_semaphore(),
    };
    let hash = auth::password::hash(&state, "Invigil#Demo2026".to_owned()).await?;
    let mut people = vec![
        ("admin@invigil.app", "Invigil Admin", "admin"),
        ("examiner@invigil.app", "Dr. Ayesha Malik", "examiner"),
        ("examiner2@invigil.app", "Dr. Hamza Khan", "examiner"),
        ("candidate@invigil.app", "Ali Raza", "user"),
    ];
    let names = [
        "Sara Ahmed",
        "Omar Farooq",
        "Fatima Noor",
        "Bilal Hussain",
        "Ayesha Siddiqui",
        "Zainab Malik",
        "Hassan Ali",
        "Mariam Khan",
        "Usman Tariq",
        "Noor Fatima",
        "Daniel Smith",
        "Emily Chen",
        "Lucas Martin",
        "Sofia Garcia",
        "Arjun Patel",
        "Maya Johnson",
        "Ethan Brown",
        "Lina Haddad",
        "Kenji Sato",
        "Amara Okafor",
        "Ibrahim Saleh",
        "Anika Sharma",
        "Yusuf Demir",
        "Chloe Wilson",
    ];
    for (i, name) in names.iter().enumerate() {
        people.push((
            Box::leak(format!("candidate{:02}@invigil.app", i + 1).into_boxed_str()),
            name,
            "user",
        ));
    }
    let mut tx = db.begin().await?;
    for (email, name, role) in &people {
        sqlx::query("insert into users(email,display_name,role,password_hash,email_verified_at) values($1,$2,$3,$4,now()) on conflict(email) do nothing").bind(email).bind(name).bind(role).bind(&hash).execute(&mut *tx).await?;
    }
    seed_demo_exams(&mut tx, &people).await?;
    tx.commit().await?;
    println!("{:<32} {:<24} Password", "Email", "Name");
    for (email, name, _) in people {
        println!("{email:<32} {name:<24} Invigil#Demo2026");
    }
    Ok(())
}

async fn seed_demo_exams(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    people: &[(&str, &str, &str)],
) -> anyhow::Result<()> {
    let owner: sqlx::types::Uuid =
        sqlx::query_scalar("select id from users where email='examiner@invigil.app'")
            .fetch_one(&mut **tx)
            .await?;
    let inputs: Vec<exam_questions::QuestionInput> =
        serde_json::from_str(exam_questions::SEED_QUESTIONS)?;
    anyhow::ensure!(
        inputs.len() == 30,
        "expected exactly 30 bundled seed questions"
    );
    let mut question_ids = Vec::with_capacity(inputs.len());
    for question in &inputs {
        question_ids.push(
            exam_questions::insert_question(tx, owner, question)
                .await?
                .id,
        );
    }

    let now = time::OffsetDateTime::now_utc();
    let a_ids = question_ids[..10].to_vec();
    let b_ids = question_ids[24..30].to_vec();
    let c_ids = [0usize, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17]
        .into_iter()
        .map(|index| question_ids[index])
        .collect::<Vec<_>>();
    let d_ids = question_ids[6..12].to_vec();
    let total = |ids: &[sqlx::types::Uuid]| -> f64 {
        ids.iter()
            .filter_map(|id| question_ids.iter().position(|candidate| candidate == id))
            .map(|index| inputs[index].marks)
            .sum()
    };
    let exam_a = create_seed_exam(
        tx,
        owner,
        "Data Structures Midterm",
        now - time::Duration::minutes(30),
        now + time::Duration::hours(6),
        45,
        &a_ids,
        total(&a_ids),
    )
    .await?;
    exam_authoring::publish_tx(tx, exam_a).await?;
    let tomorrow = now.date() + time::Duration::days(1);
    let b_start =
        time::PrimitiveDateTime::new(tomorrow, time::Time::from_hms(5, 0, 0)?).assume_utc();
    let exam_b = create_seed_exam(
        tx,
        owner,
        "Web Security Quiz",
        b_start,
        b_start + time::Duration::hours(2),
        20,
        &b_ids,
        total(&b_ids),
    )
    .await?;
    exam_authoring::publish_tx(tx, exam_b).await?;

    let c_start = now - time::Duration::minutes(30);
    let c_end = now + time::Duration::hours(2);
    let exam_c = create_seed_exam(
        tx,
        owner,
        "Databases Final",
        c_start,
        c_end,
        90,
        &c_ids,
        total(&c_ids),
    )
    .await?;
    exam_authoring::publish_tx(tx, exam_c).await?;

    let exam_d = create_seed_exam(
        tx,
        owner,
        "Algorithms Practice",
        now + time::Duration::days(7),
        now + time::Duration::days(8),
        60,
        &d_ids,
        total(&d_ids),
    )
    .await?;
    let candidates: Vec<exam_enroll::CandidateImportRow> = people
        .iter()
        .filter(|(_, _, role)| *role == "user")
        .map(|(email, name, _)| exam_enroll::CandidateImportRow {
            email: (*email).into(),
            display_name: (*name).into(),
            extra_minutes: None,
        })
        .collect();
    exam_enroll::enroll_tx(tx, exam_a, &candidates, owner).await?;
    exam_enroll::enroll_tx(tx, exam_b, &candidates, owner).await?;
    exam_enroll::enroll_tx(tx, exam_c, &candidates, owner).await?;

    let candidates: Vec<(sqlx::types::Uuid, String)> = sqlx::query_as("select en.candidate_id,u.email::text from enrollments en join users u on u.id=en.candidate_id where en.exam_id=$1 order by u.email")
        .bind(exam_c).fetch_all(&mut **tx).await?;
    let items: Vec<(sqlx::types::Uuid, String, serde_json::Value, serde_json::Value, f64)> = sqlx::query_as("select id,kind,options,correct,marks::float8 from exam_items where exam_id=$1 and not sandbox order by position")
        .bind(exam_c).fetch_all(&mut **tx).await?;
    for (index, (candidate, _email)) in candidates
        .iter()
        .filter(|(_, email)| {
            email.starts_with("candidate") && email.as_str() != "candidate@invigil.app"
        })
        .take(20)
        .enumerate()
    {
        seed_attempt(tx, exam_c, *candidate, owner, &items, index, index < 2).await?;
    }
    let featured: sqlx::types::Uuid =
        sqlx::query_scalar("select id from users where email='candidate@invigil.app'")
            .fetch_one(&mut **tx)
            .await?;
    seed_attempt(tx, exam_c, featured, owner, &items, 24, false).await?;
    sqlx::query("update exams set starts_at=$2,ends_at=$3,status='completed',completed_at=now(),updated_at=now() where id=$1")
        .bind(exam_c).bind(now - time::Duration::hours(27)).bind(now - time::Duration::hours(25)).execute(&mut **tx).await?;
    publish_seed_results(tx, exam_c).await?;
    let _ = exam_d;
    Ok(())
}

#[allow(clippy::too_many_arguments)] // Seed fixture: one call per demo exam keeps the fixtures readable.
async fn create_seed_exam(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: sqlx::types::Uuid,
    title: &str,
    starts: time::OffsetDateTime,
    ends: time::OffsetDateTime,
    duration: i32,
    questions: &[sqlx::types::Uuid],
    total: f64,
) -> anyhow::Result<sqlx::types::Uuid> {
    let input = exam_authoring::ExamInput {
        title: title.into(),
        instructions: "Read each question carefully. Your answers are saved automatically.".into(),
        starts_at: starts,
        ends_at: ends,
        duration_minutes: duration,
        total_marks: total,
        pass_marks: total * 0.6,
        settings: exam_authoring::ExamSettings::default(),
    };
    let id = exam_authoring::create_exam_tx(tx, owner, &input).await?;
    let assigned = questions
        .iter()
        .map(|question_id| exam_authoring::AssignItem {
            question_id: *question_id,
            marks: None,
        })
        .collect::<Vec<_>>();
    exam_authoring::assign_tx(tx, id, &assigned, owner, false).await?;
    Ok(id)
}

async fn seed_attempt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    exam: sqlx::types::Uuid,
    candidate: sqlx::types::Uuid,
    grader: sqlx::types::Uuid,
    items: &[(
        sqlx::types::Uuid,
        String,
        serde_json::Value,
        serde_json::Value,
        f64,
    )],
    profile: usize,
    identical_wrong: bool,
) -> anyhow::Result<()> {
    let attempt =
        exam_attempts::start_attempt_tx(tx, exam, candidate, Some("demo-device-1234")).await?;
    sqlx::query("update attempts set started_at=now()-interval '1 day',deadline_at=now()-interval '23 hours' where id=$1")
        .bind(attempt).execute(&mut **tx).await?;
    let strength = if profile == 24 {
        100
    } else {
        [90, 60, 30][profile % 3]
    };
    let mut rng = profile as u64 + 1;
    for (position, (item_id, kind, options, correct, marks)) in items.iter().enumerate() {
        let (response, manual_marks, feedback) = if kind == "written" {
            let factor = if profile == 24 {
                0.96
            } else {
                [0.88, 0.62, 0.32][profile % 3]
            };
            (
                serde_json::json!({"text":"The relational design separates entities and uses keys to preserve integrity. Indexes accelerate lookups while adding storage and write costs."}),
                Some((marks * factor * 4.0).round() / 4.0),
                "Good explanation; consider the tradeoffs and constraints.",
            )
        } else {
            rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let should_correct = profile == 24 || (!identical_wrong && (rng % 100) < strength);
            let correct_ids = correct
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>();
            let choice = if should_correct {
                correct_ids.clone()
            } else {
                let options = options
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|option| option.get("id").and_then(serde_json::Value::as_str))
                    .collect::<Vec<_>>();
                vec![
                    options
                        .into_iter()
                        .find(|option| !correct_ids.contains(option))
                        .unwrap_or("a"),
                ]
            };
            (serde_json::json!({"selected":choice}), None, "")
        };
        sqlx::query("insert into answers(attempt_id,item_id,response,client_seq,manual_marks,feedback,graded_by,graded_at) values($1,$2,$3,$4,$5,$6,$7,case when $5::float8 is null then null else now() end)")
            .bind(attempt).bind(item_id).bind(response).bind(position as i64).bind(manual_marks).bind(feedback).bind(grader).execute(&mut **tx).await?;
    }
    if identical_wrong || profile.is_multiple_of(4) {
        sqlx::query("insert into attempt_events(attempt_id,kind,severity,detail) values($1,'focus_lost','notice',$2),($1,'paste','warning',$2)")
            .bind(attempt).bind(serde_json::json!({"count":1})).execute(&mut **tx).await?;
    }
    exam_attempts::submit_tx(tx, attempt).await?;
    exam_grading::autograde_attempt(tx, attempt).await?;
    Ok(())
}

async fn publish_seed_results(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    exam: sqlx::types::Uuid,
) -> anyhow::Result<()> {
    sqlx::query("update exams set results_published_at=now() where id=$1")
        .bind(exam)
        .execute(&mut **tx)
        .await?;
    let rows: Vec<(sqlx::types::Uuid, f64, String)> = sqlx::query_as("select a.id,a.total_score::float8,u.display_name from attempts a join users u on u.id=a.candidate_id where a.exam_id=$1 and not a.sandbox and a.status<>'in_progress'")
        .bind(exam).fetch_all(&mut **tx).await?;
    let (title, pass, total): (String, f64, f64) = sqlx::query_as(
        "select title,pass_marks::float8,total_marks::float8 from exams where id=$1",
    )
    .bind(exam)
    .fetch_one(&mut **tx)
    .await?;
    for (attempt, score, name) in rows {
        let words = name.split_whitespace().collect::<Vec<_>>();
        let first = words
            .first()
            .and_then(|word| word.chars().next())
            .unwrap_or('X');
        let last = words
            .last()
            .and_then(|word| word.chars().next())
            .unwrap_or('X');
        let last_end = words
            .last()
            .and_then(|word| word.chars().last())
            .unwrap_or('X');
        let token = kernel::crypto::new_token().0;
        let random = kernel::crypto::sha256(token.as_bytes());
        const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        let compact: String = random[..12]
            .iter()
            .map(|byte| ALPHABET[usize::from(byte & 31)] as char)
            .collect();
        let code = format!("{}-{}-{}", &compact[..4], &compact[4..8], &compact[8..12]);
        let issued = time::OffsetDateTime::now_utc();
        let statement = serde_json::json!({"certificateId":code,"examTitle":title,"candidate":format!("{first}. {last}****{last_end}"),"percent":examcore::round2(score/total*100.0),"passed":score>=pass,"issuedAt":issued,"issuer":"Inventix Invigil"});
        let hash = kernel::crypto::sha256(examcore::canonical_json(&statement).as_bytes());
        let (signature, key_id) = examcore::signer::sign(&hash);
        sqlx::query("insert into result_certificates(attempt_id,verify_code,statement,statement_hash,signature,key_id,issued_at) values($1,$2,$3,$4,$5,$6,$7)")
            .bind(attempt).bind(code).bind(statement).bind(hash.to_vec()).bind(signature.to_vec()).bind(key_id).bind(issued)
            .execute(&mut **tx).await?;
    }
    Ok(())
}

fn validate_exam_secrets() -> anyhow::Result<()> {
    if std::env::var("APP_ENV").as_deref() != Ok("production") {
        return Ok(());
    }
    let lease = std::env::var("EXAM_LEASE_KEY").unwrap_or_default();
    anyhow::ensure!(
        valid_lease_key(&lease),
        "EXAM_LEASE_KEY is required in production and must be at least 32 characters"
    );
    let signing = std::env::var("RESULT_SIGNING_KEY").unwrap_or_default();
    anyhow::ensure!(
        valid_result_signing_key(&signing),
        "RESULT_SIGNING_KEY is required in production and must be valid base64 of 32 bytes"
    );
    Ok(())
}

fn valid_lease_key(key: &str) -> bool {
    key.is_ascii() && key.len() >= 32
}

fn valid_result_signing_key(key: &str) -> bool {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(key.trim())
        .is_ok_and(|decoded| decoded.len() == 32)
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod hashing_tests {
    #[test]
    fn hashing_is_bounded() {
        assert_eq!(super::hashing_semaphore().available_permits(), 2);
    }

    #[test]
    fn production_key_validation_enforces_required_sizes() {
        use base64::Engine;

        assert!(!super::valid_lease_key("short"));
        assert!(super::valid_lease_key(&"x".repeat(32)));
        assert!(!super::valid_lease_key(&"é".repeat(32)));

        let valid = base64::engine::general_purpose::STANDARD.encode([7_u8; 32]);
        let wrong_size = base64::engine::general_purpose::STANDARD.encode([7_u8; 31]);
        assert!(super::valid_result_signing_key(&valid));
        assert!(!super::valid_result_signing_key("not base64!"));
        assert!(!super::valid_result_signing_key(&wrong_size));
    }
}
