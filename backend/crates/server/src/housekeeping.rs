//! Deletes rows that can never matter again, so the growing tables stay small.
//!
//! Every statement removes at most 1000 rows per run, so one tick never holds a table lock for long;
//! the next tick (every 10 minutes) takes the next batch. Safe with several replicas: two runs that
//! target the same row just make one of them skip it.

use sqlx::PgPool;

const STATEMENTS: &[&str] = &[
    "delete from jobs where id in (select id from jobs where status in ('done','dead') and finished_at < now() - interval '7 days' limit 1000)",
    "delete from http_request_stats where minute < date_trunc('minute', now()) - interval '7 days'",
    // The longest rate-limit window is one hour.
    "delete from rate_limits where window_start < now() - interval '1 day'",
    "delete from idempotency_keys where created_at < now() - interval '2 days'",
    "delete from email_codes where expires_at < now() - interval '1 day'",
    "delete from reset_grants where expires_at < now() - interval '1 day'",
    "delete from sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'",
    // Login challenges live 5 minutes and are only read while unexpired.
    "delete from mfa_challenges where token_hash in (select token_hash from mfa_challenges where expires_at < now() - interval '1 day' limit 1000)",
    // Signups live 15 minutes and are only read while unexpired.
    "delete from pending_signups where id in (select id from pending_signups where expires_at < now() - interval '1 day' limit 1000)",
    // A missing step-up row already means "confirm again", so an old expired one changes nothing.
    "delete from admin_step_up where session_id in (select session_id from admin_step_up where expires_at < now() - interval '1 day' limit 1000)",
    // Proposed assistant actions live at most 10 minutes; consumed or cancelled ones are never reused.
    "delete from assist_pending_actions where action_id in (select action_id from assist_pending_actions where expires_at < now() - interval '1 day' limit 1000)",
    // Notifications are an inbox: read or unread, a month is plenty.
    "delete from social_notifications where id in (select id from social_notifications where created_at < now() - interval '30 days' limit 1000)",
    // Invite links are dead once expired (accepting checks expires_at), so the rows can go.
    "delete from team_invites where id in (select id from team_invites where expires_at < now() - interval '7 days' limit 1000)",
    // Only finished deliveries: a pending one may still be retried.
    "delete from webhook_deliveries where id in (select id from webhook_deliveries where status in ('delivered','failed') and created_at < now() - interval '7 days' limit 1000)",
    // Expired or revoked share links can't serve the record any more.
    "delete from shares where id in (select id from shares where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days' limit 1000)",
];

/// Runs every retention statement once. Each statement is independent: a failure is logged and
/// retried on the next tick.
pub async fn run(db: &PgPool) {
    for &statement in STATEMENTS {
        if let Err(error) = sqlx::query(statement).execute(db).await {
            tracing::warn!(%error, statement, "housekeeping step failed");
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::run;

    #[sqlx::test(migrations = "../../migrations")]
    async fn retention_removes_only_old_terminal_jobs(db: sqlx::PgPool) {
        sqlx::query("insert into jobs(kind,payload,status,finished_at) values ('x','{}','done',now()-interval '8 days'),('x','{}','dead',now()-interval '8 days'),('x','{}','done',now()),('x','{}','failed',null)")
            .execute(&db).await.unwrap();
        run(&db).await;
        let statuses: Vec<String> = sqlx::query_scalar("select status from jobs order by status")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(statuses, vec!["done", "failed"]);
    }

    #[sqlx::test(migrations = "../../migrations")]
    async fn removes_only_statistics_older_than_seven_days(db: sqlx::PgPool) {
        // Rows sit a minute or more away from the cutoff, so a minute boundary during the test
        // can't flip the result.
        sqlx::query(
            "insert into http_request_stats values \
             (date_trunc('minute', now()) - interval '7 days' - interval '2 minutes', 'GET', '/expired', 200, 1), \
             (date_trunc('minute', now()) - interval '7 days' + interval '1 minute', 'GET', '/kept-edge', 200, 1), \
             (date_trunc('minute', now()) - interval '6 days', 'GET', '/kept', 200, 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        run(&db).await;
        let mut routes: Vec<String> = sqlx::query_scalar("select route from http_request_stats")
            .fetch_all(&db)
            .await
            .unwrap();
        routes.sort();
        assert_eq!(routes, vec!["/kept", "/kept-edge"]);
    }

    /// Each covered table gets one expired row and one fresh row. After one run, exactly one row
    /// must remain per table, and it must be the fresh one.
    #[sqlx::test(migrations = "../../migrations")]
    async fn purges_only_expired_rows_from_covered_tables(db: sqlx::PgPool) {
        // Parents first. Ids are fixed so the child rows below can reference them.
        let setup: &[&str] = &[
            "insert into users (id, email) values ('00000000-0000-0000-0000-000000000001', 'owner@example.com')",
            "insert into sessions (id, user_id, token_hash, expires_at) values \
             ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', decode(repeat('10', 32), 'hex'), now() + interval '1 hour'), \
             ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', decode(repeat('11', 32), 'hex'), now() + interval '1 hour')",
            "insert into records (id, entity, owner_id, data) values ('00000000-0000-0000-0000-000000000020', 'notes', '00000000-0000-0000-0000-000000000001', '{}')",
            "insert into teams (id, name, slug) values ('00000000-0000-0000-0000-000000000030', 'Hack team', 'hack-team')",
            "insert into webhooks (id, owner_id, url, events, secret_ciphertext) values ('00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000001', 'https://example.com/hook', array['record.created'], decode('00', 'hex'))",
            // admin_step_up is keyed by session: session ...11 gets the expired row, ...10 the fresh one.
            "insert into admin_step_up (session_id, expires_at) values ('00000000-0000-0000-0000-000000000011', now() - interval '2 days'), ('00000000-0000-0000-0000-000000000010', now() + interval '10 minutes')",
            "insert into mfa_challenges (token_hash, user_id, expires_at) values (decode(repeat('20', 32), 'hex'), '00000000-0000-0000-0000-000000000001', now() - interval '2 days'), (decode(repeat('21', 32), 'hex'), '00000000-0000-0000-0000-000000000001', now() + interval '5 minutes')",
            "insert into pending_signups (email, token_hash, code_hash, password_hash, display_name, expires_at) values ('old@example.com', decode(repeat('30', 32), 'hex'), decode(repeat('31', 32), 'hex'), 'hash', 'Old', now() - interval '2 days'), ('new@example.com', decode(repeat('32', 32), 'hex'), decode(repeat('33', 32), 'hex'), 'hash', 'New', now() + interval '15 minutes')",
            // The check constraint caps a proposed action at 10 minutes after creation.
            "insert into assist_pending_actions (user_id, kind, entity, data, created_at, expires_at) values ('00000000-0000-0000-0000-000000000001', 'create_record', 'notes', '{}', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes'), ('00000000-0000-0000-0000-000000000001', 'create_record', 'notes', '{}', now(), now() + interval '10 minutes')",
            "insert into social_notifications (recipient_id, kind, created_at) values ('00000000-0000-0000-0000-000000000001', 'follow', now() - interval '31 days'), ('00000000-0000-0000-0000-000000000001', 'follow', now())",
            "insert into team_invites (team_id, email, role, token_hash, expires_at) values ('00000000-0000-0000-0000-000000000030', 'old@example.com', 'member', decode(repeat('40', 32), 'hex'), now() - interval '8 days'), ('00000000-0000-0000-0000-000000000030', 'new@example.com', 'member', decode(repeat('41', 32), 'hex'), now() + interval '7 days')",
            "insert into webhook_deliveries (webhook_id, event_id, status, created_at) values ('00000000-0000-0000-0000-000000000040', gen_random_uuid(), 'delivered', now() - interval '8 days'), ('00000000-0000-0000-0000-000000000040', gen_random_uuid(), 'delivered', now())",
            "insert into shares (record_id, creator_id, token_hash, created_at, expires_at) values ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', decode(repeat('50', 32), 'hex'), now() - interval '9 days', now() - interval '8 days'), ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', decode(repeat('51', 32), 'hex'), now(), now() + interval '7 days')",
        ];
        for &statement in setup {
            sqlx::query(statement).execute(&db).await.unwrap();
        }

        run(&db).await;

        // (total rows, rows still inside their retention window), per table.
        let checks: [(&str, &str); 8] = [
            (
                "mfa_challenges",
                "select count(*), count(*) filter (where expires_at > now()) from mfa_challenges",
            ),
            (
                "pending_signups",
                "select count(*), count(*) filter (where expires_at > now()) from pending_signups",
            ),
            (
                "admin_step_up",
                "select count(*), count(*) filter (where expires_at > now()) from admin_step_up",
            ),
            (
                "assist_pending_actions",
                "select count(*), count(*) filter (where expires_at > now()) from assist_pending_actions",
            ),
            (
                "social_notifications",
                "select count(*), count(*) filter (where created_at > now() - interval '30 days') from social_notifications",
            ),
            (
                "team_invites",
                "select count(*), count(*) filter (where expires_at > now()) from team_invites",
            ),
            (
                "webhook_deliveries",
                "select count(*), count(*) filter (where created_at > now() - interval '7 days') from webhook_deliveries",
            ),
            (
                "shares",
                "select count(*), count(*) filter (where expires_at > now()) from shares",
            ),
        ];
        for (table, sql) in checks {
            let (total, fresh): (i64, i64) = sqlx::query_as(sql).fetch_one(&db).await.unwrap();
            assert_eq!(
                (total, fresh),
                (1, 1),
                "{table}: expected only the fresh row to remain"
            );
        }
    }
}
