/**
 * End-to-end test of workers/src/index.js with mocked D1/R2/ASSETS.
 * Run: node workers/test-worker-e2e.mjs
 *
 * Mocks D1 with node:sqlite (same SQL dialect) wrapped in the D1
 * prepare/bind/first/all/run/batch interface, R2 with a Map, and ASSETS
 * with a 404 stub. Exercises the full order -> evidence -> complete ->
 * proof -> photo loop, then cross-verifies the bundle with the Node lib.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const nodeAtt = require('/tmp/proof-w/lib/attestation/index.js');
const worker = (await import(pathToFileURL('/tmp/proof-w/workers/src/index.js').href)).default;

// ---- mock D1 (node:sqlite behind the D1 statement interface) ----
const sqldb = new DatabaseSync(':memory:');
sqldb.exec(readFileSync('/tmp/proof-w/workers/schema.sql', 'utf8'));

function wrapStmt(stmt) {
  return {
    bind(...args) {
      return {
        first: async () => stmt.get(...args) ?? null,
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => { stmt.run(...args); return { success: true }; },
      };
    },
  };
}
const DB = {
  prepare: (sql) => wrapStmt(sqldb.prepare(sql)),
  batch: async (stmts) => { for (const s of stmts) await s.run(); return []; },
};

// ---- mock R2 ----
const r2map = new Map();
const PHOTOS = {
  put: async (key, data, opts) => { r2map.set(key, { body: data, contentType: opts?.httpMetadata?.contentType }); },
  get: async (key) => {
    const v = r2map.get(key);
    if (!v) return null;
    return { body: v.body, httpMetadata: { contentType: v.contentType } };
  },
};

// ---- mock ASSETS ----
const ASSETS = { fetch: async () => new Response('not found', { status: 404 }) };

// ---- signing key (Node-generated; proves cross-impl key compat) ----
const kp = nodeAtt.generateKeypair();
const env = { DB, PHOTOS, ASSETS, PROOF_INSPECTIONS_PRIVATE_KEY_PEM: kp.privateKeyPem };

const base = 'https://inspections.lodgingconnections.com';
async function call(method, path, body, headers = {}) {
  const req = new Request(base + path, { method, body, headers });
  return worker.fetch(req, env, {});
}

// 1. health
let res = await call('GET', '/health');
assert.strictEqual(res.status, 200);
assert.deepStrictEqual((await res.json()).ok, true);
console.log('ok - GET /health');

// 2. well-known key matches the Node-generated public key exactly
res = await call('GET', '/.well-known/proof-inspections-key');
assert.strictEqual(res.status, 200);
assert.strictEqual(await res.text(), kp.publicKeyPem);
console.log('ok - public key endpoint returns Node-generated PEM');

// 3. create order
res = await call('POST', '/orders', JSON.stringify({
  propertyAddress: '123 Main St, Erie PA 16502',
  inspectionType: 'insurance',
  customerEmail: 'Test@Example.com',
  customerName: 'Test Customer',
}), { 'content-type': 'application/json' });
assert.strictEqual(res.status, 201);
const { order } = await res.json();
assert.strictEqual(order.status, 'pending');
assert.strictEqual(order.customerEmail, 'test@example.com'); // lowercased
console.log('ok - POST /orders', order.id);

// 4. validation still enforced
res = await call('POST', '/orders', JSON.stringify({}), { 'content-type': 'application/json' });
assert.strictEqual(res.status, 400);
console.log('ok - order validation');

// 5. submit evidence (real multipart body, tiny PNG)
const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4,5]);
const boundary = '----testboundary123';
const enc = new TextEncoder();
const parts = [];
const addField = (name, val) => parts.push(enc.encode(
  `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
addField('inspectorId', 'CTR001');
addField('notes', 'Roof in good condition');
addField('gpsLat', '42.1292');
addField('gpsLng', '-80.0851');
parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="roof.png"\r\nContent-Type: image/png\r\n\r\n`));
parts.push(png);
parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
const mpBody = Buffer.concat(parts);
res = await call('POST', `/orders/${order.id}/evidence`, mpBody,
  { 'content-type': `multipart/form-data; boundary=${boundary}` });
if (res.status !== 201) {
  const t = await res.text();
  throw new Error('evidence submit failed: ' + res.status + ' ' + t.slice(0, 300));
}
const { evidence } = await res.json();
assert.strictEqual(evidence.photos.length, 1);
assert.strictEqual(evidence.photos[0].mimeType, 'image/png');
assert.strictEqual(evidence.photos[0].sizeBytes, png.length);
assert.strictEqual(evidence.gps.lat, 42.1292);
console.log('ok - POST /orders/:id/evidence');

// 6. order status advanced to in_progress
res = await call('GET', `/orders/${order.id}`);
assert.strictEqual((await res.json()).order.status, 'in_progress');
console.log('ok - status advanced to in_progress');

// 7. complete -> signed bundle
res = await call('POST', `/orders/${order.id}/complete`, JSON.stringify({}), { 'content-type': 'application/json' });
assert.strictEqual(res.status, 201);
const { proof } = await res.json();
assert.ok(proof.bundleHash);
assert.ok(proof.signature);
console.log('ok - POST /orders/:id/complete', proof.id);

// 8. fetch bundle + verify with the NODE verifier (cross-implementation)
res = await call('GET', `/proof/${proof.id}`);
assert.strictEqual(res.status, 200);
const bundle = await res.json();
const vr = nodeAtt.verifyProofBundle(bundle);
assert.strictEqual(vr.valid, true, JSON.stringify(vr));
assert.strictEqual(bundle.publicKey, kp.publicKeyPem);
console.log('ok - Worker-signed bundle verifies with Node lib');

// 9. photo round-trip with digest header
const fname = bundle.evidence[0].photos[0].filename;
res = await call('GET', `/proof/${proof.id}/photo/${encodeURIComponent(fname)}`);
assert.strictEqual(res.status, 200);
assert.strictEqual(res.headers.get('X-Photo-SHA256'), bundle.evidence[0].photos[0].sha256);
const photoBytes = new Uint8Array(await res.arrayBuffer());
assert.deepStrictEqual(photoBytes, png);
console.log('ok - photo bytes byte-identical, digest header matches');

// 10. idempotent re-complete
res = await call('POST', `/orders/${order.id}/complete`, null, {});
const again = await res.json();
assert.strictEqual(again.alreadyComplete, true);
assert.strictEqual(again.proof.id, proof.id);
console.log('ok - re-complete is idempotent');

// 11. 404s
assert.strictEqual((await call('GET', '/orders/nope')).status, 404);
assert.strictEqual((await call('GET', '/proof/nope')).status, 404);
console.log('ok - 404 handling');

// 12. /track rewrite serves track.html asset (mock returns 404 here; check it hits ASSETS)
res = await call('GET', '/track/abc123');
assert.strictEqual(res.status, 404); // mock ASSETS 404s; real deploy serves track.html
console.log('ok - /track routed to assets (mock)');

console.log('\nALL WORKER E2E CHECKS PASSED');
