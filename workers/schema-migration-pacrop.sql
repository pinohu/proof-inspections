-- schema-migration-pacrop.sql — PA CROP-level upgrade for proof-inspections.
--
-- Adds: passwordless auth (magic codes + sessions), contractor accounts,
-- transactional email log, and order timeline events.
--
-- Apply with:
--   wrangler d1 execute proof-inspections --file=./schema-migration-pacrop.sql
--
-- All tables use IF NOT EXISTS so the migration is idempotent.

-- ----------------------------------------------------------------
-- Passwordless auth: 6-char magic codes (PA CROP style).
-- Codes are stored as SHA-256 hashes, never plaintext.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer','contractor','admin')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email);
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);

-- ----------------------------------------------------------------
-- Auth sessions: opaque bearer tokens.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('customer','contractor','admin')),
  contractor_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON auth_sessions(email);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON auth_sessions(expires_at);

-- ----------------------------------------------------------------
-- Contractor accounts — proper accounts, not just ID codes.
-- The `id` keeps the human-friendly format (e.g. LM-001) so existing
-- contractor ID references keep working.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contractors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- ----------------------------------------------------------------
-- Transactional email log — every lifecycle email is recorded.
-- status: queued | sent | stubbed | failed
-- provider: stub | emailit | resend
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','stubbed','failed')),
  provider TEXT,
  error TEXT,
  order_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log(to_email);
CREATE INDEX IF NOT EXISTS idx_email_log_order ON email_log(order_id);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);

-- ----------------------------------------------------------------
-- Order timeline events — powers the customer portal timeline.
-- event: created | paid | dispatched | evidence_received | completed
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
