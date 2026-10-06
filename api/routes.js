'use strict';

/**
 * HTTP routes for the proof-inspections API.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /.well-known/proof-inspections-key
 *   POST /orders                 { propertyAddress, inspectionType, customerEmail, customerName, contractorId? }
 *   GET  /orders/:id
 *   POST /orders/:id/evidence    multipart: photos[] + notes, gpsLat, gpsLng, inspectorId, capturedAt
 *   POST /orders/:id/complete    sign the proof bundle, mark order complete
 *   GET  /proof/:id              public signed proof bundle (shareable)
 *   GET  /proof/:id/photo/:filename   the attested photo bytes
 */

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Router } = require('express');
const { parseMultipart, boundaryFromContentType } = require('./multipart');

const MAX_BODY_BYTES = 120 * 1024 * 1024; // hard cap for evidence uploads
const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

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
    const brand = buf.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }
  return null;
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'photo')).slice(0, 100) || 'photo';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function err(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function buildRouter({ stmts, attestation, keypair, dataDir }) {
  const router = Router();
  const photoDir = path.join(dataDir, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });

  function readRawBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'proof-inspections', version: '0.1.0' });
  });

  // Public key transparency: anyone can fetch the key that signs bundles.
  router.get('/.well-known/proof-inspections-key', (_req, res) => {
    res.type('text/plain').send(keypair.publicKeyPem);
  });

  router.post('/orders', (req, res) => {
    const { propertyAddress, inspectionType, customerEmail, customerName, contractorId } = req.body || {};
    if (!propertyAddress || typeof propertyAddress !== 'string' || !propertyAddress.trim()) {
      return err(res, 400, 'invalid_property_address', 'propertyAddress is required');
    }
    if (!inspectionType || typeof inspectionType !== 'string' || !inspectionType.trim()) {
      return err(res, 400, 'invalid_inspection_type', 'inspectionType is required');
    }
    if (!customerEmail || !EMAIL_RE.test(String(customerEmail))) {
      return err(res, 400, 'invalid_customer_email', 'customerEmail must be a valid email address');
    }
    if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
      return err(res, 400, 'invalid_customer_name', 'customerName is required');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    stmts.insertOrder.run(
      id,
      propertyAddress.trim(),
      inspectionType.trim(),
      String(customerEmail).trim().toLowerCase(),
      customerName.trim(),
      'pending',
      contractorId || null,
      now,
    );
    const row = stmts.getOrder.get(id);
    return res.status(201).json({ order: orderToJson(row) });
  });

  router.get('/orders/:id', (req, res) => {
    const row = stmts.getOrder.get(req.params.id);
    if (!row) return err(res, 404, 'order_not_found', 'no such order');
    const evidenceRows = stmts.listEvidence.all(row.id);
    const evidence = evidenceRows.map((e) => ({
      id: e.id,
      notes: e.notes,
      gps: e.gps_lat !== null ? { lat: e.gps_lat, lng: e.gps_lng } : null,
      capturedAt: e.captured_at,
      inspectorId: e.inspector_id,
      createdAt: e.created_at,
      photos: stmts.listPhotosByEvidence.all(e.id).map((p) => ({
        filename: p.filename,
        originalFilename: p.original_filename,
        sha256: p.sha256,
        sizeBytes: p.size_bytes,
        mimeType: p.mime_type,
      })),
    }));
    const proofRow = stmts.getProofByOrder.get(row.id);
    const proof = proofRow
      ? { id: proofRow.id, bundleHash: proofRow.bundle_hash, proofUrl: `/proof/${proofRow.id}`, createdAt: proofRow.created_at }
      : null;
    return res.json({ order: orderToJson(row), evidence, proof });
  });

  router.post('/orders/:id/evidence', async (req, res) => {
    const order = stmts.getOrder.get(req.params.id);
    if (!order) return err(res, 404, 'order_not_found', 'no such order');
    if (order.status === 'complete') {
      return err(res, 409, 'order_complete', 'cannot add evidence to a completed order');
    }
    const boundary = boundaryFromContentType(req.headers['content-type']);
    if (!boundary) return err(res, 400, 'invalid_content_type', 'expected multipart/form-data');

    let parts;
    try {
      const body = await readRawBody(req);
      parts = parseMultipart(body, boundary, { maxFiles: MAX_PHOTOS, maxFileSize: MAX_PHOTO_BYTES });
    } catch (e) {
      const status = e.statusCode || 400;
      return err(res, status, 'invalid_multipart', e.message);
    }

    const field = (name) => {
      const v = parts.fields[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const inspectorId = (field('inspectorId') || '').trim();
    if (!inspectorId) return err(res, 400, 'invalid_inspector_id', 'inspectorId field is required');

    let gps = null;
    const latRaw = field('gpsLat');
    const lngRaw = field('gpsLng');
    if (latRaw !== undefined || lngRaw !== undefined) {
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return err(res, 400, 'invalid_gps', 'gpsLat must be -90..90 and gpsLng -180..180');
      }
      gps = { lat, lng };
    }

    let capturedAt = field('capturedAt');
    if (capturedAt !== undefined) {
      const d = new Date(capturedAt);
      if (Number.isNaN(d.getTime())) return err(res, 400, 'invalid_captured_at', 'capturedAt must be ISO-8601');
      capturedAt = d.toISOString();
    } else {
      capturedAt = new Date().toISOString();
    }

    const photos = parts.files.filter((f) => f.fieldname === 'photos');
    if (photos.length === 0) return err(res, 400, 'no_photos', 'at least one photo (field "photos") is required');
    for (const p of photos) {
      const kind = sniffImageType(p.data);
      if (!kind) {
        return err(res, 415, 'unsupported_photo_type', `photo "${p.filename}" is not a recognized image (jpeg/png/gif/webp/heic)`);
      }
      p.mimeType = kind;
    }

    const evidenceId = randomUUID();
    const now = new Date().toISOString();
    const orderPhotoDir = path.join(photoDir, order.id);
    fs.mkdirSync(orderPhotoDir, { recursive: true });

    const savedPhotos = [];
    try {
      stmts.insertEvidence.run(
        evidenceId, order.id, field('notes') ?? null,
        gps ? gps.lat : null, gps ? gps.lng : null,
        capturedAt, inspectorId, now,
      );
      for (const p of photos) {
        const filename = `${randomUUID()}-${sanitizeFilename(p.filename)}`;
        const storedPath = path.join(orderPhotoDir, filename);
        fs.writeFileSync(storedPath, p.data);
        const digest = attestation.sha256Hex(p.data);
        stmts.insertPhoto.run(
          randomUUID(), evidenceId, order.id, filename, p.filename,
          storedPath, digest, p.data.length, p.mimeType, now,
        );
        savedPhotos.push({ filename, originalFilename: p.filename, sha256: digest, sizeBytes: p.data.length, mimeType: p.mimeType });
      }
    } catch (e) {
      return err(res, 500, 'evidence_store_failed', 'failed to persist evidence: ' + e.message);
    }

    if (order.status === 'pending' || order.status === 'dispatched') {
      stmts.setOrderStatus.run('in_progress', order.id);
    }
    return res.status(201).json({
      evidence: {
        id: evidenceId,
        orderId: order.id,
        notes: field('notes') ?? null,
        gps,
        capturedAt,
        inspectorId,
        createdAt: now,
        photos: savedPhotos,
      },
    });
  });

  router.post('/orders/:id/complete', (req, res) => {
    const order = stmts.getOrder.get(req.params.id);
    if (!order) return err(res, 404, 'order_not_found', 'no such order');
    if (order.status === 'complete') {
      const existing = stmts.getProofByOrder.get(order.id);
      return res.json({
        proof: {
          id: existing.id,
          bundleHash: existing.bundle_hash,
          proofUrl: `/proof/${existing.id}`,
          createdAt: existing.created_at,
        },
        alreadyComplete: true,
      });
    }
    const evidenceRows = stmts.listEvidence.all(order.id);
    if (evidenceRows.length === 0) {
      return err(res, 409, 'no_evidence', 'cannot complete an order with no evidence');
    }

    const evidence = evidenceRows.map((e) => ({
      id: e.id,
      notes: e.notes,
      gps: e.gps_lat !== null ? { lat: e.gps_lat, lng: e.gps_lng } : null,
      capturedAt: e.captured_at,
      inspectorId: e.inspector_id,
      photos: stmts.listPhotosByEvidence.all(e.id).map((p) => ({
        filename: p.filename,
        sha256: p.sha256,
        sizeBytes: p.size_bytes,
        mimeType: p.mime_type,
      })),
    }));

    const inspectorId = (req.body && req.body.inspectorId) || evidence[evidence.length - 1].inspectorId;
    const timestamp = new Date().toISOString();
    let bundle;
    try {
      bundle = attestation.createProofBundle({
        orderId: order.id,
        inspectorId,
        timestamp,
        evidence,
        keypair,
      });
    } catch (e) {
      return err(res, 500, 'attestation_failed', 'failed to create proof bundle: ' + e.message);
    }

    const proofId = randomUUID();
    stmts.insertProof.run(proofId, order.id, JSON.stringify(bundle), bundle.bundleHash, bundle.signature, timestamp);
    stmts.setOrderStatus.run('complete', order.id);
    return res.status(201).json({
      proof: {
        id: proofId,
        bundleHash: bundle.bundleHash,
        signature: bundle.signature,
        proofUrl: `/proof/${proofId}`,
        createdAt: timestamp,
      },
    });
  });

  function loadProof(req, res) {
    const row = stmts.getProof.get(req.params.id);
    if (!row) {
      err(res, 404, 'proof_not_found', 'no such proof');
      return null;
    }
    return row;
  }

  // Public, shareable proof bundle.
  router.get('/proof/:id', (req, res) => {
    const row = loadProof(req, res);
    if (!row) return;
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.json(JSON.parse(row.bundle_json));
  });

  // Attested photo bytes referenced by the bundle (verify via sha256).
  router.get('/proof/:id/photo/:filename', (req, res) => {
    const row = loadProof(req, res);
    if (!row) return;
    const photo = stmts.getPhoto.get(row.order_id, req.params.filename);
    if (!photo) return err(res, 404, 'photo_not_found', 'no such photo in this proof');
    if (!photo.stored_path.startsWith(photoDir + path.sep)) {
      return err(res, 500, 'photo_path_invalid', 'stored photo path failed safety check');
    }
    res.set('X-Photo-SHA256', photo.sha256);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(photo.mime_type || 'application/octet-stream');
    fs.createReadStream(photo.stored_path).pipe(res);
  });

  return router;
}

module.exports = { buildRouter };
