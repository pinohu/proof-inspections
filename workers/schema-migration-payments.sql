-- schema-migration-payments.sql — Stripe payment tables for proof-inspections.
--
-- Adds payment tracking WITHOUT touching the existing orders CHECK constraint.
-- Apply with:
--   wrangler d1 execute proof-inspections --file=./schema-migration-payments.sql
--
-- Payment status lifecycle: unpaid -> requires_payment -> paid | failed
-- Dispatch logic should only assign contractors to orders whose payment
-- status is 'paid' (see STRIPE-GO-LIVE.md).

CREATE TABLE IF NOT EXISTS order_payments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (status IN ('unpaid','requires_payment','paid','failed')),
  intent_id TEXT,
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'usd',
  paid_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON order_payments(status);
