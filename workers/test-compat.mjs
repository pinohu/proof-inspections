/**
 * Cross-compatibility test: Node lib/attestation vs workers/src/attestation.
 * Run: node workers/test-compat.mjs
 * All assertions must pass for the Workers deployment to be proof-compatible.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const nodeAtt = require('/tmp/proof-w/lib/attestation/index.js');
const wAtt = await import(pathToFileURL('/tmp/proof-w/workers/src/attestation.js').href);

let n = 0;
const ok = (name) => { n++; console.log('ok', n, '-', name); };

// 1. canonicalize: string-identical on tricky inputs
const tricky = [
  { z: 1, a: { d: [3, 2], b: 'x' }, m: null },
  { s: 'héllo "w" \\ \n \t' },
  { emoji: '🏠', num: -0, exp: 1e21, neg: -1.5 },
  { arr: [{ b: 1, a: 2 }, null, 'str', 3.14159] },
  { 'k ey': { 'ünïcodé': true }, '': 'empty-key' },
];
for (const t of tricky) {
  assert.strictEqual(wAtt.canonicalize(t), nodeAtt.canonicalize(t));
}
ok('canonicalize identical on tricky inputs');

// 2. sha256Hex: identical
for (const s of ['', 'hello', 'héllo 🏠', 'x'.repeat(100000)]) {
  assert.strictEqual(await wAtt.sha256Hex(s), nodeAtt.sha256Hex(s));
}
const bytes = new Uint8Array([0, 1, 2, 255, 254, 253]);
assert.strictEqual(await wAtt.sha256Hex(bytes), nodeAtt.sha256Hex(Buffer.from(bytes)));
ok('sha256Hex identical (strings + binary)');

// 3. publicKeyFromPrivate: identical PEM for a Node-generated keypair
const nodeKp = nodeAtt.generateKeypair();
const wPub = await wAtt.publicKeyFromPrivate(nodeKp.privateKeyPem);
assert.strictEqual(wPub, nodeKp.publicKeyPem);
ok('publicKeyFromPrivate PEM identical to Node export');

// 4. PEM round-trip: Workers-generated keypair imports in Node
const wKp = await wAtt.generateKeypair();
assert.strictEqual(nodeAtt.publicKeyFromPrivate(wKp.privateKeyPem), wKp.publicKeyPem);
ok('Workers-generated keypair derives identically in Node');

// 5. Same canonical payload signed by both -> IDENTICAL signature (Ed25519 deterministic)
const payload = {
  version: 'proof-inspections/v1',
  orderId: 'test-order-1',
  inspectorId: 'CTR001',
  timestamp: '2026-10-06T03:31:55.602Z',
  evidence: [{
    id: 'ev-1', notes: 'Roof ok 🏠', gps: { lat: 42.1292, lng: -80.0851 },
    capturedAt: '2026-10-06T03:30:00.000Z', inspectorId: 'CTR001',
    photos: [{ filename: 'a.png', sha256: 'ab'.repeat(32), sizeBytes: 123, mimeType: 'image/png' }],
  }],
  publicKey: nodeKp.publicKeyPem,
};
const canon = nodeAtt.canonicalize(payload);
assert.strictEqual(wAtt.canonicalize(payload), canon);
const { sign } = require('node:crypto');
const nodeSig = sign(null, Buffer.from(canon, 'utf8'), nodeKp.privateKeyPem).toString('base64');
const wSignKey = await wAtt.importPrivateKey(nodeKp.privateKeyPem);
const wSigBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', wSignKey, new TextEncoder().encode(canon)));
const wSig = wAtt.base64Encode(wSigBytes);
assert.strictEqual(wSig, nodeSig);
ok('Ed25519 signatures byte-identical for same key+payload');

// 6. Node-created bundle verifies with Workers verifier
const nodeBundle = nodeAtt.createProofBundle({ ...payload, keypair: nodeKp });
delete payload.publicKey; // (payload reused above; bundle built from fresh object below is cleaner)
const r1 = await wAtt.verifyProofBundle(nodeBundle);
assert.strictEqual(r1.valid, true, JSON.stringify(r1));
ok('Workers verifier accepts Node-signed bundle');

// 7. Workers-created bundle verifies with Node verifier
const wBundle = await wAtt.createProofBundle({
  orderId: payload.orderId,
  inspectorId: payload.inspectorId,
  timestamp: payload.timestamp,
  evidence: payload.evidence,
  signKey: wSignKey,
  publicKeyPem: nodeKp.publicKeyPem,
});
const r2 = nodeAtt.verifyProofBundle(wBundle);
assert.strictEqual(r2.valid, true, JSON.stringify(r2));
ok('Node verifier accepts Workers-signed bundle');

// 8. Bundle shapes match key-for-key
assert.deepStrictEqual(
  Object.keys(wBundle).sort(),
  Object.keys(nodeBundle).sort(),
);
assert.strictEqual(wBundle.version, 'proof-inspections/v1');
ok('bundle object shape identical');

// 9. Tamper detection works cross-implementation
const tampered = JSON.parse(JSON.stringify(wBundle));
tampered.evidence[0].notes = 'HACKED';
assert.strictEqual((await wAtt.verifyProofBundle(tampered)).valid, false);
assert.strictEqual(nodeAtt.verifyProofBundle(tampered).valid, false);
ok('tamper detected by both verifiers');

// 10. verifyPhotoDigests parity
const photoData = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const digest = await wAtt.sha256Hex(photoData);
assert.strictEqual(digest, nodeAtt.sha256Hex(Buffer.from(photoData)));
const b2 = await wAtt.createProofBundle({
  orderId: 'o', inspectorId: 'i', timestamp: '2026-01-01T00:00:00.000Z',
  evidence: [{ id: 'e', notes: null, gps: null, capturedAt: '2026-01-01T00:00:00.000Z', inspectorId: 'i',
    photos: [{ filename: 'p.png', sha256: digest, sizeBytes: photoData.length, mimeType: 'image/png' }] }],
  signKey: wSignKey, publicKeyPem: nodeKp.publicKeyPem,
});
const vr = await wAtt.verifyPhotoDigests(b2, new Map([['p.png', photoData]]));
assert.strictEqual(vr.valid, true);
assert.strictEqual(vr.checked, 1);
ok('verifyPhotoDigests parity');

console.log(`\nALL ${n} COMPAT CHECKS PASSED`);
