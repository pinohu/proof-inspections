# Proof Inspections — PA CROP-level upgrade (`pacrop-level` branch)

This branch upgrades proof-inspections (https://inspections.lodgingconnections.com)
to the quality and automation bar of PA CROP Services: customer portal with
passwordless login, contractor accounts, admin dashboard, automated email
lifecycle, and a design polish pass. The JTBD redesign (decision-first hero,
three personas) is preserved and extended.

**Base:** the live production worker (KV-backed, inlined static assets).
The repo's `workers/` source had drifted behind live; this branch re-syncs
from the live deployment and builds forward. Nothing in the live deployment
is touched by this branch until an explicit deploy is run.

---

## What was built

### 1. Customer portal (`/portal`)
- **Passwordless sign-in** (PA CROP style): email → 6-character code → session.
  No passwords. Codes are SHA-256 hashed, 15-minute expiry, rate-limited
  (5/hour per email).
- **Order list**: all orders for the signed-in email, with status pills and
  paid badges.
- **Order detail**: full timeline (created → paid → dispatched → evidence →
  completed), payment status, inspector name, and proof-bundle download with
  digest when ready.
- Sessions: 30-day TTL, `Authorization: Bearer` tokens in KV.

### 2. Contractor portal (`/contractor/`) — upgraded with real accounts
- **Contractor accounts**: email-based sign-in (code flow, 7-day sessions),
  backed by a `contractors` table in KV. Human-friendly IDs (`LM-001`).
- Legacy ID-code sign-in still works (backwards compatible).
- **Fixed two live bugs**:
  - Evidence upload accepted only field name `photos`; the PWA sent
    `photos[]` → submissions failed. The worker now accepts both.
  - GPS fields: worker expected `gpsLat`/`gpsLng`; PWA sent `lat`/`lng`.
    Both accepted now.
- Authenticated job list at `GET /contractor/jobs` (Bearer token);
  legacy `GET /contractor/:id/jobs` kept as an alias.

### 3. Admin dashboard (`/admin`)
- Admin sign-in (email + code; email must be in `ADMIN_EMAILS` env; 12h sessions).
- **Overview**: KPI cards (orders, revenue, paid), orders-by-status bar chart,
  recent orders, contractor performance (assigned/completed).
- **Orders**: search + status filter, pagination, one-click dispatch
  (assign contractor → status `dispatched` → both emails fire).
- **Contractors**: list, add (auto-ID), activate/deactivate.
- **Emails**: full transactional email log (template, recipient, status, provider).

### 4. Automated email lifecycle (`src/email.js` + `src/email-templates.js`)
- Provider abstraction: `EMAIL_PROVIDER=stub` (default, safe) | `emailit` | `resend`.
  - **Emailit** (`POST https://api.emailit.com/v1/emails/send`, Bearer key) —
    the org already uses Emailit for PA CROP.
  - **Resend** (`POST https://api.resend.com/emails`).
  - **Stub** logs to KV + console, marked `stubbed` — the full lifecycle is
    verifiable end-to-end before wiring a provider.
- Every send recorded in KV (`email:{id}` + append-only `email:idx:` index).
- Templates (table-based, 600px, mobile-friendly, HTML + plain text):
  `login_code`, `order_confirmation`, `inspector_dispatched`, `report_ready`,
  `contractor_assignment`.
- Triggered automatically: order created → confirmation; admin dispatch →
  customer + contractor emails; order completed → report-ready with proof link;
  Stripe `payment_intent.succeeded` → timeline `paid` event.

### 5. Design polish + trust signals (landing page)
- **Preserved**: JTBD decision-first hero, three personas, "What decision are
  you making?" order form.
- Added: **Proof Guarantee** band (refund + free re-inspect if proof ever
  fails verification), **illustrative scenarios** section (clearly labeled —
  real customer stories to be added), **contact info** in footer
  (support@inspections.lodgingconnections.com, (855) 442-0515 — placeholders for the owner),
  **customer portal link** in nav.
- **Mobile nav**: hamburger menu (previously links just vanished on mobile).
- **Reveal-on-scroll** micro-interactions (respects `prefers-reduced-motion`).
- Portal/admin share the site's design tokens (Inter, `--accent` green).

### 6. Bug fixes (found while building)
- `GET /orders/:id` called `store.getPayment()` — a method that doesn't exist —
  so payment status was always null on the track page. Fixed to
  `getOrderPayment()`.
- KV index race: concurrent writes to `orders:all` / `emails:recent` could drop
  entries. Replaced with append-only `*:idx:` key patterns.

---

## Architecture

```
workers/
  src/
    index.js            # router + all handlers (KV-backed)
    auth.js             # passwordless auth (codes, sessions, roles)
    email.js            # transactional email service (stub/emailit/resend)
    email-templates.js  # 5 HTML+text templates
    stripe.js           # Stripe PaymentIntents + webhooks (unchanged logic)
    attestation.js      # Ed25519 proof bundles (unchanged)
    multipart.js        # multipart parser (unchanged)
  public/
    index.html          # landing (JTBD + guarantee + scenarios + contact)
    portal.html         # customer portal
    admin.html          # admin dashboard
    track.html          # order tracking (+ mobile nav)
    contractor/         # contractor PWA (auth upgrade)
    assets/css/styles.css
    assets/js/{config,order,track,portal,admin}.js
  tools/
    deploy.mjs          # build + deploy (esbuild + inline assets + CF API)
    gen-key.mjs         # Ed25519 key generation (unchanged)
```

**Storage (all KV):** orders (`order:{id}` + `order:idx:`), evidence
(`evidence:{id}`, `order-evidence:{id}`), photos (`photo:{order}:{file}`),
proofs (`proof:{id}`, `order-proof:{id}`), payments (`pay:order:{id}`),
auth (`authcode:{id}`, `session:{token}`, `ratelimit:code:{email}`),
contractors (`contractor:{id}`, `contractor:email:{email}`, `contractor:idx:`),
emails (`email:{id}`, `email:idx:`), timeline (`events:{orderId}`).

**Auth roles:** `customer` (any email, own orders), `contractor` (registered
contractor email, own jobs), `admin` (`ADMIN_EMAILS` env allowlist).

---

## Environment variables / secrets

| Name | Required | Description |
|---|---|---|
| `PROOF_INSPECTIONS_PRIVATE_KEY_PEM` | yes (secret) | Ed25519 signing key — already set on live |
| `STRIPE_SECRET_KEY` | for payments | `sk_live_...` — already set on live |
| `STRIPE_WEBHOOK_SECRET` | for payments | `whsec_...` — already set on live |
| `ADMIN_EMAILS` | for `/admin` | Comma-separated owner emails, e.g. `owner@example.com` |
| `EMAIL_PROVIDER` | no (default `stub`) | `stub` \| `emailit` \| `resend` |
| `EMAIL_FROM` | no | Sender, default `Proof Inspections <support@inspections.lodgingconnections.com>` |
| `EMAIL_REPLY_TO` | no | Reply-to address |
| `EMAILIT_API_KEY` | if provider=emailit | Emailit API key (secret) |
| `RESEND_API_KEY` | if provider=resend | Resend API key (secret) |
| `SITE_URL` | no | Default `https://inspections.lodgingconnections.com` |
| `INSPECTION_PRICE_CENTS` | no | Default `19900` |

KV binding: `KV` → the `proof-inspections` namespace (already attached to live).

---

## Deploy

```bash
cd workers
node tools/deploy.mjs --dry-run   # build only → /tmp/proof-worker.js
node tools/deploy.mjs             # build + deploy to proof-inspections
node tools/deploy.mjs --script proof-inspections-staging  # staging
```

The deploy script replicates the live pattern exactly: esbuild bundle →
inline `public/` into `ASSETS` → prepend `serveAsset()` → append the
production wrapper → `PUT` to the Cloudflare Scripts API. Bindings and
secrets already on the script are preserved (omitted from metadata).

**Do not deploy to production without:** setting `ADMIN_EMAILS`, deciding on
`EMAIL_PROVIDER` (stub is safe for testing), and creating the first
contractor account via `/admin` after deploy.

## Verification performed

- esbuild bundle: clean (273 KB, 15 assets inlined).
- Mock-KV end-to-end: order create → confirmation email; code request/verify
  (incl. wrong-code rejection); role gating (admin/contractor); portal list +
  detail + timeline; contractor create (auto-ID `LM-001`) → dispatch (both
  emails) → contractor jobs; admin overview/search/email-log; concurrent
  order+email index integrity (3/3 captured).
- Static serving: `/`, `/portal`, `/admin`, `/track`, `/contractor/` all 200
  in the bundled worker.

## Open items (owner decisions, not blockers)

1. **Stripe keys** — still needed for live payments (unchanged from before).
2. **`ADMIN_EMAILS`** — set to the owner's email before first admin sign-in.
3. **`EMAIL_PROVIDER`** — `stub` is the safe default; flip to `emailit` when
   ready (the org already has Emailit). Every lifecycle email is already
   firing in stub mode and visible in `/admin` → Emails.
4. **First contractor** — create Luis Montes via `/admin` → Contractors
   (replaces the manual ID-code onboarding).
5. **Contact placeholders** — `support@inspections.lodgingconnections.com` / `(855) 442-0515`
   appear in footer + email templates; swap for real ones.
6. **Customer stories** — the testimonials section is labeled illustrative;
   replace with real quotes as they come in.
