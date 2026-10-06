# Automation layer — Proof Inspections

The self-running loop: **order → pay → dispatch → inspect → verify → report → deliver**.
No human touches an order. Every automated action is appended to `data/audit.log`
(JSON lines) and to the order's own `history`.

## Layout

| File | Responsibility |
|---|---|
| `config.js` | Env-driven config (prices, Stripe keys, paths, flags) |
| `store.js` | Order store (file-backed MVP; swappable interface) |
| `audit.js` | Append-only audit log |
| `contractors.json` | **Template** — owner adds real contractors here |
| `notify.js` | SMS/email stubs (TODO: Twilio + Emailit for live) |
| `dispatch.js` | Round-robin contractor assignment |
| `proof.js` | SHA-256 proof hash over canonical inspection evidence |
| `report.js` | PDF report generation (pdfkit) → `../reports/:orderId.pdf` |
| `billing.js` | Stripe PaymentIntent + webhook handler |
| `lifecycle.js` | Orchestrator: event-driven functions + poller safety net |
| `index.js` | Public exports for the API layer |

Order states: `pending → paid → dispatched → inspected → verified → reported → delivered`
(`cancelled` / `failed` are terminal.)

## Running

```bash
cd automation
npm install
node lifecycle.js        # poller safety net (POLL_INTERVAL_MS, default 30s)
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | — | Stripe **test** secret key (required for live billing) |
| `STRIPE_WEBHOOK_SECRET` | — | Verifies `POST /webhooks/stripe` signatures |
| `INSPECTION_PRICE_CENTS` | `19900` | $199.00 per inspection |
| `PAY_BEFORE_DISPATCH` | `true` | `false` = dispatch immediately (pay on delivery) |
| `NOTIFY_MODE` | `stub` | `stub` logs; `live` = real providers (TODO) |
| `BUSINESS_NAME` | `Proof Inspections` | Branding in PDFs/notifications |
| `REPORTS_DIR` | `../reports` | Where PDFs are written |
| `DATA_DIR` | `./data` | Orders, audit log, dispatch cursor |

## Backend API contract (for the backend agent)

Mount these endpoints and call into `automation/index.js`:

1. **`POST /orders`** (order intake)
   ```js
   const auto = require("../automation");
   const order = auto.store.createOrder({ customer, property, inspectionType });
   await auto.lifecycle.advanceOrder(auto.store, order.id); // creates PaymentIntent, may dispatch
   // return { orderId, clientSecret } so the frontend can collect payment
   ```
   Note: `createPaymentIntent` needs `STRIPE_SECRET_KEY`; without it the
   intent step is skipped with an audit entry and the order waits.

2. **`POST /webhooks/stripe`** — **must pass the raw body Buffer** and the
   `stripe-signature` header value:
   ```js
   const auto = require("../automation");
   // express: app.post("/webhooks/stripe", express.raw({type:"application/json"}), (req,res)=>{...})
   const result = auto.billing.handleStripeWebhook(auto.store, req.body, req.headers["stripe-signature"]);
   if (result.action === "marked_paid") {
     auto.dispatch.dispatchOrder(auto.store, orderIdFromEvent); // or rely on poller
   }
   res.json({ received: true });
   ```

3. **`POST /orders/:id/inspection`** (contractor submits field evidence)
   ```js
   const order = auto.lifecycle.submitInspection(auto.store, id, {
     inspectorId, completedAt, gps: {lat, lng}, notes,
     photos: [{ localPath, caption, sha256, capturedAt }]
   });
   await auto.lifecycle.advanceOrder(auto.store, id); // verify → report → deliver
   ```

4. **`GET /reports/:orderId.pdf`** — serve the file
   ```js
   const p = auto.report.reportPath(orderId); // <reportsDir>/<orderId>.pdf
   // 404 if missing; set Content-Type: application/pdf
   ```

## Going live checklist

- [ ] Add real contractors to `contractors.json` (`active: true`, areas set)
- [ ] Set `STRIPE_SECRET_KEY` (test) and `STRIPE_WEBHOOK_SECRET`
- [ ] Register webhook endpoint in Stripe dashboard → `POST /webhooks/stripe`
- [ ] Wire Twilio (SMS) + Emailit in `notify.js`, set `NOTIFY_MODE=live`
- [ ] Upgrade `proof.js` to PIFN signer signatures when the signer is live
- [ ] Run the poller under a process supervisor (systemd/pm2) as the safety net
