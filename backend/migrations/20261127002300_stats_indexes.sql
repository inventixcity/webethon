-- Keep the bounded analytics windows index-backed as the exam and audit tables grow.
CREATE INDEX IF NOT EXISTS answers_saved_at_attempt_idx
    ON answers (saved_at, attempt_id);

CREATE INDEX IF NOT EXISTS attempt_events_offline_recorded_idx
    ON attempt_events (recorded_at, attempt_id)
    WHERE kind = 'offline';

CREATE INDEX IF NOT EXISTS attempt_heartbeats_online_at_idx
    ON attempt_heartbeats (at, attempt_id)
    WHERE online;

CREATE INDEX IF NOT EXISTS attempts_submitted_at_exam_idx
    ON attempts (submitted_at, exam_id)
    WHERE NOT sandbox AND submitted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS exams_owner_completed_idx
    ON exams (owner_id, completed_at DESC)
    WHERE deleted_at IS NULL AND status = 'completed';

CREATE INDEX IF NOT EXISTS sessions_active_expiry_idx
    ON sessions (expires_at, user_id)
    WHERE revoked_at IS NULL;
