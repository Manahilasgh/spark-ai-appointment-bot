-- =====================================================================
-- Appointment Booking Chatbot: PostgreSQL schema (PG 13+)
-- Multi-tenant via business_id on every tenant-owned table.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- lets us mix = and && in one exclusion constraint

-- ---------------------------------------------------------------------
-- businesses: the tenant. Every other table hangs off this.
-- ---------------------------------------------------------------------
CREATE TABLE businesses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    timezone    TEXT        NOT NULL DEFAULT 'UTC',   -- used to interpret "tomorrow at 3pm"
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- users: authentication + profile
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    email          CITEXT      NOT NULL UNIQUE,       -- globally unique so login needs no tenant hint
    password_hash  TEXT        NOT NULL,              -- bcrypt, never plaintext
    full_name      TEXT        NOT NULL,
    phone          TEXT,
    role           TEXT        NOT NULL DEFAULT 'customer'
                   CHECK (role IN ('customer', 'staff', 'admin')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_business ON users (business_id);

-- ---------------------------------------------------------------------
-- chat_sessions: one conversation; metadata lives here
-- ---------------------------------------------------------------------
CREATE TABLE chat_sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'completed', 'abandoned')),
    draft_booking JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- partially extracted details carried across turns
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user_recent ON chat_sessions (user_id, updated_at DESC);

-- ---------------------------------------------------------------------
-- chat_messages: history, one row per message (append-only)
-- Kept separate from chat_sessions so sessions stay small and history
-- can be paginated / trimmed to the last N turns for the LLM context.
-- ---------------------------------------------------------------------
CREATE TABLE chat_messages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id  UUID        NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role        TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content     TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_session_time ON chat_messages (session_id, created_at);

-- ---------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------
CREATE TABLE appointments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_session_id  UUID        REFERENCES chat_sessions(id) ON DELETE SET NULL,
    service          TEXT        NOT NULL,
    starts_at        TIMESTAMPTZ NOT NULL,
    ends_at          TIMESTAMPTZ NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
    notes            TEXT,
    created_via      TEXT        NOT NULL DEFAULT 'chat'
                     CHECK (created_via IN ('chat', 'form')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_time_order CHECK (ends_at > starts_at),

    -- Prevents double-booking at the DB level (race-safe, unlike an app-level check).
    -- Assumes one bookable resource per business; add resource_id to the constraint to extend.
    CONSTRAINT no_overlapping_appointments
        EXCLUDE USING gist (
            business_id WITH =,
            tstzrange(starts_at, ends_at) WITH &&
        ) WHERE (status <> 'cancelled')
);

-- "My appointments", the most common query
CREATE INDEX idx_appts_user_time ON appointments (user_id, starts_at DESC);
-- Staff calendar view / availability lookups
CREATE INDEX idx_appts_business_time ON appointments (business_id, starts_at);
-- Only index live bookings for dashboards (partial index keeps it small)
CREATE INDEX idx_appts_active ON appointments (business_id, starts_at)
    WHERE status IN ('pending', 'confirmed');

-- ---------------------------------------------------------------------
-- ai_logs: every LLM call, for debugging and analytics
-- ---------------------------------------------------------------------
CREATE TABLE ai_logs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id    UUID        REFERENCES businesses(id) ON DELETE SET NULL,
    session_id     UUID        REFERENCES chat_sessions(id) ON DELETE SET NULL,
    model          TEXT        NOT NULL,
    request        JSONB       NOT NULL,   -- messages sent
    response       JSONB,                  -- raw model output (null on failure)
    latency_ms     INTEGER,
    success        BOOLEAN     NOT NULL,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_logs_session ON ai_logs (session_id, created_at);
CREATE INDEX idx_ai_logs_failures ON ai_logs (created_at DESC) WHERE success = FALSE;

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated        BEFORE UPDATE ON users         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sessions_updated     BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_appointments_updated BEFORE UPDATE ON appointments  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- SAMPLE DATA
-- (password_hash is a placeholder; real hashes come from bcrypt in the API)
-- =====================================================================
INSERT INTO businesses (id, name, timezone) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Bright Smile Dental', 'Asia/Karachi');

INSERT INTO users (id, business_id, email, password_hash, full_name, phone, role) VALUES
    ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
     'ali@example.com', '$2b$10$placeholderhashplaceholderhashplaceholderhashpl', 'Ali Khan', '+92-300-1234567', 'customer'),
    ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
     'admin@brightsmile.com', '$2b$10$placeholderhashplaceholderhashplaceholderhashpl', 'Front Desk', NULL, 'admin');

INSERT INTO chat_sessions (id, business_id, user_id, status, draft_booking) VALUES
    ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', 'completed',
     '{"service": "Teeth cleaning", "date": "2026-10-05", "time": "15:00"}');

INSERT INTO chat_messages (session_id, role, content) VALUES
    ('44444444-4444-4444-4444-444444444444', 'user',      'Hi, I need a teeth cleaning next Monday afternoon'),
    ('44444444-4444-4444-4444-444444444444', 'assistant', 'Sure! What time works for you on Monday, October 5?'),
    ('44444444-4444-4444-4444-444444444444', 'user',      '3pm please'),
    ('44444444-4444-4444-4444-444444444444', 'assistant', 'Great, I have Teeth cleaning on Oct 5 at 3:00 PM. Shall I confirm?');

INSERT INTO appointments (business_id, user_id, chat_session_id, service, starts_at, ends_at, status, created_via) VALUES
    ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
     '44444444-4444-4444-4444-444444444444', 'Teeth cleaning',
     '2026-10-05 15:00:00+05', '2026-10-05 15:30:00+05', 'confirmed', 'chat');

INSERT INTO ai_logs (business_id, session_id, model, request, response, latency_ms, success) VALUES
    ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444',
     'mistral-small-latest',
     '{"messages":[{"role":"user","content":"3pm please"}]}',
     '{"reply":"Great, ...","extracted":{"time":"15:00"},"missing":[]}',
     640, TRUE);

-- =====================================================================
-- PERFORMANCE / DESIGN NOTES
-- =====================================================================
-- * Double-booking: enforced by the EXCLUDE constraint, so two concurrent
--   requests cannot both succeed. The API catches SQLSTATE 23P01 and returns 409.
-- * Timestamps are TIMESTAMPTZ (UTC); conversion uses businesses.timezone.
-- * chat_messages is the fastest-growing table. At scale: partition by month
--   on created_at, or archive old sessions. LLM context only loads the last N rows.
-- * ai_logs stores raw payloads (JSONB); add a retention job (e.g. 30 days)
--   and avoid logging PII in production.
-- * Every tenant-owned query must filter by business_id. Row-Level Security
--   would enforce this in the DB and is a natural next step.
-- * Email is globally unique for a simple login flow; a stricter multi-tenant
--   design would use UNIQUE (business_id, email) plus a tenant slug at login.