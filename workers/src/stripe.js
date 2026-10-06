/**
 * stripe.js — Stripe payments for proof-inspections (Cloudflare Workers).
 *
 * Dependency-free: talks to the Stripe REST API with fetch(), verifies
 * webhook signatures with Web Crypto (HMAC-SHA256). No stripe npm SDK
 * (the Node SDK does not run in Workers).
 *
 * Storage is injected via a `store` adapter so this module works with any
 * backend (D1, KV, SQLite). The adapter interface:
 *
 *   store.getOrderPayment(orderId)
 *     -> { status, intentId, amountCents, currency, paidAt } | null
 *        status: 'unpaid' | 'requires_payment' | 'paid' | 'failed'
 *   store.setOrderPayment(orderId, payment) -> void
 *   store.markEventProcessed(eventId) -> bool  (true on first sighting)
 *
 * Secrets (Worker secrets, never committed):
 *   STRIPE_SECRET_KEY      — sk_live_... (or sk_test_... for testing)
 *   STRIPE_WEBHOOK_SECRET  — whsec_... from the webhook endpoint config
 *
 * Optional env:
 *   INSPECTION_PRICE_CENTS — default 19900 ($199.00)
 *   INSPECTION_CURRENCY    — default 'usd'
 */

const STRIPE_API = 'https://api.stripe.com/v1';
const WEBHOOK_TOLERANCE_SEC = 300; // 5 minutes, per Stripe docs

function errJson(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

/* ------------------------------------------------------------------ */
/* PaymentIntent creation (server -> Stripe)                          */
/* ------------------------------------------------------------------ */

/**
 * Create (or reuse) a PaymentIntent for an order.
 * Idempotent: if the order already has an incomplete intent, it is reused.
 */
export async function createPaymentIntent(env, store, order) {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw Object.assign(
      new Error('STRIPE_SECRET_KEY is not configured'),
      { statusCode: 500, code: 'stripe_not_configured' },
    );
  }
  const amountCents = Number(env.INSPECTION_PRICE_CENTS || 19900);
  const currency = String(env.INSPECTION_CURRENCY || 'usd').toLowerCase();

  const existing = await store.getOrderPayment(order.id);
  if (existing && existing.status === 'paid') {
    return { reused: true, alreadyPaid: true, intentId: existing.intentId };
  }
  if (existing && existing.status === 'requires_payment' && existing.intentId) {
    // Re-fetch from Stripe to get a fresh client_secret.
    const intent = await stripeRetrieve(secretKey, existing.intentId);
    return { reused: true, intentId: intent.id, clientSecret: intent.client_secret };
  }

  const params = new URLSearchParams();
  params.set('amount', String(amountCents));
  params.set('currency', currency);
  params.set('automatic_payment_methods[enabled]', 'true');
  params.set('automatic_payment_methods[allow_redirects]', 'never');
  params.set('metadata[orderId]', order.id);
  params.set('metadata[business]', 'proof-inspections');
  params.set('description', `Property inspection ${order.id}`);
  if (order.customerEmail) params.set('receipt_email', order.customerEmail);

  const res = await fetch(`${STRIPE_API}/payment_intents`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(secretKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `order-${order.id}-pi`,
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Stripe PaymentIntent creation failed (${res.status}): ${text.slice(0, 200)}`),
      { statusCode: 502, code: 'stripe_api_error' },
    );
  }
  const intent = await res.json();
  await store.setOrderPayment(order.id, {
    status: 'requires_payment',
    intentId: intent.id,
    amountCents,
    currency,
    paidAt: null,
  });
  return { intentId: intent.id, clientSecret: intent.client_secret, amountCents, currency };
}

async function stripeRetrieve(secretKey, intentId) {
  const res = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(intentId)}`, {
    headers: { Authorization: 'Basic ' + btoa(secretKey + ':') },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Stripe retrieve failed (${res.status})`), { statusCode: 502, code: 'stripe_api_error' });
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Webhook signature verification (Web Crypto HMAC-SHA256)            */
/* ------------------------------------------------------------------ */

/**
 * Verify the Stripe-Signature header against the raw request body.
 * Returns the parsed event on success; throws {statusCode:400} on failure.
 *
 * Stripe signs:  HMAC_SHA256(webhookSecret, `${timestamp}.${rawBody}`)
 * Header format: t=<timestamp>,v1=<hexsig>[,v0=<oldhexsig>...]
 */
export async function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader) {
    throw Object.assign(new Error('missing stripe-signature header'), { statusCode: 400, code: 'webhook_bad_signature' });
  }
  const parts = {};
  for (const seg of String(signatureHeader).split(',')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  const timestamp = Number(parts.t);
  const v1s = String(signatureHeader)
    .split(',')
    .filter((s) => s.trim().startsWith('v1='))
    .map((s) => s.trim().slice(3));
  if (!Number.isFinite(timestamp) || v1s.length === 0) {
    throw Object.assign(new Error('malformed stripe-signature header'), { statusCode: 400, code: 'webhook_bad_signature' });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > WEBHOOK_TOLERANCE_SEC) {
    throw Object.assign(new Error('webhook timestamp outside tolerance'), { statusCode: 400, code: 'webhook_stale' });
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expectedHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

  let ok = false;
  for (const v1 of v1s) {
    if (timingSafeEqualHex(expectedHex, v1)) { ok = true; break; }
  }
  if (!ok) {
    throw Object.assign(new Error('webhook signature verification failed'), { statusCode: 400, code: 'webhook_bad_signature' });
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw Object.assign(new Error('webhook body is not valid JSON'), { statusCode: 400, code: 'webhook_bad_body' });
  }
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Webhook event application (idempotent)                             */
/* ------------------------------------------------------------------ */

/**
 * Apply a verified Stripe event. Idempotent via store.markEventProcessed.
 * Returns { ok, action }.
 */
export async function applyPaymentEvent(store, event) {
  if (!event || !event.id || !event.type) {
    return { ok: true, action: 'ignored_malformed' };
  }
  const firstSeen = await store.markEventProcessed(event.id);
  if (!firstSeen) return { ok: true, action: 'duplicate_ignored' };

  const obj = (event.data && event.data.object) || {};
  const orderId = (obj.metadata && obj.metadata.orderId) || null;

  if (event.type === 'payment_intent.succeeded') {
    if (!orderId) return { ok: true, action: 'ignored_no_order' };
    const existing = await store.getOrderPayment(orderId);
    if (existing && existing.status === 'paid') return { ok: true, action: 'already_paid' };
    await store.setOrderPayment(orderId, {
      status: 'paid',
      intentId: obj.id || (existing && existing.intentId) || null,
      amountCents: typeof obj.amount_received === 'number' ? obj.amount_received : (existing && existing.amountCents) || null,
      currency: obj.currency || (existing && existing.currency) || 'usd',
      paidAt: new Date().toISOString(),
    });
    return { ok: true, action: 'marked_paid', orderId };
  }

  if (event.type === 'payment_intent.payment_failed') {
    if (orderId) {
      const existing = await store.getOrderPayment(orderId);
      await store.setOrderPayment(orderId, {
        status: 'failed',
        intentId: obj.id || (existing && existing.intentId) || null,
        amountCents: (existing && existing.amountCents) || null,
        currency: (existing && existing.currency) || 'usd',
        paidAt: null,
      });
    }
    return { ok: true, action: 'recorded_failure', orderId };
  }

  return { ok: true, action: 'unhandled_type' };
}

/**
 * Full webhook entry point for the Worker router.
 * Reads the RAW body (text) — never parse JSON before verifying.
 */
export async function handleStripeWebhook(env, request, store) {
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return errJson(500, 'stripe_not_configured', 'STRIPE_WEBHOOK_SECRET is not configured');
  }
  const rawBody = await request.text();
  const sigHeader = request.headers.get('stripe-signature');
  let event;
  try {
    event = await verifyWebhookSignature(rawBody, sigHeader, webhookSecret);
  } catch (e) {
    return errJson(e.statusCode || 400, e.code || 'webhook_bad_signature', e.message);
  }
  const result = await applyPaymentEvent(store, event);
  return Response.json({ received: true, ...result });
}
