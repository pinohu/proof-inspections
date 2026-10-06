/**
 * email.js — transactional email service for proof-inspections (Workers, KV-backed).
 *
 * Provider abstraction with a fail-safe stub default:
 *
 *   EMAIL_PROVIDER   — 'stub' (default) | 'emailit' | 'resend'
 *   EMAIL_FROM       — sender, e.g. "Proof Inspections <hello@proofinspections.com>"
 *   EMAIL_REPLY_TO   — reply-to address (optional)
 *   EMAILIT_API_KEY  — required when EMAIL_PROVIDER=emailit
 *   RESEND_API_KEY   — required when EMAIL_PROVIDER=resend
 *
 * Every send is recorded in KV (`email:{id}` + `emails:recent` index) with
 * template, recipient, status, provider, and error. In stub mode nothing
 * leaves the Worker — the email is logged and marked 'stubbed' so the full
 * lifecycle can be verified end-to-end before wiring a real provider.
 *
 * Templates live in ./email-templates.js and are pure functions of vars.
 */

import { TEMPLATES } from './email-templates.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailProvider(env) {
  const p = String(env.EMAIL_PROVIDER || 'stub').toLowerCase();
  return ['emailit', 'resend'].includes(p) ? p : 'stub';
}

export function emailFrom(env) {
  return env.EMAIL_FROM || 'Proof Inspections <hello@proofinspections.com>';
}

async function recordEmail(kv, rec) {
  try {
    await kv.put(`email:${rec.id}`, JSON.stringify(rec));
    // Append-only index (no read-modify-write race): each entry gets its own
    // key so concurrent sends never clobber each other.
    await kv.put(`email:idx:${rec.createdAt}:${rec.id}`, rec.id);
  } catch (e) {
    console.warn('[email] KV log unavailable:', e.message);
  }
}

async function updateEmail(kv, id, patch) {
  try {
    const rec = await kv.get(`email:${id}`, 'json');
    if (rec) await kv.put(`email:${id}`, JSON.stringify({ ...rec, ...patch }));
  } catch { /* best effort */ }
}

/**
 * Send a templated email. Never throws — failures are recorded with
 * status 'failed' and returned as { ok: false, error }.
 */
export async function sendEmail(env, { to, template, vars = {}, orderId = null }) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const tpl = TEMPLATES[template];
  if (!tpl) return { ok: false, error: `unknown email template: ${template}` };
  const toEmail = String(to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(toEmail)) return { ok: false, error: 'invalid recipient email' };

  let subject, html, text;
  try {
    subject = tpl.subject(vars);
    html = tpl.html(vars);
    text = tpl.text(vars);
  } catch (e) {
    return { ok: false, error: `template render failed: ${e.message}` };
  }

  const provider = emailProvider(env);
  await recordEmail(env.KV, {
    id, toEmail, template, subject, status: 'queued',
    provider, error: null, orderId, createdAt: now, sentAt: null,
  });

  const finish = async (status, error = null) => {
    const sentAt = status === 'sent' || status === 'stubbed' ? new Date().toISOString() : null;
    await updateEmail(env.KV, id, { status, error, sentAt });
    return status === 'sent' || status === 'stubbed'
      ? { ok: true, id, status, provider }
      : { ok: false, id, status, provider, error };
  };

  if (provider === 'stub') {
    console.log(`[email:stub] to=${toEmail} template=${template} subject=${JSON.stringify(subject)}`);
    return finish('stubbed');
  }

  try {
    if (provider === 'emailit') await sendViaEmailit(env, { to: toEmail, subject, html, text });
    else await sendViaResend(env, { to: toEmail, subject, html, text });
    return finish('sent');
  } catch (e) {
    console.error(`[email:${provider}] send failed:`, e.message);
    return finish('failed', e.message);
  }
}

async function sendViaEmailit(env, { to, subject, html, text }) {
  const apiKey = env.EMAILIT_API_KEY;
  if (!apiKey) throw new Error('EMAILIT_API_KEY is not configured');
  const res = await fetch('https://api.emailit.com/v1/emails/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: emailFrom(env),
      to,
      subject,
      html,
      text,
      reply_to: env.EMAIL_REPLY_TO || undefined,
      tags: ['proof-inspections', 'transactional'],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`emailit ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function sendViaResend(env, { to, subject, html, text }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: emailFrom(env),
      to: [to],
      subject,
      html,
      text,
      reply_to: env.EMAIL_REPLY_TO || undefined,
      tags: [{ name: 'app', value: 'proof-inspections' }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ */
/* lifecycle helpers — one call per business event                     */
/* ------------------------------------------------------------------ */

const shortId = (id) => String(id || '').slice(0, 8);
const siteUrl = (env) => String(env.SITE_URL || 'https://inspections.lodgingconnections.com').replace(/\/+$/, '');

export function orderEmailVars(env, order) {
  const base = siteUrl(env);
  return {
    customerName: order.customerName || '',
    orderId: order.id,
    shortId: shortId(order.id),
    propertyAddress: order.propertyAddress || '',
    inspectionType: order.inspectionType || '',
    amount: '$199.00',
    trackUrl: `${base}/track/${order.id}`,
    siteUrl: base,
  };
}

export async function sendOrderConfirmation(env, order) {
  return sendEmail(env, {
    to: order.customerEmail,
    template: 'order_confirmation',
    vars: orderEmailVars(env, order),
    orderId: order.id,
  });
}

export async function sendInspectorDispatched(env, order, contractor) {
  return sendEmail(env, {
    to: order.customerEmail,
    template: 'inspector_dispatched',
    vars: { ...orderEmailVars(env, order), inspectorName: contractor ? contractor.name : 'your inspector' },
    orderId: order.id,
  });
}

export async function sendReportReady(env, order, proof) {
  const base = siteUrl(env);
  return sendEmail(env, {
    to: order.customerEmail,
    template: 'report_ready',
    vars: {
      ...orderEmailVars(env, order),
      proofUrl: `${base}/track/${order.id}`,
      bundleHashShort: String(proof.bundleHash || '').slice(0, 16),
    },
    orderId: order.id,
  });
}

export async function sendContractorAssignment(env, contractor, order) {
  const base = siteUrl(env);
  return sendEmail(env, {
    to: contractor.email,
    template: 'contractor_assignment',
    vars: {
      contractorName: contractor.name || '',
      orderId: order.id,
      shortId: shortId(order.id),
      propertyAddress: order.propertyAddress || '',
      inspectionType: order.inspectionType || '',
      customerNotes: '',
      portalUrl: `${base}/contractor/`,
      siteUrl: base,
    },
    orderId: order.id,
  });
}

export async function sendLoginCode(env, email, code) {
  return sendEmail(env, {
    to: email,
    template: 'login_code',
    vars: { code, expiresMinutes: 15, siteUrl: siteUrl(env) },
  });
}

/** Read recent email log entries (admin). Newest first. */
export async function recentEmails(kv, limit = 50) {
  const out = [];
  try {
    // kv.list returns keys in lexicographic order; our index keys sort
    // oldest-first, so take the tail and reverse.
    const listed = await kv.list({ prefix: 'email:idx:' });
    const keys = (listed.keys || []).map((k) => k.name).sort();
    const tail = keys.slice(-limit).reverse();
    for (const key of tail) {
      const id = key.split(':').pop();
      const rec = await kv.get(`email:${id}`, 'json');
      if (rec) out.push(rec);
    }
  } catch (e) {
    console.warn('[email] KV list unavailable:', e.message);
  }
  return out;
}
