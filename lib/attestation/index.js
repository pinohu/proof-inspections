'use strict';

/**
 * Attestation core for proof-inspections.
 *
 * Provides the cryptographic primitives behind tamper-proof inspection
 * evidence:
 *
 *   - Ed25519 keypair generation (Node.js built-in crypto — no custom crypto)
 *   - Canonical JSON serialization (recursive key sort, no whitespace)
 *   - SHA-256 digests for buffers, strings, and files (streamed)
 *   - Signed proof bundles: { version, orderId, inspectorId, timestamp,
 *     evidence, publicKey, signature }
 *   - Bundle verification (signature + optional photo digest re-check)
 *
 * The signature covers the canonical JSON of the payload INCLUDING the
 * public key, so the bundle is self-certifying: a verifier needs nothing
 * out-of-band except this library (or any Ed25519 implementation).
 */

const {
  generateKeyPairSync,
  sign,
  verify,
  createHash,
  createPublicKey,
} = require('node:crypto');
const fs = require('node:fs');

const BUNDLE_VERSION = 'proof-inspections/v1';

/**
 * Serialize a value to canonical JSON: object keys sorted recursively,
 * no insignificant whitespace, UTF-8. Deterministic for any JSON value.
 * Throws on undefined, functions, symbols, BigInt, or non-finite numbers.
 */
function canonicalize(value) {
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

/** SHA-256 hex digest of a Buffer or UTF-8 string. */
function sha256Hex(data) {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return h.digest('hex');
}

/** SHA-256 hex digest of a file, streamed (safe for large photos). */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Generate an Ed25519 signing keypair.
 * @returns {{ publicKeyPem: string, privateKeyPem: string }} PEM-encoded keys.
 */
function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** Derive the public key PEM from a private key PEM (sanity / recovery). */
function publicKeyFromPrivate(privateKeyPem) {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
}

/**
 * Build and sign a proof bundle.
 *
 * @param {object} args
 * @param {string} args.orderId
 * @param {string} args.inspectorId
 * @param {string} args.timestamp  ISO-8601 UTC
 * @param {Array}  args.evidence   Canonical evidence entries:
 *   [{ id, notes, gps: {lat, lng} | null, capturedAt, inspectorId,
 *      photos: [{ filename, sha256, sizeBytes, mimeType }] }]
 * @param {{ publicKeyPem: string, privateKeyPem: string }} args.keypair
 * @returns {object} The signed bundle (includes `signature` and `bundleHash`).
 */
function createProofBundle({ orderId, inspectorId, timestamp, evidence, keypair }) {
  if (!orderId || !inspectorId || !timestamp || !Array.isArray(evidence)) {
    throw new Error('attestation: createProofBundle requires orderId, inspectorId, timestamp, evidence[]');
  }
  if (!keypair || !keypair.privateKeyPem || !keypair.publicKeyPem) {
    throw new Error('attestation: createProofBundle requires a keypair');
  }
  const payload = {
    version: BUNDLE_VERSION,
    orderId,
    inspectorId,
    timestamp,
    evidence,
    publicKey: keypair.publicKeyPem,
  };
  const canonical = canonicalize(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), keypair.privateKeyPem).toString('base64');
  const bundle = { ...payload, signature };
  // The bundle hash is the immutable artifact digest (covers signature too).
  const bundleHash = sha256Hex(canonicalize(bundle));
  return { ...bundle, bundleHash };
}

/**
 * Verify a proof bundle's signature.
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyProofBundle(bundle) {
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
    const ok = verify(
      null,
      Buffer.from(canonical, 'utf8'),
      payload.publicKey,
      Buffer.from(signature, 'base64'),
    );
    if (!ok) return { valid: false, reason: 'signature mismatch — bundle was altered or mis-signed' };
    // bundleHash covers the signed bundle ({...payload, signature}) but not itself.
    if (typeof bundleHash === 'string' && bundleHash !== sha256Hex(canonicalize({ ...payload, signature }))) {
      return { valid: false, reason: 'bundleHash does not match bundle content' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: 'verification error: ' + err.message };
  }
}

/**
 * Re-verify photo digests listed in a bundle against supplied file bytes.
 * @param {object} bundle  A verified proof bundle.
 * @param {Map<string, Buffer>|Array<{filename:string,data:Buffer}>} photos
 * @returns {{ valid: boolean, checked: number, failures: string[] }}
 */
function verifyPhotoDigests(bundle, photos) {
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
      if (sha256Hex(data) !== photo.sha256) {
        failures.push(photo.filename + ': digest mismatch');
      }
    }
  }
  return { valid: failures.length === 0, checked, failures };
}

module.exports = {
  BUNDLE_VERSION,
  canonicalize,
  sha256Hex,
  sha256File,
  generateKeypair,
  publicKeyFromPrivate,
  createProofBundle,
  verifyProofBundle,
  verifyPhotoDigests,
};
