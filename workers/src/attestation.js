/**
 * Attestation core for proof-inspections — Cloudflare Workers edition.
 *
 * Web Crypto API port of lib/attestation/index.js. Produces BYTE-IDENTICAL
 * proof bundles: same canonical JSON, same SHA-256 digests, same raw
 * 64-byte Ed25519 signatures, same PEM encodings. A bundle signed here
 * verifies with the Node implementation and vice versa.
 *
 * Differences from the Node version (all intentional):
 *   - All crypto operations are async (Web Crypto is promise-based).
 *   - Keypairs are imported from the PROOF_INSPECTIONS_PRIVATE_KEY_PEM
 *     Worker secret; generation is provided for setup tooling only.
 *   - sha256File is omitted (no filesystem; photos hash from memory).
 */

export const BUNDLE_VERSION = 'proof-inspections/v1';

/**
 * Serialize a value to canonical JSON: object keys sorted recursively,
 * no insignificant whitespace, UTF-8. Deterministic for any JSON value.
 * Throws on undefined, functions, symbols, BigInt, or non-finite numbers.
 *
 * Identical semantics to the Node implementation (Array.prototype.sort on
 * UTF-16 code units, JSON.stringify number formatting).
 */
export function canonicalize(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('attestation: cannot canonicalize non-finite number');
    }
    // JSON.stringify(-0) === "0", so negative zero is already normalized.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error('attestation: cannot canonicalize value of type ' + typeof value);
}

/** Base64-encode a Uint8Array (standard alphabet, padded). */
export function base64Encode(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** Base64-decode to a Uint8Array (whitespace-tolerant). */
export function base64Decode(b64) {
  const s = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/**
 * DER bytes -> PEM text, 64-char lines, trailing newline.
 * Matches Node's keyObject.export({ format: 'pem' }) layout exactly.
 */
export function pemEncode(label, derBytes) {
  const b64 = base64Encode(derBytes);
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** PEM text -> DER bytes. */
export function pemDecode(pem) {
  const m = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(String(pem));
  if (!m) throw new Error('attestation: malformed PEM');
  return base64Decode(m[1]);
}

/** SHA-256 hex digest of a Uint8Array/ArrayBuffer or UTF-8 string. */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate an Ed25519 signing keypair (setup tooling; not used per-request).
 * @returns {{ publicKeyPem: string, privateKeyPem: string }} PEM-encoded keys.
 */
export async function generateKeypair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubDer = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const privDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return {
    publicKeyPem: pemEncode('PUBLIC KEY', pubDer),
    privateKeyPem: pemEncode('PRIVATE KEY', privDer),
  };
}

/** Import a PKCS#8 PEM private key as a CryptoKey for signing. */
export async function importPrivateKey(privateKeyPem) {
  const der = pemDecode(privateKeyPem);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

/**
 * Derive the SPKI PEM public key from a PKCS#8 PEM private key.
 * (Web Crypto cannot export the public half directly, so we round-trip
 * through JWK, which carries the public 'x' coordinate.)
 */
export async function publicKeyFromPrivate(privateKeyPem) {
  const priv = await crypto.subtle.importKey(
    'pkcs8', pemDecode(privateKeyPem), { name: 'Ed25519' }, true, ['sign'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  const pub = await crypto.subtle.importKey(
    'jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, true, ['verify'],
  );
  const spkiDer = new Uint8Array(await crypto.subtle.exportKey('spki', pub));
  return pemEncode('PUBLIC KEY', spkiDer);
}

/** Import an SPKI PEM public key as a CryptoKey for verification. */
export async function importPublicKey(publicKeyPem) {
  const der = pemDecode(publicKeyPem);
  return crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
}

/**
 * Build and sign a proof bundle. Byte-compatible with the Node version.
 *
 * @param {object} args
 * @param {string} args.orderId
 * @param {string} args.inspectorId
 * @param {string} args.timestamp  ISO-8601 UTC
 * @param {Array}  args.evidence   Canonical evidence entries:
 *   [{ id, notes, gps: {lat, lng} | null, capturedAt, inspectorId,
 *      photos: [{ filename, sha256, sizeBytes, mimeType }] }]
 * @param {CryptoKey} args.signKey      Imported Ed25519 private key.
 * @param {string}    args.publicKeyPem  SPKI PEM (embedded in the bundle).
 * @returns {object} The signed bundle (includes `signature` and `bundleHash`).
 */
export async function createProofBundle({ orderId, inspectorId, timestamp, evidence, signKey, publicKeyPem }) {
  if (!orderId || !inspectorId || !timestamp || !Array.isArray(evidence)) {
    throw new Error('attestation: createProofBundle requires orderId, inspectorId, timestamp, evidence[]');
  }
  if (!signKey || !publicKeyPem) {
    throw new Error('attestation: createProofBundle requires signKey and publicKeyPem');
  }
  const payload = {
    version: BUNDLE_VERSION,
    orderId,
    inspectorId,
    timestamp,
    evidence,
    publicKey: publicKeyPem,
  };
  const canonical = canonicalize(payload);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign('Ed25519', signKey, new TextEncoder().encode(canonical)),
  );
  const signature = base64Encode(sigBytes);
  const bundle = { ...payload, signature };
  // The bundle hash is the immutable artifact digest (covers signature too).
  const bundleHash = await sha256Hex(canonicalize(bundle));
  return { ...bundle, bundleHash };
}

/**
 * Verify a proof bundle's signature.
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function verifyProofBundle(bundle) {
  try {
    if (!bundle || typeof bundle !== 'object') {
      return { valid: false, reason: 'not an object' };
    }
    const { signature, bundleHash, ...payload } = bundle;
    if (typeof signature !== 'string' || !signature) {
      return { valid: false, reason: 'missing signature' };
    }
    if (payload.version !== BUNDLE_VERSION) {
      return { valid: false, reason: 'unsupported version: ' + payload.version };
    }
    if (typeof payload.publicKey !== 'string' || !payload.publicKey.includes('PUBLIC KEY')) {
      return { valid: false, reason: 'missing or malformed publicKey' };
    }
    const canonical = canonicalize(payload);
    const pubKey = await importPublicKey(payload.publicKey);
    const ok = await crypto.subtle.verify(
      'Ed25519',
      pubKey,
      base64Decode(signature),
      new TextEncoder().encode(canonical),
    );
    if (!ok) return { valid: false, reason: 'signature mismatch — bundle was altered or mis-signed' };
    // bundleHash covers the signed bundle ({...payload, signature}) but not itself.
    if (typeof bundleHash === 'string' && bundleHash !== (await sha256Hex(canonicalize({ ...payload, signature })))) {
      return { valid: false, reason: 'bundleHash does not match bundle content' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: 'verification error: ' + err.message };
  }
}

/**
 * Re-verify photo digests listed in a bundle against supplied photo bytes.
 * @param {object} bundle  A verified proof bundle.
 * @param {Map<string, Uint8Array>|Array<{filename:string,data:Uint8Array}>} photos
 * @returns {Promise<{ valid: boolean, checked: number, failures: string[] }>}
 */
export async function verifyPhotoDigests(bundle, photos) {
  const failures = [];
  let checked = 0;
  const byName = photos instanceof Map
    ? photos
    : new Map(photos.map((p) => [p.filename, p.data]));
  for (const entry of bundle.evidence || []) {
    for (const photo of entry.photos || []) {
      const data = byName.get(photo.filename);
      if (!data) {
        failures.push(photo.filename + ': photo not supplied');
        continue;
      }
      checked += 1;
      if ((await sha256Hex(data)) !== photo.sha256) {
        failures.push(photo.filename + ': digest mismatch');
      }
    }
  }
  return { valid: failures.length === 0, checked, failures };
}
