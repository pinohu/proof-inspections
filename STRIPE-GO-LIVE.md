# Stripe Go-Live Checklist — proof-inspections

**Site:** https://inspections.lodgingconnections.com
**Branch:** `stripe-live` (based on `workers-deploy`)
**Price:** $199.00 USD per inspection (19900 cents, configurable via `INSPECTION_PRICE_CENTS`)

All code is written and tested. Nothing here uses real keys — the owner
provides them at go-live. No real money moves until every step is done.

---

## What the code does (already built)

**Worker (`workers/src/`):**
- `stripe.js` — dependency-free Stripe integration: PaymentIntent creation
  via Stripe REST API, webhook signature verification via Web Crypto
  (HMAC-SHA256, 5-min timestamp tolerance), idempotent event application.
- `stripe-store-d1.js` — D1 storage adapter (order_payments + stripe_events).
- `index.js` — two new endpoints:
  - `POST /orders/:id/payment-intent` → `{ intentId, clientSecret, amountCents, currency }`
  - `POST /webhooks/stripe` → verifies signature, marks orders paid/failed.
  - `GET /orders/:id` now includes `payment: { status, amountCents, currency, paidAt }`.

**Database (`workers/schema-migration-payments.sql`):**
- New tables `order_payments` and `stripe_events`. No changes to existing
  tables. Apply with:
  `wrangler d1 execute proof-inspections --file=./schema-migration-payments.sql`

**Frontend (`web/`, mirrored to `workers/public/`):**
- Order form → creates order → creates PaymentIntent → Stripe Payment
  Element → confirms card → shows confirmation + tracking link.
- Publishable key placeholder in `index.html` (`pk_test_REPLACE_ME`).

---

## Owner action items (in order)

### 1. Stripe account — get the keys
1. Log in to https://dashboard.stripe.com (create an account if needed).
2. **Publishable key:** Developers → API keys → copy the **Publishable key**
   (`pk_live_...`). While testing, use the test-mode key (`pk_test_...`;
   toggle "Test mode" in the dashboard).
3. **Secret key:** Same page → copy the **Secret key** (`sk_live_...` /
   `sk_test_...`). Click "Reveal" — copy it once, it won't be shown again.
4. Save both somewhere safe (password manager). **Never commit them.**

### 2. Run the database migration
```bash
cd workers/
wrangler d1 execute proof-inspections --file=./schema-migration-payments.sql
```
Verify: `wrangler d1 execute proof-inspections --command="SELECT name FROM sqlite_master WHERE type='table'"` should list `order_payments` and `stripe_events`.

### 3. Set the Worker secrets
```bash
cd workers/
wrangler secret put STRIPE_SECRET_KEY        # paste sk_live_... (or sk_test_...)
wrangler secret put STRIPE_WEBHOOK_SECRET    # paste whsec_... (from step 4)
```

### 4. Register the webhook in Stripe
1. Stripe dashboard → Developers → Webhooks → **Add endpoint**.
2. Endpoint URL: **`https://inspections.lodgingconnections.com/webhooks/stripe`**
3. Events to listen for:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
4. Click **Add endpoint** → open it → **Signing secret** → Reveal → copy
   the `whsec_...` value → use it in step 3 as `STRIPE_WEBHOOK_SECRET`.

### 5. Set the publishable key in the frontend
In `web/index.html` (and the mirrored `workers/public/index.html`):
```html
window.PROOF_STRIPE_KEY = "pk_live_...";   <!-- your real publishable key -->
```
Commit and redeploy the Worker.

### 6. Deploy
```bash
cd workers/
wrangler deploy
```

### 7. Test end-to-end (test mode first!)
1. With `sk_test_` / `pk_test_` keys and a test webhook secret, place an
   order on the live site.
2. Pay with Stripe's test card `4242 4242 4242 4242`, any future expiry,
   any CVC.
3. Confirm: order confirmation shows, `/track/:id` shows the order, and
   `GET /orders/:id` returns `payment.status === "paid"`.
4. Test a decline with `4000 0000 0000 0002` — the form should show the
   decline message and let the customer retry.
5. Check the Stripe dashboard → Developers → Webhooks → the endpoint →
   recent deliveries should show `200` responses.

### 8. Go live
1. Replace test keys with live keys (`pk_live_`, `sk_live_`), create a
   **separate live-mode webhook endpoint** (Stripe test and live modes
   have separate webhooks — repeat step 4 with test mode OFF), update
   `STRIPE_WEBHOOK_SECRET` to the live `whsec_...`.
2. Redeploy.
3. Place a real $199 order yourself (refund it after) to confirm live
   money flows.

---

## Operational notes

- **Source of truth:** the Stripe webhook marks orders paid. The frontend
  confirmation is UX only — dispatch must check `payment.status === 'paid'`
  (via `GET /orders/:id`) before assigning a contractor.
- **Idempotency:** duplicate webhook deliveries are ignored
  (`stripe_events` table). Re-creating a PaymentIntent for the same order
  reuses the open intent instead of double-charging.
- **Failed payments:** `payment_intent.payment_failed` sets status
  `failed`; the customer can retry — the next `/payment-intent` call
  creates a fresh intent.
- **Refunds:** issue from the Stripe dashboard (Payments → select →
  Refund). The Worker does not auto-refund.
- **Disputes/chargebacks:** Stripe emails the account owner. Keep the
  signed proof bundle for each order — it is your evidence that the
  inspection was performed.
- **Key rotation:** if a secret key leaks, roll it in the Stripe dashboard
  (Developers → API keys → roll), then `wrangler secret put` the new value
  and redeploy. Same for the webhook secret (Webhooks → endpoint → roll secret).

## Files changed in this branch

- `workers/src/stripe.js` (new) — Stripe API + webhook verification
- `workers/src/stripe-store-d1.js` (new) — D1 payment storage adapter
- `workers/src/index.js` — new endpoints + payment in order detail
- `workers/schema-migration-payments.sql` (new) — payment tables
- `workers/wrangler.toml` — secret documentation
- `web/index.html` + `workers/public/index.html` — Stripe.js, key placeholder, payment step UI
- `web/assets/js/config.js` + `workers/public/...` — publishable key config
- `web/assets/js/order.js` + `workers/public/...` — payment flow
- `web/assets/css/styles.css` + `workers/public/...` — payment step styles
