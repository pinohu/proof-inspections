/**
 * proof-inspections — Cloudflare Workers entrypoint.
 *
 * Same API contract as the Node.js Express backend (api/routes.js):
 *   GET  /health
 *   GET  /.well-known/proof-inspections-key
 *   POST /orders
 *   GET  /orders/:id
 *   POST /orders/:id/evidence   (multipart/form-data)
 *   POST /orders/:id/complete
 *   GET  /proof/:id             (public signed bundle, shareable)
 *   GET  /proof/:id/photo/:filename
 *
 * Static frontend (web/ + contractor/) is served from the [assets] binding:
 *   /              -> web/index.html
 *   /track, /track/* -> web/track.html
 *   /contractor/*  -> contractor app files
 *
 * Storage: D1 (metadata) + R2 (photo bytes). Signing key comes from the
 * PROOF_INSPECTIONS_PRIVATE_KEY_PEM Worker secret.
 */

import {
  sha256Hex,
  importPrivateKey,
  publicKeyFromPrivate,
  createProofBundle,
} from './attestation.js';
import { parseMultipart, boundaryFromContentType } from './multipart.js';

const VERSION = '0.1.0';
// Workers request-body ceiling: keep well under platform limits.
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function errJson(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

function sanitizeFilename(name) {
  const base = String(name || 'photo').split(/[\\/]/).pop().slice(0, 100) || 'photo';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Accept common phone-camera formats, incl. iPhone HEIC. */
function sniffImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  // ISO BMFF: [size][f t y p][brand] — HEIC/HEIF brands.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }
  return null;
}

function orderToJson(row) {
  return {
    id: row.id,
    propertyAddress: row.property_address,
    inspectionType: row.inspection_type,
    customerEmail: row.customer_email,
    customerName: row.customer_name,
    status: row.status,
    contractorId: row.contractor_id,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* signing key (cached per isolate)                                   */
/* ------------------------------------------------------------------ */

let cachedSigning = null;

async function getSigning(env) {
  if (cachedSigning) return cachedSigning;
  const raw = env.PROOF_INSPECTIONS_PRIVATE_KEY_PEM;
  if (!raw) {
    throw Object.assign(
      new Error('signing key not configured: set the PROOF_INSPECTIONS_PRIVATE_KEY_PEM secret'),
      { statusCode: 500, code: 'signing_unavailable' },
    );
  }
  const privateKeyPem = raw.replace(/\\n/g, '\n');
  const signKey = await importPrivateKey(privateKeyPem);
  const publicKeyPem = await publicKeyFromPrivate(privateKeyPem);
  cachedSigning = { signKey, publicKeyPem };
  return cachedSigning;
}

/* ------------------------------------------------------------------ */
/* D1 access                                                          */
/* ------------------------------------------------------------------ */

async function getOrder(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
}

async function listEvidenceWithPhotos(db, orderId) {
  const ev = await db
    .prepare('SELECT * FROM evidence WHERE order_id = ? ORDER BY created_at ASC')
    .bind(orderId)
    .all();
  const evidenceRows = ev.results || [];
  const out = [];
  for (const e of evidenceRows) {
    const ph = await db
      .prepare('SELECT * FROM evidence_photos WHERE evidence_id = ? ORDER BY filename ASC')
      .bind(e.id)
      .all();
    out.push({
      id: e.id,
      notes: e.notes,
      gps: e.gps_lat !== null && e.gps_lat !== undefined ? { lat: e.gps_lat, lng: e.gps_lng } : null,
      capturedAt: e.captured_at,
      inspectorId: e.inspector_id,
      createdAt: e.created_at,
      photos: (ph.results || []).map((p) => ({
        filename: p.filename,
        originalFilename: p.original_filename,
        sha256: p.sha256,
        sizeBytes: p.size_bytes,
        mimeType: p.mime_type,
      })),
    });
  }
  return out;
}

/** Evidence rows in the canonical bundle shape (no originalFilename/createdAt). */
async function bundleEvidence(db, orderId) {
  const ev = await db
    .prepare('SELECT * FROM evidence WHERE order_id = ? ORDER BY created_at ASC')
    .bind(orderId)
    .all();
  const out = [];
  for (const e of (ev.results || [])) {
    const ph = await db
      .prepare('SELECT * FROM evidence_photos WHERE evidence_id = ? ORDER BY filename ASC')
      .bind(e.id)
      .all();
    out.push({
      id: e.id,
      notes: e.notes,
      gps: e.gps_lat !== null && e.gps_lat !== undefined ? { lat: e.gps_lat, lng: e.gps_lng } : null,
      capturedAt: e.captured_at,
      inspectorId: e.inspector_id,
      photos: (ph.results || []).map((p) => ({
        filename: p.filename,
        sha256: p.sha256,
        sizeBytes: p.size_bytes,
        mimeType: p.mime_type,
      })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* route handlers                                                     */
/* ------------------------------------------------------------------ */

async function handleCreateOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errJson(400, 'invalid_json', 'request body must be JSON');
  }
  const { propertyAddress, inspectionType, customerEmail, customerName, contractorId } = body || {};
  if (!propertyAddress || typeof propertyAddress !== 'string' || !propertyAddress.trim()) {
    return errJson(400, 'invalid_property_address', 'propertyAddress is required');
  }
  if (!inspectionType || typeof inspectionType !== 'string' || !inspectionType.trim()) {
    return errJson(400, 'invalid_inspection_type', 'inspectionType is required');
  }
  if (!customerEmail || !EMAIL_RE.test(String(customerEmail))) {
    return errJson(400, 'invalid_customer_email', 'customerEmail must be a valid email address');
  }
  if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
    return errJson(400, 'invalid_customer_name', 'customerName is required');
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO orders (id, property_address, inspection_type, customer_email, customer_name, status, contractor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      propertyAddress.trim(),
      inspectionType.trim(),
      String(customerEmail).trim().toLowerCase(),
      customerName.trim(),
      'pending',
      contractorId || null,
      now,
    )
    .run();
  const row = await getOrder(env.DB, id);
  return Response.json({ order: orderToJson(row) }, { status: 201 });
}

async function handleGetOrder(_request, env, orderId) {
  const row = await getOrder(env.DB, orderId);
  if (!row) return errJson(404, 'order_not_found', 'no such order');
  const evidence = await listEvidenceWithPhotos(env.DB, row.id);
  const proofRow = await env.DB.prepare('SELECT * FROM proofs WHERE order_id = ?').bind(row.id).first();
  const proof = proofRow
    ? { id: proofRow.id, bundleHash: proofRow.bundle_hash, proofUrl: `/proof/${proofRow.id}`, createdAt: proofRow.created_at }
    : null;
  return Response.json({ order: orderToJson(row), evidence, proof });
}

async function handleSubmitEvidence(request, env, orderId) {
  const order = await getOrder(env.DB, orderId);
  if (!order) return errJson(404, 'order_not_found', 'no such order');
  if (order.status === 'complete') {
    return errJson(409, 'order_complete', 'cannot add evidence to a completed order');
  }
  const boundary = boundaryFromContentType(request.headers.get('content-type'));
  if (!boundary) return errJson(400, 'invalid_content_type', 'expected multipart/form-data');

  let raw;
  try {
    raw = new Uint8Array(await request.arrayBuffer());
  } catch (e) {
    return errJson(400, 'invalid_multipart', 'could not read request body: ' + e.message);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return errJson(413, 'body_too_large', 'request body exceeds the 50 MB limit');
  }

  let parts;
  try {
    parts = parseMultipart(raw, boundary, { maxFiles: MAX_PHOTOS, maxFileSize: MAX_PHOTO_BYTES });
  } catch (e) {
    return errJson(400, 'invalid_multipart', e.message);
  }

  const field = (name) => {
    const v = parts.fields[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const inspectorId = (field('inspectorId') || '').trim();
  if (!inspectorId) return errJson(400, 'invalid_inspector_id', 'inspectorId field is required');

  let gps = null;
  const latRaw = field('gpsLat');
  const lngRaw = field('gpsLng');
  if (latRaw !== undefined || lngRaw !== undefined) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return errJson(400, 'invalid_gps', 'gpsLat must be -90..90 and gpsLng -180..180');
    }
    gps = { lat, lng };
  }

  let capturedAt = field('capturedAt');
  if (capturedAt !== undefined) {
    const d = new Date(capturedAt);
    if (Number.isNaN(d.getTime())) return errJson(400, 'invalid_captured_at', 'capturedAt must be ISO-8601');
    capturedAt = d.toISOString();
  } else {
    capturedAt = new Date().toISOString();
  }

  const photos = parts.files.filter((f) => f.fieldname === 'photos');
  if (photos.length === 0) return errJson(400, 'no_photos', 'at least one photo (field "photos") is required');
  for (const p of photos) {
    const kind = sniffImageType(p.data);
    if (!kind) {
      return errJson(415, 'unsupported_photo_type', `photo "${p.filename}" is not a recognized image (jpeg/png/gif/webp/heic)`);
    }
    p.mimeType = kind;
    p.digest = await sha256Hex(p.data);
  }

  const evidenceId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Store photo bytes in R2 first (content-addressed by order + filename).
  const savedPhotos = [];
  for (const p of photos) {
    const filename = `${crypto.randomUUID()}-${sanitizeFilename(p.filename)}`;
    const r2Key = `photos/${order.id}/${filename}`;
    await env.PHOTOS.put(r2Key, p.data, { httpMetadata: { contentType: p.mimeType } });
    savedPhotos.push({
      filename,
      originalFilename: p.filename,
      r2Key,
      sha256: p.digest,
      sizeBytes: p.data.length,
      mimeType: p.mimeType,
    });
  }

  // Persist metadata in D1 (batched for atomicity).
  const stmts = [
    env.DB.prepare(
      `INSERT INTO evidence (id, order_id, notes, gps_lat, gps_lng, captured_at, inspector_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(evidenceId, order.id, field('notes') ?? null, gps ? gps.lat : null, gps ? gps.lng : null, capturedAt, inspectorId, now),
  ];
  for (const sp of savedPhotos) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO evidence_photos (id, evidence_id, order_id, filename, original_filename, stored_path, sha256, size_bytes, mime_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), evidenceId, order.id, sp.filename, sp.originalFilename,
        sp.r2Key, sp.sha256, sp.sizeBytes, sp.mimeType, now,
      ),
    );
  }
  if (order.status === 'pending' || order.status === 'dispatched') {
    stmts.push(env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('in_progress', order.id));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return errJson(500, 'evidence_store_failed', 'failed to persist evidence: ' + e.message);
  }

  return Response.json(
    {
      evidence: {
        id: evidenceId,
        orderId: order.id,
        notes: field('notes') ?? null,
        gps,
        capturedAt,
        inspectorId,
        createdAt: now,
        photos: savedPhotos.map(({ filename, originalFilename, sha256, sizeBytes, mimeType }) => ({
          filename, originalFilename, sha256, sizeBytes, mimeType,
        })),
      },
    },
    { status: 201 },
  );
}

async function handleCompleteOrder(request, env, orderId) {
  const order = await getOrder(env.DB, orderId);
  if (!order) return errJson(404, 'order_not_found', 'no such order');
  if (order.status === 'complete') {
    const existing = await env.DB.prepare('SELECT * FROM proofs WHERE order_id = ?').bind(order.id).first();
    return Response.json({
      proof: {
        id: existing.id,
        bundleHash: existing.bundle_hash,
        proofUrl: `/proof/${existing.id}`,
        createdAt: existing.created_at,
      },
      alreadyComplete: true,
    });
  }
  const evidence = await bundleEvidence(env.DB, order.id);
  if (evidence.length === 0) {
    return errJson(409, 'no_evidence', 'cannot complete an order with no evidence');
  }

  let bodyInspectorId = null;
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      const body = await request.json();
      bodyInspectorId = body && body.inspectorId ? String(body.inspectorId) : null;
    } catch { /* ignore malformed body; fall back below */ }
  }
  const inspectorId = bodyInspectorId || evidence[evidence.length - 1].inspectorId;
  const timestamp = new Date().toISOString();

  let signing;
  try {
    signing = await getSigning(env);
  } catch (e) {
    return errJson(e.statusCode || 500, e.code || 'signing_failed', e.message);
  }

  let bundle;
  try {
    bundle = await createProofBundle({
      orderId: order.id,
      inspectorId,
      timestamp,
      evidence,
      signKey: signing.signKey,
      publicKeyPem: signing.publicKeyPem,
    });
  } catch (e) {
    return errJson(500, 'attestation_failed', 'failed to create proof bundle: ' + e.message);
  }

  const proofId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO proofs (id, order_id, bundle_json, bundle_hash, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(proofId, order.id, JSON.stringify(bundle), bundle.bundleHash, bundle.signature, timestamp),
    env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind('complete', order.id),
  ]);

  return Response.json(
    {
      proof: {
        id: proofId,
        bundleHash: bundle.bundleHash,
        signature: bundle.signature,
        proofUrl: `/proof/${proofId}`,
        createdAt: timestamp,
      },
    },
    { status: 201 },
  );
}

async function handleGetProof(_request, env, proofId) {
  const row = await env.DB.prepare('SELECT * FROM proofs WHERE id = ?').bind(proofId).first();
  if (!row) return errJson(404, 'proof_not_found', 'no such proof');
  return Response.json(JSON.parse(row.bundle_json), {
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}

async function handleGetProofPhoto(_request, env, proofId, filename) {
  if (filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
    return errJson(400, 'invalid_filename', 'filename is not valid');
  }
  const proofRow = await env.DB.prepare('SELECT * FROM proofs WHERE id = ?').bind(proofId).first();
  if (!proofRow) return errJson(404, 'proof_not_found', 'no such proof');
  const photo = await env.DB
    .prepare('SELECT * FROM evidence_photos WHERE order_id = ? AND filename = ?')
    .bind(proofRow.order_id, filename)
    .first();
  if (!photo) return errJson(404, 'photo_not_found', 'no such photo in this proof');
  const obj = await env.PHOTOS.get(photo.stored_path);
  if (!obj) return errJson(404, 'photo_not_found', 'photo bytes missing from storage');
  return new Response(obj.body, {
    headers: {
      'X-Photo-SHA256': photo.sha256,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': photo.mime_type || 'application/octet-stream',
    },
  });
}

/* ------------------------------------------------------------------ */
/* router                                                             */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      if (method === 'GET' && path === '/health') {
        return Response.json({ ok: true, service: 'proof-inspections', version: VERSION });
      }

      if (method === 'GET' && path === '/.well-known/proof-inspections-key') {
        const signing = await getSigning(env).catch((e) => ({ error: e }));
        if (signing.error) {
          return errJson(signing.error.statusCode || 500, signing.error.code || 'signing_failed', signing.error.message);
        }
        return new Response(signing.publicKeyPem, { headers: { 'Content-Type': 'text/plain' } });
      }

      if (method === 'POST' && path === '/orders') {
        return handleCreateOrder(request, env);
      }

      let m = path.match(/^\/orders\/([^/]+)$/);
      if (m) {
        if (method === 'GET') return handleGetOrder(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      m = path.match(/^\/orders\/([^/]+)\/evidence$/);
      if (m) {
        if (method === 'POST') return handleSubmitEvidence(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      m = path.match(/^\/orders\/([^/]+)\/complete$/);
      if (m) {
        if (method === 'POST') return handleCompleteOrder(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      m = path.match(/^\/proof\/([^/]+)\/photo\/(.+)$/);
      if (m) {
        if (method === 'GET') {
          return handleGetProofPhoto(request, env, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        }
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      m = path.match(/^\/proof\/([^/]+)$/);
      if (m) {
        if (method === 'GET') return handleGetProof(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      // Static frontend.
      if (path === '/track' || path.startsWith('/track/')) {
        return env.ASSETS.fetch(new Request(new URL('/track.html', url), request));
      }
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status === 404 && path.startsWith('/api/')) {
        return errJson(404, 'not_found', 'no such endpoint');
      }
      return assetRes;
    } catch (e) {
      return errJson(e.statusCode || 500, e.code || 'internal_error', e.message || 'internal error');
    }
  },
};
