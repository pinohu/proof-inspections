# proof-inspections — Cloudflare Workers

Live at: https://inspections.lodgingconnections.com

> **This branch (`pacrop-level`) is the current source of truth.** It re-syncs
> from the live production worker (KV-backed) and adds the PA CROP-level
> upgrade. See [PACROP-LEVEL-README.md](./PACROP-LEVEL-README.md) for the full
> guide: customer portal, contractor accounts, admin dashboard, email
> lifecycle, deploy instructions, and environment variables.

## Quick start

```bash
cd workers
node tools/deploy.mjs --dry-run   # build only → /tmp/proof-worker.js
node tools/deploy.mjs             # build + deploy to proof-inspections
```

## Layout

- `src/index.js` — worker entrypoint, router, all handlers (KV-backed)
- `src/auth.js` — passwordless auth (email + 6-char code)
- `src/email.js` / `src/email-templates.js` — transactional email service
- `src/stripe.js` — Stripe PaymentIntents + webhooks
- `src/attestation.js` — Ed25519 proof bundles
- `public/` — landing, portal, admin, tracking, contractor PWA
- `tools/deploy.mjs` — build + deploy (esbuild, inline assets, CF Scripts API)

## Key endpoints

| Area | Route |
|---|---|
| Customer portal | `/portal` → `GET /portal/orders`, `GET /portal/orders/:id` |
| Contractor | `/contractor/` → `GET /contractor/jobs` |
| Admin | `/admin` → `GET /admin/overview`, `/admin/orders`, `/admin/contractors`, `/admin/email-log` |
| Auth | `POST /auth/request-code`, `POST /auth/verify-code` |
