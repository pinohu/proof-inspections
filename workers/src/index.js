/**
 * proof-inspections — Cloudflare Workers entrypoint (KV-backed).
 *
 * Public API:
 *   GET  /health
 *   GET  /.well-known/proof-inspections-key
 *   POST /orders
 *   GET  /orders/:id
 *   POST /orders/:id/evidence   (multipart/form-data)
 *   POST /orders/:id/complete
 *   GET  /proof/:id             (public signed bundle, shareable)
 *   GET  /proof/:id/photo/:filename
 *   POST /orders/:id/payment-intent  (Stripe PaymentIntent -> clientSecret)
 *   POST /webhooks/stripe            (Stripe event webhook, signature-verified)
 *
 * Passwordless auth (PA CROP style — email + 6-char code):
 *   POST /auth/request-code
 *   POST /auth/verify-code
 *   POST /auth/logout
 *
 * Customer portal (role: customer):
 *   GET  /portal/orders
 *   GET  /portal/orders/:id
 *
 * Contractor (role: contractor):
 *   GET  /contractor/jobs
 *   GET  /contractor/:id/jobs        (legacy alias — old app versions)
 *
 * Admin (role: admin, ADMIN_EMAILS env):
 *   GET  /admin/overview
 *   GET  /admin/orders
 *   POST /admin/orders/:id/dispatch
 *   GET  /admin/contractors
 *   POST /admin/contractors
 *   PATCH /admin/contractors/:id
 *   GET  /admin/email-log
 *
 * Static frontend:
 *   /              -> public/index.html
 *   /track, /track/* -> public/track.html
 *   /portal        -> public/portal.html
 *   /admin         -> public/admin.html
 *   /contractor/*  -> contractor PWA files
 *
 * Deploy inlines public/ into the bundle (see tools/deploy.mjs); in wrangler
 * dev the [assets] binding serves them. Storage is KV (orders, evidence,
 * photos, proofs, payments, auth, email log).
 */

import {
  sha256Hex,
  importPrivateKey,
  publicKeyFromPrivate,
  createProofBundle,
} from './attestation.js';
import { parseMultipart, boundaryFromContentType } from './multipart.js';
import {
  createPaymentIntent,
  handleStripeWebhook,
  applyPaymentEvent,
} from './stripe.js';
import {
  handleRequestCode,
  handleVerifyCode,
  handleLogout,
  requireAuth,
} from './auth.js';
import {
  sendEmail,
  sendOrderConfirmation,
  sendInspectorDispatched,
  sendReportReady,
  sendContractorAssignment,
  recentEmails,
} from './email.js';

const VERSION = '0.2.0';
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_PRICE_CENTS = 19900;

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
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* KV data access                                                     */
/* ------------------------------------------------------------------ */

async function getOrder(kv, id) {
  return (await kv.get(`order:${id}`, 'json')) || null;
}

async function putOrder(kv, order) {
  await kv.put(`order:${order.id}`, JSON.stringify(order));
}

async function listEvidence(kv, orderId) {
  const ids = (await kv.get(`order-evidence:${orderId}`, 'json')) || [];
  const out = [];
  for (const id of ids) {
    const ev = await kv.get(`evidence:${id}`, 'json');
    if (ev) out.push(ev);
  }
  return out;
}

async function addEvidence(kv, orderId, evidence) {
  await kv.put(`evidence:${evidence.id}`, JSON.stringify(evidence));
  const ids = (await kv.get(`order-evidence:${orderId}`, 'json')) || [];
  ids.push(evidence.id);
  await kv.put(`order-evidence:${orderId}`, JSON.stringify(ids));
}

async function putPhoto(kv, orderId, filename, bytes, mimeType) {
  await kv.put(`photo:${orderId}:${filename}`, bytes, {
    metadata: { contentType: mimeType },
  });
}

async function getPhoto(kv, orderId, filename) {
  const obj = await kv.getWithMetadata(`photo:${orderId}:${filename}`, 'arrayBuffer');
  if (!obj || !obj.value) return null;
  return {
    bytes: obj.value,
    mimeType: (obj.metadata && obj.metadata.contentType) || 'application/octet-stream',
  };
}

async function putProof(kv, proofId, orderId, bundle) {
  await kv.put(`proof:${proofId}`, JSON.stringify({ bundle, orderId }));
  await kv.put(`order-proof:${orderId}`, proofId);
}

async function getProof(kv, proofId) {
  return (await kv.get(`proof:${proofId}`, 'json')) || null;
}

async function getProofForOrder(kv, orderId) {
  const proofId = await kv.get(`order-proof:${orderId}`, 'text');
  if (!proofId) return null;
  const p = await getProof(kv, proofId);
  return p ? { id: proofId, ...p } : null;
}

/** Stripe payment store adapter on KV (matches stripe.js store interface). */
function kvPaymentStore(kv) {
  return {
    async getOrderPayment(orderId) {
      return (await kv.get(`pay:order:${orderId}`, 'json')) || null;
    },
    async setOrderPayment(orderId, payment) {
      const existing = (await kv.get(`pay:order:${orderId}`, 'json')) || {};
      const merged = {
        status: payment.status,
        intentId: payment.intentId !== undefined ? payment.intentId : existing.intentId || null,
        amountCents: payment.amountCents !== undefined ? payment.amountCents : existing.amountCents || null,
        currency: payment.currency || existing.currency || 'usd',
        paidAt: payment.paidAt !== undefined ? payment.paidAt : existing.paidAt || null,
      };
      await kv.put(`pay:order:${orderId}`, JSON.stringify(merged));
    },
    async markEventProcessed(eventId) {
      const key = `pay:event:${eventId}`;
      if (await kv.get(key, 'text')) return false;
      await kv.put(key, '1', { expirationTtl: 86400 });
      return true;
    },
  };
}

/** Order timeline events (best effort — never fails the request). */
async function logOrderEvent(kv, orderId, event, detail = null) {
  try {
    const key = `events:${orderId}`;
    const events = (await kv.get(key, 'json')) || [];
    events.push({ event, detail, createdAt: new Date().toISOString() });
    await kv.put(key, JSON.stringify(events.slice(-100)));
  } catch { /* timeline is optional */ }
}

async function getOrderEvents(kv, orderId) {
  return (await kv.get(`events:${orderId}`, 'json')) || [];
}

function orderToJson(order) {
  return {
    id: order.id,
    propertyAddress: order.propertyAddress,
    inspectionType: order.inspectionType,
    customerEmail: order.customerEmail,
    customerName: order.customerName,
    status: order.status,
    contractorId: order.contractorId || null,
    contractorName: order.contractorName || null,
    createdAt: order.createdAt,
  };
}

function evidenceToJson(ev) {
  return {
    id: ev.id,
    notes: ev.notes,
    gps: ev.gps,
    capturedAt: ev.capturedAt,
    inspectorId: ev.inspectorId,
    createdAt: ev.createdAt,
    photos: (ev.photos || []).map((p) => ({
      filename: p.filename,
      originalFilename: p.originalFilename,
      sha256: p.sha256,
      sizeBytes: p.sizeBytes,
      mimeType: p.mimeType,
    })),
  };
}

/** Evidence rows in the canonical bundle shape (no originalFilename/createdAt). */
function evidenceToBundle(ev) {
  return {
    id: ev.id,
    notes: ev.notes,
    gps: ev.gps,
    capturedAt: ev.capturedAt,
    inspectorId: ev.inspectorId,
    photos: (ev.photos || []).map((p) => ({
      filename: p.filename,
      sha256: p.sha256,
      sizeBytes: p.sizeBytes,
      mimeType: p.mimeType,
    })),
  };
}

function paymentToJson(payment) {
  if (!payment) return { status: 'unpaid' };
  return {
    status: payment.status,
    amountCents: payment.amountCents,
    currency: payment.currency,
    paidAt: payment.paidAt,
  };
}

async function orderWithContractor(kv, order) {
  if (order && order.contractorId) {
    const c = await kv.get(`contractor:${order.contractorId}`, 'json');
    if (c) return { ...order, contractorName: c.name };
  }
  return order;
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
/* route handlers — public API                                        */
/* ------------------------------------------------------------------ */

async function handleCreateOrder(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return errJson(400, 'invalid_json', 'request body must be JSON'); }
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
  const order = {
    id,
    propertyAddress: propertyAddress.trim(),
    inspectionType: inspectionType.trim(),
    customerEmail: String(customerEmail).trim().toLowerCase(),
    customerName: customerName.trim(),
    status: 'pending',
    contractorId: contractorId || null,
    createdAt: now,
  };
  await putOrder(env.KV, order);
  // Lifecycle: timeline event + confirmation email (fire-and-forget).
  logOrderEvent(env.KV, id, 'created', 'Order placed online');
  sendOrderConfirmation(env, order).catch((e) =>
    console.error('[lifecycle] order confirmation failed:', e.message));
  return Response.json({ order: orderToJson(order) }, { status: 201 });
}

async function handleGetOrder(_request, env, orderId) {
  const order = await getOrder(env.KV, orderId);
  if (!order) return errJson(404, 'order_not_found', 'no such order');
  const evidenceRows = await listEvidence(env.KV, order.id);
  const evidence = evidenceRows.map(evidenceToJson);
  const proofRec = await getProofForOrder(env.KV, order.id);
  const proof = proofRec
    ? { id: proofRec.id, bundleHash: proofRec.bundle.bundleHash, proofUrl: `/proof/${proofRec.id}`, createdAt: proofRec.bundle.timestamp }
    : null;
  const store = kvPaymentStore(env.KV);
  const payment = await store.getOrderPayment(order.id).catch(() => null);
  return Response.json({ order: orderToJson(await orderWithContractor(env.KV, order)), evidence, proof, payment: paymentToJson(payment) });
}

async function handleSubmitEvidence(request, env, orderId) {
  const order = await getOrder(env.KV, orderId);
  if (!order) return errJson(404, 'order_not_found', 'no such order');
  if (order.status === 'complete') {
    return errJson(409, 'order_complete', 'cannot add evidence to a completed order');
  }
  const boundary = boundaryFromContentType(request.headers.get('content-type'));
  if (!boundary) return errJson(400, 'invalid_content_type', 'expected multipart/form-data');

  let raw;
  try { raw = new Uint8Array(await request.arrayBuffer()); }
  catch (e) { return errJson(400, 'invalid_multipart', 'could not read request body: ' + e.message); }
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

  // Accept both the documented names (gpsLat/gpsLng) and the contractor
  // PWA's shorthand (lat/lng) — field-name mismatches must never lose evidence.
  let gps = null;
  const latRaw = field('gpsLat') !== undefined ? field('gpsLat') : field('lat');
  const lngRaw = field('gpsLng') !== undefined ? field('gpsLng') : field('lng');
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

  // Accept both "photos" (documented) and "photos[]" (FormData convention).
  const photos = parts.files.filter((f) => f.fieldname === 'photos' || f.fieldname === 'photos[]');
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

  const savedPhotos = [];
  for (const p of photos) {
    const filename = `${crypto.randomUUID()}-${sanitizeFilename(p.filename)}`;
    await putPhoto(env.KV, order.id, filename, p.data, p.mimeType);
    savedPhotos.push({
      filename,
      originalFilename: p.filename,
      sha256: p.digest,
      sizeBytes: p.data.length,
      mimeType: p.mimeType,
    });
  }

  const evidence = {
    id: evidenceId,
    notes: field('notes') ?? null,
    gps,
    capturedAt,
    inspectorId,
    createdAt: now,
    photos: savedPhotos,
  };
  await addEvidence(env.KV, order.id, evidence);

  if (order.status === 'pending' || order.status === 'dispatched') {
    order.status = 'in_progress';
    await putOrder(env.KV, order);
  }
  logOrderEvent(env.KV, order.id, 'evidence_received', `${savedPhotos.length} photo(s) from ${inspectorId}`);

  return Response.json({ evidence: evidenceToJson(evidence) }, { status: 201 });
}

async function handleCompleteOrder(request, env, orderId) {
  const order = await getOrder(env.KV, orderId);
  if (!order) return errJson(404, 'order_not_found', 'no such order');
  if (order.status === 'complete') {
    const existing = await getProofForOrder(env.KV, order.id);
    return Response.json({
      proof: {
        id: existing.id,
        bundleHash: existing.bundle.bundleHash,
        proofUrl: `/proof/${existing.id}`,
        createdAt: existing.bundle.timestamp,
      },
      alreadyComplete: true,
    });
  }
  const evidenceRows = await listEvidence(env.KV, order.id);
  if (evidenceRows.length === 0) {
    return errJson(409, 'no_evidence', 'cannot complete an order with no evidence');
  }
  const evidence = evidenceRows.map(evidenceToBundle);

  let bodyInspectorId = null;
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      const body = await request.json();
      bodyInspectorId = body && body.inspectorId ? String(body.inspectorId) : null;
    } catch { /* fall back below */ }
  }
  const inspectorId = bodyInspectorId || evidence[evidence.length - 1].inspectorId;
  const timestamp = new Date().toISOString();

  let signing;
  try { signing = await getSigning(env); }
  catch (e) { return errJson(e.statusCode || 500, e.code || 'signing_failed', e.message); }

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
  await putProof(env.KV, proofId, order.id, bundle);
  order.status = 'complete';
  await putOrder(env.KV, order);

  // Lifecycle: timeline event + report-ready email (fire-and-forget).
  logOrderEvent(env.KV, order.id, 'completed', 'Proof bundle sealed');
  sendReportReady(env, order, { bundleHash: bundle.bundleHash }).catch((e) =>
    console.error('[lifecycle] report-ready email failed:', e.message));

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
  const rec = await getProof(env.KV, proofId);
  if (!rec) return errJson(404, 'proof_not_found', 'no such proof');
  return Response.json(rec.bundle, {
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}

async function handleGetProofPhoto(_request, env, proofId, filename) {
  if (filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
    return errJson(400, 'invalid_filename', 'filename is not valid');
  }
  const rec = await getProof(env.KV, proofId);
  if (!rec) return errJson(404, 'proof_not_found', 'no such proof');
  const photo = await getPhoto(env.KV, rec.orderId, filename);
  if (!photo) return errJson(404, 'photo_not_found', 'no such photo in this proof');
  // Verify the photo is actually part of this proof's evidence.
  const listed = (rec.bundle.evidence || []).some((ev) =>
    (ev.photos || []).some((p) => p.filename === filename));
  if (!listed) return errJson(404, 'photo_not_found', 'no such photo in this proof');
  return new Response(photo.bytes, {
    headers: {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': photo.mimeType,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Stripe payments                                                    */
/* ------------------------------------------------------------------ */

async function handleCreatePaymentIntent(_request, env, orderId) {
  const order = await getOrder(env.KV, orderId);
  if (!order) return errJson(404, 'order_not_found', 'no such order');
  const store = kvPaymentStore(env.KV);
  try {
    const result = await createPaymentIntent(env, store, {
      id: order.id,
      customerEmail: order.customerEmail,
    });
    return Response.json(result, { status: 200 });
  } catch (e) {
    return errJson(e.statusCode || 500, e.code || 'stripe_error', e.message);
  }
}

async function handleWebhook(request, env) {
  const store = kvPaymentStore(env.KV);
  const res = await handleStripeWebhook(env, request, store);
  try {
    const body = await res.clone().json().catch(() => ({}));
    if (body && body.action === 'marked_paid' && body.orderId) {
      logOrderEvent(env.KV, body.orderId, 'paid', 'Payment confirmed via Stripe');
    }
  } catch { /* never fail the webhook on lifecycle logging */ }
  return res;
}

/* ------------------------------------------------------------------ */
/* customer portal (role: customer)                                   */
/* ------------------------------------------------------------------ */

async function handlePortalOrders(request, env) {
  const { session, error } = await requireAuth(request, env, ['customer']);
  if (error) return error;
  // KV has no secondary indexes — scan orders. Fine at this scale; the
  // index is maintained lazily below for larger volumes.
  const ids = await allOrderIds(env.KV);
  const store = kvPaymentStore(env.KV);
  const orders = [];
  for (const id of ids) {
    const o = await getOrder(env.KV, id);
    if (o && o.customerEmail === session.email) {
      const payment = await store.getOrderPayment(o.id).catch(() => null);
      orders.push({
        ...orderToJson(await orderWithContractor(env.KV, o)),
        paid: !!payment && payment.status === 'paid',
        amountCents: (payment && payment.amountCents) || DEFAULT_PRICE_CENTS,
      });
    }
  }
  orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return Response.json({ orders });
}

async function handlePortalOrderDetail(request, env, orderId) {
  const { session, error } = await requireAuth(request, env, ['customer']);
  if (error) return error;
  const order = await getOrder(env.KV, orderId);
  if (!order || order.customerEmail !== session.email) {
    return errJson(404, 'order_not_found', 'no such order');
  }
  const evidenceRows = await listEvidence(env.KV, order.id);
  const evidence = evidenceRows.map((ev) => ({
    ...evidenceToJson(ev),
    photos: ev.photos.map((p) => ({
      filename: p.filename, sha256: p.sha256, sizeBytes: p.sizeBytes, mimeType: p.mimeType,
    })),
  }));
  const proofRec = await getProofForOrder(env.KV, order.id);
  const proof = proofRec
    ? { id: proofRec.id, bundleHash: proofRec.bundle.bundleHash, proofUrl: `/proof/${proofRec.id}`, createdAt: proofRec.bundle.timestamp }
    : null;
  const payment = paymentToJson(await kvPaymentStore(env.KV).getOrderPayment(order.id).catch(() => null));
  const timeline = await getOrderEvents(env.KV, order.id);
  return Response.json({
    order: {
      ...orderToJson(await orderWithContractor(env.KV, order)),
      paid: payment.status === 'paid',
      amountCents: payment.amountCents || DEFAULT_PRICE_CENTS,
    },
    evidence,
    proof,
    payment,
    timeline,
  });
}

/** Maintain the orders index (append-only — no read-modify-write race). */
async function indexOrder(kv, id) {
  try {
    await kv.put(`order:idx:${new Date().toISOString()}:${id}`, id);
  } catch { /* index is optional */ }
}

async function allOrderIds(kv) {
  try {
    const listed = await kv.list({ prefix: 'order:idx:' });
    const ids = [];
    const seen = new Set();
    for (const k of (listed.keys || []).map((x) => x.name).sort()) {
      const id = k.split(':').pop();
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
  } catch { return []; }
}

async function allContractorIds(kv) {
  try {
    const listed = await kv.list({ prefix: 'contractor:idx:' });
    const ids = [];
    const seen = new Set();
    for (const k of (listed.keys || []).map((x) => x.name).sort()) {
      const id = k.split(':').pop();
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
  } catch { return []; }
}

/* ------------------------------------------------------------------ */
/* contractor (role: contractor)                                      */
/* ------------------------------------------------------------------ */

function jobToJson(order) {
  return {
    id: order.id,
    address: order.propertyAddress,
    propertyAddress: order.propertyAddress,
    type: order.inspectionType,
    inspectionType: order.inspectionType,
    notes: null,
    customerNotes: null,
    customerName: order.customerName,
    status: order.status,
    scheduledAt: order.createdAt,
  };
}

async function jobsForContractor(kv, contractorId) {
  const ids = await allOrderIds(kv);
  const jobs = [];
  for (const id of ids) {
    const o = await getOrder(kv, id);
    if (o && o.contractorId === contractorId && ['pending', 'dispatched', 'in_progress'].includes(o.status)) {
      jobs.push(jobToJson(o));
    }
  }
  jobs.sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1));
  return jobs;
}

/** GET /contractor/jobs — jobs for the signed-in contractor. */
async function handleContractorJobs(request, env) {
  const { session, error } = await requireAuth(request, env, ['contractor']);
  if (error) return error;
  return Response.json({ jobs: await jobsForContractor(env.KV, session.contractorId) });
}

/**
 * GET /contractor/:id/jobs — legacy alias for old app versions that sign in
 * with a raw contractor ID code. The ID itself is the credential (same as
 * the original PWA behavior).
 */
async function handleLegacyContractorJobs(_request, env, contractorId) {
  return Response.json({ jobs: await jobsForContractor(env.KV, contractorId) });
}

/* ------------------------------------------------------------------ */
/* admin (role: admin)                                                */
/* ------------------------------------------------------------------ */

async function allOrders(kv) {
  const ids = await allOrderIds(kv);
  const out = [];
  for (const id of ids) {
    const o = await getOrder(kv, id);
    if (o) out.push(o);
  }
  return out;
}

async function handleAdminOverview(request, env) {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;
  const orders = await allOrders(env.KV);
  const byStatus = { pending: 0, dispatched: 0, in_progress: 0, complete: 0 };
  for (const o of orders) {
    if (byStatus[o.status] !== undefined) byStatus[o.status]++;
    else byStatus[o.status] = 1;
  }
  const store = kvPaymentStore(env.KV);
  let revenueCents = 0;
  let paidOrders = 0;
  for (const o of orders) {
    const p = await store.getOrderPayment(o.id).catch(() => null);
    if (p && p.status === 'paid') {
      paidOrders++;
      revenueCents += p.amountCents || 0;
    }
  }
  const recent = [...orders]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 10);
  const recentOrders = [];
  for (const o of recent) {
    const p = await store.getOrderPayment(o.id).catch(() => null);
    recentOrders.push({
      ...orderToJson(await orderWithContractor(env.KV, o)),
      paid: !!p && p.status === 'paid',
      amountCents: (p && p.amountCents) || DEFAULT_PRICE_CENTS,
    });
  }
  const contractorIds = await allContractorIds(env.KV);
  const contractorStats = [];
  for (const cid of contractorIds) {
    const c = await env.KV.get(`contractor:${cid}`, 'json');
    if (!c || !c.active) continue;
    const assigned = orders.filter((o) => o.contractorId === cid).length;
    const completed = orders.filter((o) => o.contractorId === cid && o.status === 'complete').length;
    contractorStats.push({ contractorId: cid, name: c.name, assigned, completed });
  }
  return Response.json({
    totals: { orders: orders.length, revenueCents, paidOrders, byStatus },
    recentOrders,
    contractorStats,
  });
}

async function handleAdminOrders(request, env) {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 25, 1), 100);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  let orders = await allOrders(env.KV);
  if (status) orders = orders.filter((o) => o.status === status);
  if (q) {
    orders = orders.filter((o) =>
      (o.propertyAddress || '').toLowerCase().includes(q) ||
      (o.customerEmail || '').toLowerCase().includes(q) ||
      (o.customerName || '').toLowerCase().includes(q) ||
      (o.id || '').toLowerCase().includes(q));
  }
  orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const total = orders.length;
  const page = orders.slice(offset, offset + limit);
  const store = kvPaymentStore(env.KV);
  const out = [];
  for (const o of page) {
    const p = await store.getOrderPayment(o.id).catch(() => null);
    out.push({
      ...orderToJson(await orderWithContractor(env.KV, o)),
      paid: !!p && p.status === 'paid',
      amountCents: (p && p.amountCents) || DEFAULT_PRICE_CENTS,
    });
  }
  return Response.json({ orders: out, total, limit, offset });
}

/** POST /admin/orders/:id/dispatch { contractor_id } — assign + notify. */
async function handleAdminDispatch(request, env, orderId) {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;
  let body;
  try { body = await request.json(); }
  catch { return errJson(400, 'invalid_json', 'request body must be JSON'); }
  const contractorId = String(body.contractor_id || '').trim();
  if (!contractorId) return errJson(400, 'invalid_contractor', 'contractor_id is required');

  const order = await getOrder(env.KV, orderId);
  if (!order) return errJson(404, 'order_not_found', 'no such order');
  if (order.status === 'complete') return errJson(409, 'order_complete', 'cannot dispatch a completed order');
  const contractor = await env.KV.get(`contractor:${contractorId}`, 'json');
  if (!contractor || !contractor.active) return errJson(404, 'contractor_not_found', 'no such active contractor');

  order.status = 'dispatched';
  order.contractorId = contractorId;
  await putOrder(env.KV, order);
  await indexOrder(env.KV, orderId);

  logOrderEvent(env.KV, orderId, 'dispatched', `Assigned to ${contractor.name}`);
  const enriched = await orderWithContractor(env.KV, order);
  sendInspectorDispatched(env, enriched, contractor).catch((e) =>
    console.error('[lifecycle] dispatch email failed:', e.message));
  sendContractorAssignment(env, contractor, enriched).catch((e) =>
    console.error('[lifecycle] contractor email failed:', e.message));

  return Response.json({ order: orderToJson(enriched) });
}

async function handleAdminContractors(request, env) {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;
  const ids = await allContractorIds(env.KV);
  const contractors = [];
  for (const id of ids) {
    const c = await env.KV.get(`contractor:${id}`, 'json');
    if (c) contractors.push({ id: c.id, name: c.name, email: c.email, phone: c.phone || null, active: !!c.active, createdAt: c.createdAt });
  }
  contractors.sort((a, b) => a.name.localeCompare(b.name));
  return Response.json({ contractors });
}

async function handleAdminCreateContractor(request, env) {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;
  let body;
  try { body = await request.json(); }
  catch { return errJson(400, 'invalid_json', 'request body must be JSON'); }
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim() || null;
  if (!name) return errJson(400, 'invalid_name', 'contractor name is required');
  if (!EMAIL_RE.test(email)) return errJson(400, 'invalid_email', 'a valid email is required');

  if (await env.KV.get(`contractor:email:${email}`, 'text')) {
    return errJson(409, 'contractor_exists', 'a contractor with that email already exists');
  }

  // Human-friendly ID: initials + sequence (e.g. LM-001).
  const initials = name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'CT';
  let id = null;
  for (let i = 1; i <= 999; i++) {
    const candidate = `${initials}-${String(i).padStart(3, '0')}`;
    if (!(await env.KV.get(`contractor:${candidate}`, 'json'))) { id = candidate; break; }
  }
  if (!id) id = crypto.randomUUID();

  const now = new Date().toISOString();
  const contractor = { id, name, email, phone, active: true, createdAt: now };
  await env.KV.put(`contractor:${id}`, JSON.stringify(contractor));
  await env.KV.put(`contractor:email:${email}`, id);
  await env.KV.put(`contractor:idx:${now}:${id}`, id);

  return Response.json({ contractor: { ...contractor, active: true } }, { status: 201 });
}

async function handleAdminUpdateContractor(request, env, contractorId) {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;
  let body;
  try { body = await request.json(); }
  catch { return errJson(400, 'invalid_json', 'request body must be JSON'); }
  const c = await env.KV.get(`contractor:${contractorId}`, 'json');
  if (!c) return errJson(404, 'contractor_not_found', 'no such contractor');
  if (typeof body.active === 'boolean') c.active = body.active;
  if (typeof body.name === 'string' && body.name.trim()) c.name = body.name.trim();
  if (typeof body.phone === 'string') c.phone = body.phone.trim() || null;
  await env.KV.put(`contractor:${contractorId}`, JSON.stringify(c));
  return Response.json({
    contractor: { id: c.id, name: c.name, email: c.email, phone: c.phone || null, active: !!c.active, createdAt: c.createdAt },
  });
}

async function handleAdminEmailLog(request, env) {
  const { error } = await requireAuth(request, env, ['admin']);
  if (error) return error;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const emails = await recentEmails(env.KV, limit);
  return Response.json({
    emails: emails.map((e) => ({
      id: e.id, toEmail: e.toEmail, template: e.template, subject: e.subject,
      status: e.status, provider: e.provider || null, error: e.error || null,
      orderId: e.orderId || null, createdAt: e.createdAt, sentAt: e.sentAt || null,
    })),
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
        try {
          const signing = await getSigning(env);
          return new Response(signing.publicKeyPem, { headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {
          return errJson(e.statusCode || 500, e.code || 'signing_failed', e.message);
        }
      }

      if (method === 'POST' && path === '/orders') {
        // Index new orders for portal/admin scans (fire-and-forget).
        const res = await handleCreateOrder(request, env);
        try {
          const body = await res.clone().json().catch(() => null);
          if (body && body.order && body.order.id) indexOrder(env.KV, body.order.id);
        } catch { /* index is optional */ }
        return res;
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

      m = path.match(/^\/orders\/([^/]+)\/payment-intent$/);
      if (m) {
        if (method === 'POST') return handleCreatePaymentIntent(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      if (method === 'POST' && path === '/webhooks/stripe') {
        return handleWebhook(request, env);
      }

      // --- passwordless auth ---
      if (method === 'POST' && path === '/auth/request-code') {
        return handleRequestCode(request, env);
      }
      if (method === 'POST' && path === '/auth/verify-code') {
        return handleVerifyCode(request, env);
      }
      if (method === 'POST' && path === '/auth/logout') {
        return handleLogout(request, env);
      }

      // --- customer portal ---
      if (method === 'GET' && path === '/portal/orders') {
        return handlePortalOrders(request, env);
      }
      m = path.match(/^\/portal\/orders\/([^/]+)$/);
      if (m) {
        if (method === 'GET') return handlePortalOrderDetail(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      // --- contractor ---
      if (method === 'GET' && path === '/contractor/jobs') {
        return handleContractorJobs(request, env);
      }
      m = path.match(/^\/contractor\/([^/]+)\/jobs$/);
      if (m) {
        if (method === 'GET') return handleLegacyContractorJobs(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }

      // --- admin ---
      if (method === 'GET' && path === '/admin/overview') {
        return handleAdminOverview(request, env);
      }
      if (method === 'GET' && path === '/admin/orders') {
        return handleAdminOrders(request, env);
      }
      m = path.match(/^\/admin\/orders\/([^/]+)\/dispatch$/);
      if (m) {
        if (method === 'POST') return handleAdminDispatch(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }
      if (method === 'GET' && path === '/admin/contractors') {
        return handleAdminContractors(request, env);
      }
      if (method === 'POST' && path === '/admin/contractors') {
        return handleAdminCreateContractor(request, env);
      }
      m = path.match(/^\/admin\/contractors\/([^/]+)$/);
      if (m) {
        if (method === 'PATCH') return handleAdminUpdateContractor(request, env, decodeURIComponent(m[1]));
        return errJson(405, 'method_not_allowed', 'method not allowed');
      }
      if (method === 'GET' && path === '/admin/email-log') {
        return handleAdminEmailLog(request, env);
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

      // Static frontend (wrangler dev serves via [assets]; production bundle
      // inlines them — see tools/deploy.mjs).
      if (path === '/track' || path.startsWith('/track/')) {
        return env.ASSETS.fetch(new Request(new URL('/track.html', url), request));
      }
      if (path === '/portal' || path.startsWith('/portal/')) {
        return env.ASSETS.fetch(new Request(new URL('/portal.html', url), request));
      }
      if (path === '/admin' || path.startsWith('/admin/')) {
        return env.ASSETS.fetch(new Request(new URL('/admin.html', url), request));
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
