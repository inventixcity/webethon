CREATE TABLE user_preferences (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON user_preferences FROM PUBLIC, anon, authenticated;

CREATE TABLE institution_settings (
    id smallint PRIMARY KEY CHECK (id = 1),
    name text NOT NULL DEFAULT 'Inventix Invigil',
    short_name text NOT NULL DEFAULT 'Invigil',
    contact_email text NOT NULL DEFAULT 'info@inventixhq.com',
    support_hours text NOT NULL DEFAULT 'Sunday–Thursday, 09:00–17:00 PKT',
    default_time_zone text NOT NULL DEFAULT 'Asia/Karachi',
    ai_suggestions_enabled boolean NOT NULL DEFAULT false,
    allow_candidate_self_delete boolean NOT NULL DEFAULT false,
    staff_mfa_required boolean NOT NULL DEFAULT false,
    results_verification_public boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE institution_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON institution_settings FROM PUBLIC, anon, authenticated;
INSERT INTO institution_settings(id) VALUES (1) ON CONFLICT DO NOTHING;
