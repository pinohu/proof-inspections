# proof-inspections — Cloudflare Workers deployment

Runs the same API as the Node.js backend (`api/`) on Cloudflare Workers,
with D1 for metadata, R2 for photo bytes, and Web Crypto for Ed25519
attestation. **Proof bundles are byte-compatible with the Node version**:
same canonical JSON, same signatures, same PEM formats. A bundle signed
by the Worker verifies with `lib/attestation` and vice versa.

Live at: https://inspections.lodgingconnections.com

## One-time setup

```bash
cd workers
npm install

# 1. D1 database
wrangler d1 create proof-inspections
# -> paste the database_id into wrangler.toml

# 2. Apply schema
wrangler d1 execute proof-inspections --file=./schema.sql

# 3. R2 bucket for photos
wrangler r2 bucket create proof-inspections-photos

# 4. Signing key (Ed25519). KEEP THIS SAFE — proofs can't be re-signed.
node tools/gen-key.mjs
wrangler secret put PROOF_INSPECTIONS_PRIVATE_KEY_PEM
# (paste the PEM, newlines included)

# 5. Deploy (attaches inspections.lodgingconnections.com via [[routes]])
wrangler deploy
```

Local dev: `wrangler dev` (uses local D1/R2 simulators; set the key in
`.dev.vars` — never commit that file).

## Architecture

| Concern      | Node version          | Workers version              |
|--------------|-----------------------|------------------------------|
| HTTP         | Express               | `src/index.js` router        |
| Metadata     | `node:sqlite` file    | D1 (`schema.sql`)            |
| Photos       | `./data/photos/`      | R2 `proof-inspections-photos`|
| Signing      | `node:crypto` Ed25519 | Web Crypto Ed25519           |
| Multipart    | `api/multipart.js`    | `src/multipart.js` (port)    |
| Key storage  | `./data/keys/`        | `PROOF_INSPECTIONS_PRIVATE_KEY_PEM` secret |

`src/attestation.js` is a line-for-line port of `lib/attestation/index.js`
to async Web Crypto. Canonical JSON, SHA-256, signature encoding, and PEM
layout are identical — cross-verified by `workers/test-compat.mjs`.

## Endpoints

Same contract as the Node API (see repo root README):

- `GET /health`
- `GET /.well-known/proof-inspections-key`
- `POST /orders`, `GET /orders/:id`
- `POST /orders/:id/evidence` (multipart)
- `POST /orders/:id/complete`
- `GET /proof/:id`, `GET /proof/:id/photo/:filename`
- `/` landing, `/track/*` tracking, `/contractor/*` PWA (static assets)

## Notes

- Request bodies are capped at 50 MB (Workers platform limit; the Node
  version allows 120 MB).
- The signing key is cached per isolate after first import.
- D1 `batch()` is used for evidence+photo metadata writes (atomic).
- Photo reads are immutable-cached (`Cache-Control: public, max-age=31536000, immutable`).
- Not yet ported: Stripe billing, PDF reports, dispatch poller
  (`automation/`). Those can run as a separate scheduled Worker later.
