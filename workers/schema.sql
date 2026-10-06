-- D1 schema for proof-inspections (Cloudflare Workers).
--
-- Mirrors the Node.js SQLite schema in api/db.js. The evidence_photos
-- `stored_path` column holds the R2 object key (photos/<orderId>/<filename>).
--
-- Apply with:
--   wrangler d1 execute proof-inspections --file=./schema.sql

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  property_address TEXT NOT NULL,
  inspection_type TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dispatched','in_progress','complete')),
  contractor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  notes TEXT,
  gps_lat REAL,
  gps_lng REAL,
  captured_at TEXT NOT NULL,
  inspector_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_photos (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  filename TEXT NOT NULL,
  original_filename TEXT,
  stored_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proofs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  bundle_json TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_order ON evidence(order_id);
CREATE INDEX IF NOT EXISTS idx_photos_order ON evidence_photos(order_id);
CREATE INDEX IF NOT EXISTS idx_photos_evidence ON evidence_photos(evidence_id);
