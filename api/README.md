# proof-inspections

Cryptographically-attested property inspection service — backend API and
attestation core.

Every inspection produces a **signed proof bundle**: all evidence (photos,
notes, GPS, timestamps) is SHA-256 digested, canonically serialized, and
signed with Ed25519. Anyone holding a bundle can verify — with no trusted
server — that the evidence is exactly what the inspector submitted and has
not been altered since. The bundle is self-certifying: it embeds the public
key it was signed with, and the signature covers that key too, so key
substitution is detectable.

## Layout

```
lib/attestation/   Crypto core: keypairs, canonical JSON, SHA-256, bundles
api/               Express backend (orders, evidence, proofs)
test/              node:test suites (no test-only dependencies)
data/              Runtime state: SQLite DB, signing keys, photos (gitignored)
```

**Dependencies:** `express` only. SQLite via Node.js built-in `node:sqlite`,
crypto via Node.js built-in `node:crypto`, multipart parsing hand-rolled in
`api/multipart.js` (deliberately dependency-free — see the file header).

## Quick start

```bash
npm install
npm test          # 25 tests, ~1s
npm start         # listens on :3000 (PORT env overrides)
```

First boot generates an Ed25519 signing keypair at `data/keys/` (private key
`0600`). **Back it up** — proofs cannot be re-signed without it. Override
with `PROOF_INSPECTIONS_PRIVATE_KEY_PEM` (use `\n` for newlines) or point
`PROOF_INSPECTIONS_DATA_DIR` elsewhere.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/.well-known/proof-inspections-key` | Signing public key (PEM) |
| `POST` | `/orders` | Create inspection order |
| `GET` | `/orders/:id` | Order + evidence + proof status |
| `POST` | `/orders/:id/evidence` | Submit evidence (multipart: `photos[]` + fields) |
| `POST` | `/orders/:id/complete` | Sign proof bundle, mark complete |
| `GET` | `/proof/:id` | Public signed proof bundle (shareable link) |
| `GET` | `/proof/:id/photo/:filename` | Attested photo bytes (`X-Photo-SHA256` header) |

Error shape: `{ "error": { "code": "...", "message": "..." } }`.

### Create an order

```bash
curl -s -X POST localhost:3000/orders -H 'Content-Type: application/json' -d '{
  "propertyAddress": "123 Peach St, Erie, PA 16502",
  "inspectionType": "insurance-condition",
  "customerEmail": "owner@example.com",
  "customerName": "Jane Owner"
}'
# → 201 { "order": { "id": "...", "status": "pending", ... } }
```

### Submit evidence (contractor)

```bash
curl -s -X POST localhost:3000/orders/<id>/evidence \
  -F "inspectorId=insp-42" \
  -F "notes=Roof flashing intact; gutter dented on NW corner." \
  -F "gpsLat=42.1292" -F "gpsLng=-80.0851" \
  -F "photos=@front.jpg" -F "photos=@roof.jpg"
# → 201 { "evidence": { "photos": [{ "filename": "...", "sha256": "..." }] } }
```

Photos are magic-byte sniffed (jpeg/png/gif/webp/heic), SHA-256 digested,
and stored under `data/photos/<orderId>/`. Max 20 photos, 15 MB each.

### Complete and get the proof

```bash
curl -s -X POST localhost:3000/orders/<id>/complete
# → 201 { "proof": { "id": "...", "bundleHash": "...",
#       "proofUrl": "/proof/<id>", "createdAt": "..." } }
```

Share `GET /proof/<id>` with the customer or insurer — it is the tamper-proof
record. Re-completing is idempotent; adding evidence after completion is
rejected (`409`).

### Verify a bundle (no server needed)

```js
const att = require('./lib/attestation');
const bundle = await (await fetch('https://host/proof/<id>')).json();
console.log(att.verifyProofBundle(bundle)); // { valid: true }
// Optionally re-check photo bytes against the bundle digests:
const photos = new Map();
for (const ev of bundle.evidence)
  for (const p of ev.photos)
    photos.set(p.filename, Buffer.from(await (await fetch(`https://host/proof/<id>/photo/${p.filename}`)).arrayBuffer()));
console.log(att.verifyPhotoDigests(bundle, photos)); // { valid: true, checked: n, failures: [] }
```

## Data model (SQLite)

- **orders** — id, property_address, inspection_type, customer_email,
  customer_name, status (`pending → dispatched → in_progress → complete`),
  contractor_id, created_at
- **evidence** — id, order_id, notes, gps_lat/lng, captured_at,
  inspector_id, created_at
- **evidence_photos** — id, evidence_id, order_id, filename,
  original_filename, stored_path, sha256, size_bytes, mime_type, created_at
- **proofs** — id, order_id (unique), bundle_json, bundle_hash, signature,
  created_at

`api/db.js` is the only file that touches SQLite — swap it for Postgres
without changing routes.

## Security notes

- No custom cryptography: Ed25519 + SHA-256 from Node.js `node:crypto`.
- Canonical JSON (recursive key sort, no whitespace) makes signatures
  deterministic and byte-exact across implementations.
- Photo serving validates the stored path against the DB record and a
  directory prefix check (no traversal).
- File-based private keys are a **bootstrap only**. Roadmap: KMS/HSM-backed
  signing, per-contractor API keys, rate limiting, and Postgres before
  production scale.

## Roadmap

- Contractor auth (API keys / scoped tokens) and per-order dispatch
- Billing integration (order → invoice on completion)
- Postgres migration (`api/db.js` swap)
- KMS-backed signing keys + key rotation ceremony
- Webhook on proof issuance (notify customer/insurer)
