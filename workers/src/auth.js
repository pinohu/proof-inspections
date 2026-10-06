/**
 * auth.js — passwordless auth for proof-inspections (Cloudflare Workers, KV-backed).
 *
 * PA CROP-style: email + 6-character code, no passwords.
 *   POST /auth/request-code  { email, role? } -> { ok: true }
 *   POST /auth/verify-code   { email, code }  -> { token, role, expiresAt }
 *   POST /auth/logout        (Bearer token)  -> { ok: true }
 *
 * Roles: customer | contractor | admin.
 *  - customer: any email; session can read own orders.
 *  - contractor: email must belong to an active contractor record.
 *  - admin: email must be listed in ADMIN_EMAILS env (comma-separated).
 *
 * KV keys:
 *   authcode:{id}            -> { email, codeHash, role, expiresAt }  (TTL 20m)
 *   authcode:idx:{email}     -> latest code id (TTL 20m, for invalidation)
 *   ratelimit:code:{email}   -> { count, windowStart }                (TTL 1h)
 *   session:{token}          -> { email, role, contractorId }         (TTL per role)
 *
 * Sessions are opaque bearer tokens (32 random bytes, hex).
 * TTLs: customer 30d, contractor 7d, admin 12h.
 */

import { sha256Hex } from './attestation.js';
import { sendLoginCode } from './email.js';

const CODE_TTL_SEC = 20 * 60;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const SESSION_TTL_SEC = {
  customer: 30 * 24 * 3600,
  contractor: 7 * 24 * 3600,
  admin: 12 * 3600,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errJson(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function getContractorByEmail(kv, email) {
  const id = await kv.get(`contractor:email:${email}`, 'text');
  if (!id) return null;
  const c = await kv.get(`contractor:${id}`, 'json');
  return c && c.active ? c : null;
}

/** Resolve the effective role for an email, or null if not permitted. */
export async function resolveRole(env, email, requestedRole) {
  const role = (requestedRole || 'customer').toLowerCase();
  if (!['customer', 'contractor', 'admin'].includes(role)) return null;
  if (role === 'admin') {
    return adminEmails(env).includes(email) ? 'admin' : null;
  }
  if (role === 'contractor') {
    const c = await getContractorByEmail(env.KV, email);
    return c ? 'contractor' : null;
  }
  return 'customer';
}

export async function handleRequestCode(request, env) {
  let body;
  try { body = await request.json(); } catch { return errJson(400, 'invalid_json', 'request body must be JSON'); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return errJson(400, 'invalid_email', 'a valid email address is required');

  const requestedRole = String(body.role || 'customer').toLowerCase();
  const role = await resolveRole(env, email, requestedRole);
  if (!role) {
    if (requestedRole !== 'customer') {
      return errJson(403, 'role_not_permitted', 'this email is not registered for that sign-in');
    }
    return errJson(400, 'invalid_email', 'a valid email address is required');
  }

  // Rate limit: 5 code requests / email / hour.
  const rlKey = `ratelimit:code:${email}`;
  const rl = (await env.KV.get(rlKey, 'json')) || { count: 0, windowStart: Date.now() };
  if (Date.now() - rl.windowStart < 3600 * 1000 && rl.count >= 5) {
    return errJson(429, 'rate_limited', 'too many code requests — try again in an hour');
  }
  const newCount = Date.now() - rl.windowStart < 3600 * 1000 ? rl.count + 1 : 1;
  await env.KV.put(rlKey, JSON.stringify({ count: newCount, windowStart: rl.windowStart }), { expirationTtl: 3600 });

  const code = randomCode();
  const codeHash = await sha256Hex(new TextEncoder().encode(code));
  const id = crypto.randomUUID();

  // Invalidate any previous outstanding code for this email.
  const prevId = await env.KV.get(`authcode:idx:${email}`, 'text');
  if (prevId) await env.KV.delete(`authcode:${prevId}`);

  await env.KV.put(
    `authcode:${id}`,
    JSON.stringify({ email, codeHash, role }),
    { expirationTtl: CODE_TTL_SEC },
  );
  await env.KV.put(`authcode:idx:${email}`, id, { expirationTtl: CODE_TTL_SEC });

  const sent = await sendLoginCode(env, email, code);
  if (!sent.ok && sent.provider !== 'stub') {
    console.error('[auth] login code email failed:', sent.error);
    return errJson(502, 'email_failed', 'could not send the sign-in code — try again');
  }
  return Response.json({ ok: true, role, expiresInMinutes: 15 });
}

export async function handleVerifyCode(request, env) {
  let body;
  try { body = await request.json(); } catch { return errJson(400, 'invalid_json', 'request body must be JSON'); }
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!EMAIL_RE.test(email) || code.length !== 6) {
    return errJson(400, 'invalid_code', 'email and 6-character code are required');
  }

  const id = await env.KV.get(`authcode:idx:${email}`, 'text');
  if (!id) return errJson(401, 'code_invalid', 'that code is expired or invalid — request a new one');
  const rec = await env.KV.get(`authcode:${id}`, 'json');
  if (!rec) return errJson(401, 'code_invalid', 'that code is expired or invalid — request a new one');

  const candidateHash = await sha256Hex(new TextEncoder().encode(code));
  if (!timingSafeEqual(candidateHash, rec.codeHash)) {
    return errJson(401, 'code_invalid', 'that code is incorrect — check and try again');
  }

  // Re-resolve the role at verify time (contractor may have been deactivated).
  const role = await resolveRole(env, email, rec.role);
  await env.KV.delete(`authcode:${id}`);
  await env.KV.delete(`authcode:idx:${email}`);
  if (!role) {
    return errJson(403, 'role_not_permitted', 'this sign-in is no longer permitted');
  }

  let contractorId = null;
  if (role === 'contractor') {
    const c = await getContractorByEmail(env.KV, email);
    contractorId = c ? c.id : null;
    if (!contractorId) return errJson(403, 'role_not_permitted', 'contractor account is no longer active');
  }

  const token = randomToken();
  const ttl = SESSION_TTL_SEC[role] || SESSION_TTL_SEC.customer;
  await env.KV.put(
    `session:${token}`,
    JSON.stringify({ email, role, contractorId }),
    { expirationTtl: ttl },
  );

  return Response.json({
    token,
    role,
    contractorId,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extract and validate the bearer session. Returns { session } or { error: Response }. */
export async function requireAuth(request, env, roles = ['customer', 'contractor', 'admin']) {
  const header = request.headers.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return { error: errJson(401, 'unauthorized', 'sign-in required') };
  const token = m[1].trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return { error: errJson(401, 'unauthorized', 'invalid session') };

  const session = await env.KV.get(`session:${token}`, 'json');
  if (!session) return { error: errJson(401, 'unauthorized', 'session expired — sign in again') };
  if (!roles.includes(session.role)) {
    return { error: errJson(403, 'forbidden', 'this area requires a different sign-in') };
  }
  return { session };
}

export async function handleLogout(request, env) {
  const header = request.headers.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m && /^[0-9a-f]{64}$/.test(m[1].trim())) {
    await env.KV.delete(`session:${m[1].trim()}`);
  }
  return Response.json({ ok: true });
}
