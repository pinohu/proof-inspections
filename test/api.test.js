'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const att = require('../lib/attestation');
const { openDatabase } = require('../api/db');
const { createApp } = require('../api/server');

/** Build a multipart/form-data body by hand (no test-only deps). */
function multipartBody(boundary, fields = {}, files = []) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  }
  for (const f of files) {
    parts.push(Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
        `Content-Type: ${f.mime}\r\n\r\n`,
        'utf8',
      ),
      f.data,
      Buffer.from('\r\n'),
    ]));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

// Minimal valid JPEG: SOI + JFIF-ish bytes. Magic-byte sniffing only needs the header.
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  Buffer.from('fake-jpeg-payload-for-tests'),
]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-payload'),
]);
const NOT_AN_IMAGE = Buffer.from('this is definitely not image data');

describe('proof-inspections API', () => {
  let base;
  let server;
  let dataDir;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-inspections-test-'));
    const keypair = att.generateKeypair();
    const { stmts } = openDatabase(path.join(dataDir, 'test.db'));
    const app = createApp({ stmts, attestation: att, keypair, dataDir });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const postJSON = (p, body) => fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function createOrder(overrides = {}) {
    const res = await postJSON('/orders', {
      propertyAddress: '123 Peach St, Erie, PA 16502',
      inspectionType: 'insurance-condition',
      customerEmail: 'owner@example.com',
      customerName: 'Test Owner',
      ...overrides,
    });
    assert.equal(res.status, 201);
    return (await res.json()).order;
  }

  function evidenceRequest(orderId, fields, files) {
    const boundary = '----testboundary' + Date.now();
    return fetch(base + `/orders/${orderId}/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody(boundary, fields, files),
    });
  }

  const evFields = {
    inspectorId: 'insp-1',
    notes: 'Front porch railing loose.',
    gpsLat: '42.1292',
    gpsLng: '-80.0851',
  };
  const evFiles = [
    { field: 'photos', filename: 'porch.jpg', mime: 'image/jpeg', data: JPEG_BYTES },
    { field: 'photos', filename: 'roof.png', mime: 'image/png', data: PNG_BYTES },
  ];

  it('GET /health reports ok', async () => {
    const res = await fetch(base + '/health');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  it('publishes the signing public key', async () => {
    const res = await fetch(base + '/.well-known/proof-inspections-key');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /BEGIN PUBLIC KEY/);
  });

  it('POST /orders validates input', async () => {
    let res = await postJSON('/orders', {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_property_address');

    res = await postJSON('/orders', {
      propertyAddress: '1 Main St', inspectionType: 'x',
      customerEmail: 'not-an-email', customerName: 'N',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_customer_email');
  });

  it('creates and retrieves an order', async () => {
    const order = await createOrder();
    assert.equal(order.status, 'pending');
    assert.ok(order.id);

    const res = await fetch(base + `/orders/${order.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.order.id, order.id);
    assert.deepEqual(body.evidence, []);
    assert.equal(body.proof, null);

    const missing = await fetch(base + '/orders/does-not-exist');
    assert.equal(missing.status, 404);
  });

  it('rejects evidence without photos or with non-images', async () => {
    const order = await createOrder();

    let res = await evidenceRequest(order.id, evFields, []);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'no_photos');

    res = await evidenceRequest(order.id, evFields, [
      { field: 'photos', filename: 'evil.txt', mime: 'text/plain', data: NOT_AN_IMAGE },
    ]);
    assert.equal(res.status, 415);

    res = await evidenceRequest(order.id, { notes: 'no inspector' }, evFiles);
    assert.equal(res.status, 400);
  });

  it('accepts evidence and records SHA-256 digests', async () => {
    const order = await createOrder();
    const res = await evidenceRequest(order.id, evFields, evFiles);
    assert.equal(res.status, 201);
    const { evidence } = await res.json();
    assert.equal(evidence.photos.length, 2);
    assert.equal(evidence.photos[0].sha256, att.sha256Hex(JPEG_BYTES));
    assert.equal(evidence.photos[1].sha256, att.sha256Hex(PNG_BYTES));
    assert.deepEqual(evidence.gps, { lat: 42.1292, lng: -80.0851 });

    const got = await (await fetch(base + `/orders/${order.id}`)).json();
    assert.equal(got.order.status, 'in_progress');
    assert.equal(got.evidence.length, 1);
  });

  it('refuses to complete an order with no evidence', async () => {
    const order = await createOrder();
    const res = await postJSON(`/orders/${order.id}/complete`, {});
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'no_evidence');
  });

  it('completes an order and issues a verifiable proof bundle', async () => {
    const order = await createOrder();
    await evidenceRequest(order.id, evFields, evFiles);

    const res = await postJSON(`/orders/${order.id}/complete`, {});
    assert.equal(res.status, 201);
    const { proof } = await res.json();
    assert.ok(proof.id);
    assert.ok(proof.bundleHash);
    assert.ok(proof.signature);

    // The public proof endpoint returns a bundle that verifies client-side.
    const bundleRes = await fetch(base + proof.proofUrl);
    assert.equal(bundleRes.status, 200);
    const bundle = await bundleRes.json();
    assert.deepEqual(att.verifyProofBundle(bundle), { valid: true });
    assert.equal(bundle.bundleHash, proof.bundleHash);
    assert.equal(bundle.orderId, order.id);
    assert.equal(bundle.evidence.length, 1);
    assert.equal(bundle.evidence[0].photos.length, 2);

    // Tampering with a downloaded copy is detectable.
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.evidence[0].notes = 'everything is fine, trust me';
    assert.equal(att.verifyProofBundle(tampered).valid, false);

    // Attested photo bytes round-trip with matching digests.
    for (const photo of bundle.evidence[0].photos) {
      const img = await fetch(base + `/proof/${proof.id}/photo/${photo.filename}`);
      assert.equal(img.status, 200);
      const bytes = Buffer.from(await img.arrayBuffer());
      assert.equal(img.headers.get('x-photo-sha256'), photo.sha256);
      assert.equal(att.sha256Hex(bytes), photo.sha256);
    }

    // Order now shows complete with proof attached.
    const got = await (await fetch(base + `/orders/${order.id}`)).json();
    assert.equal(got.order.status, 'complete');
    assert.equal(got.proof.id, proof.id);

    // Re-completing is idempotent; new evidence is rejected.
    const again = await postJSON(`/orders/${order.id}/complete`, {});
    assert.equal(again.status, 200);
    assert.equal((await again.json()).alreadyComplete, true);

    const late = await evidenceRequest(order.id, evFields, evFiles);
    assert.equal(late.status, 409);
  });

  it('returns 404 for unknown proofs and photos', async () => {
    assert.equal((await fetch(base + '/proof/nope')).status, 404);
  });
});
