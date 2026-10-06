'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const att = require('../lib/attestation');

describe('canonicalize', () => {
  it('sorts keys recursively and strips whitespace', () => {
    const a = att.canonicalize({ z: 1, a: { d: [3, 2], b: 'x' }, m: null });
    assert.equal(a, '{"a":{"b":"x","d":[3,2]},"m":null,"z":1}');
  });

  it('is independent of input key order', () => {
    const x = att.canonicalize({ b: 1, a: 2 });
    const y = att.canonicalize({ a: 2, b: 1 });
    assert.equal(x, y);
  });

  it('round-trips through JSON.parse', () => {
    const obj = { n: 1.5, s: 'héllo "w"', arr: [true, false, null], neg: -0 };
    assert.deepEqual(JSON.parse(att.canonicalize(obj)).s, 'héllo "w"');
  });

  it('rejects non-JSON values', () => {
    assert.throws(() => att.canonicalize({ f: () => {} }), /cannot canonicalize/);
    assert.throws(() => att.canonicalize({ n: NaN }), /non-finite/);
    assert.throws(() => att.canonicalize(undefined), /cannot canonicalize/);
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 test vector', () => {
    // "abc" — FIPS 180-4 example.
    assert.equal(
      att.sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes buffers identically to their utf8 strings', () => {
    assert.equal(att.sha256Hex(Buffer.from('abc')), att.sha256Hex('abc'));
  });
});

describe('keypair', () => {
  it('generates PEM-encoded Ed25519 keys', () => {
    const kp = att.generateKeypair();
    assert.match(kp.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.match(kp.privateKeyPem, /BEGIN PRIVATE KEY/);
  });

  it('derives the same public key from the private key', () => {
    const kp = att.generateKeypair();
    assert.equal(att.publicKeyFromPrivate(kp.privateKeyPem).trim(), kp.publicKeyPem.trim());
  });

  it('generates unique keypairs', () => {
    assert.notEqual(att.generateKeypair().publicKeyPem, att.generateKeypair().publicKeyPem);
  });
});

function sampleArgs(keypair) {
  return {
    orderId: 'order-123',
    inspectorId: 'insp-9',
    timestamp: '2026-10-06T03:40:00.000Z',
    evidence: [
      {
        id: 'ev-1',
        notes: 'Roof in good condition.',
        gps: { lat: 42.12, lng: -80.08 },
        capturedAt: '2026-10-06T03:35:00.000Z',
        inspectorId: 'insp-9',
        photos: [{ filename: 'a.jpg', sha256: att.sha256Hex('fake-bytes'), sizeBytes: 10, mimeType: 'image/jpeg' }],
      },
    ],
    keypair,
  };
}

describe('proof bundle', () => {
  it('creates a bundle that verifies', () => {
    const kp = att.generateKeypair();
    const bundle = att.createProofBundle(sampleArgs(kp));
    assert.equal(bundle.version, att.BUNDLE_VERSION);
    assert.ok(bundle.signature);
    assert.ok(bundle.bundleHash);
    assert.equal(bundle.publicKey.trim(), kp.publicKeyPem.trim());
    assert.deepEqual(att.verifyProofBundle(bundle), { valid: true });
  });

  it('detects tampering with evidence', () => {
    const kp = att.generateKeypair();
    const bundle = att.createProofBundle(sampleArgs(kp));
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.evidence[0].notes = 'Roof is collapsing.';
    const r = att.verifyProofBundle(tampered);
    assert.equal(r.valid, false);
    assert.match(r.reason, /signature mismatch/);
  });

  it('detects tampering with the timestamp', () => {
    const kp = att.generateKeypair();
    const bundle = att.createProofBundle(sampleArgs(kp));
    const tampered = { ...bundle, timestamp: '2020-01-01T00:00:00.000Z' };
    assert.equal(att.verifyProofBundle(tampered).valid, false);
  });

  it('rejects a bundle signed by a different key', () => {
    const kp = att.generateKeypair();
    const other = att.generateKeypair();
    const bundle = att.createProofBundle(sampleArgs(kp));
    // Attacker swaps the embedded public key but cannot forge the signature.
    const forged = { ...bundle, publicKey: other.publicKeyPem };
    assert.equal(att.verifyProofBundle(forged).valid, false);
  });

  it('rejects bundles with missing/unsupported fields', () => {
    assert.equal(att.verifyProofBundle(null).valid, false);
    assert.equal(att.verifyProofBundle({}).valid, false);
    const kp = att.generateKeypair();
    const b = att.createProofBundle(sampleArgs(kp));
    assert.equal(att.verifyProofBundle({ ...b, version: 'proof-inspections/v99' }).valid, false);
  });

  it('bundleHash is deterministic and covers the signature', () => {
    const kp = att.generateKeypair();
    const args = sampleArgs(kp);
    const b1 = att.createProofBundle(args);
    const b2 = att.createProofBundle(args);
    assert.equal(b1.bundleHash, b2.bundleHash);
    // The hash must cover the signature itself: changing it changes the hash.
    assert.notEqual(b1.bundleHash, att.sha256Hex(att.canonicalize({ ...b1, signature: 'AAAA' })));
  });
});

describe('verifyPhotoDigests', () => {
  it('passes when bytes match digests, fails otherwise', () => {
    const kp = att.generateKeypair();
    const photoBytes = Buffer.from('photo-bytes-123');
    const args = sampleArgs(kp);
    args.evidence[0].photos = [{ filename: 'a.jpg', sha256: att.sha256Hex(photoBytes), sizeBytes: photoBytes.length, mimeType: 'image/jpeg' }];
    const bundle = att.createProofBundle(args);

    const ok = att.verifyPhotoDigests(bundle, new Map([['a.jpg', photoBytes]]));
    assert.deepEqual(ok, { valid: true, checked: 1, failures: [] });

    const bad = att.verifyPhotoDigests(bundle, new Map([['a.jpg', Buffer.from('different')]]));
    assert.equal(bad.valid, false);
    assert.equal(bad.failures.length, 1);

    const missing = att.verifyPhotoDigests(bundle, new Map());
    assert.equal(missing.valid, false);
    assert.match(missing.failures[0], /not supplied/);
  });
});
