'use strict';

/**
 * SQLite persistence for proof-inspections (MVP).
 *
 * Uses Node.js built-in `node:sqlite` — zero native addons, zero extra
 * dependencies. The module exposes a small repository API; swapping to
 * Postgres later means replacing this file's internals only.
 */

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
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
`;

function openDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const stmts = {
    insertOrder: db.prepare(
      `INSERT INTO orders (id, property_address, inspection_type, customer_email, customer_name, status, contractor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
    setOrderStatus: db.prepare('UPDATE orders SET status = ? WHERE id = ?'),
    setOrderContractor: db.prepare('UPDATE orders SET contractor_id = ? WHERE id = ?'),
    insertEvidence: db.prepare(
      `INSERT INTO evidence (id, order_id, notes, gps_lat, gps_lng, captured_at, inspector_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertPhoto: db.prepare(
      `INSERT INTO evidence_photos (id, evidence_id, order_id, filename, original_filename, stored_path, sha256, size_bytes, mime_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listEvidence: db.prepare('SELECT * FROM evidence WHERE order_id = ? ORDER BY created_at ASC'),
    listPhotosByEvidence: db.prepare('SELECT * FROM evidence_photos WHERE evidence_id = ? ORDER BY filename ASC'),
    listPhotosByOrder: db.prepare('SELECT * FROM evidence_photos WHERE order_id = ? ORDER BY filename ASC'),
    getPhoto: db.prepare('SELECT * FROM evidence_photos WHERE order_id = ? AND filename = ?'),
    insertProof: db.prepare(
      `INSERT INTO proofs (id, order_id, bundle_json, bundle_hash, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    getProof: db.prepare('SELECT * FROM proofs WHERE id = ?'),
    getProofByOrder: db.prepare('SELECT * FROM proofs WHERE order_id = ?'),
  };

  return { db, stmts };
}

module.exports = { openDatabase };
