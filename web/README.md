# Proof Inspections — customer ordering frontend

Public-facing site for ordering cryptographically-verified property inspections.
Vanilla HTML/CSS/JS. **No build step.** Static files live under `web/` and can be
served by the API itself or from any CDN.

## Pages

| Path | File | Purpose |
|---|---|---|
| `/` | `web/index.html` | Landing page + order form |
| `/track` | `web/track.html` | Order tracking (manual ID entry) |
| `/track/:id` | `web/track.html` | Order tracking (ID from URL — backend should route this path to `track.html`) |

The backend serving these files should route `/track/:id` → `web/track.html`.
If path-based routing isn't available, `/track.html?id=:id` works too — the
tracking page also accepts `?id=` and falls back to `sessionStorage`
(`proof_last_order`, set immediately after ordering).

## API contract

The frontend talks to the API at the **same origin** by default (relative URLs).
To point at a different host, set before `order.js`/`track.js` load:

```html
<script>window.PROOF_API_BASE = "https://api.example.com";</script>
```

(Single integration point — see `web/assets/js/config.js`.)

### `POST /orders` → create an order

Request body:

```json
{
  "propertyAddress": "123 W 8th St, Erie, PA 16502",
  "inspectionType": "insurance",
  "customerName": "Jane Smith",
  "customerEmail": "jane@example.com",
  "customerPhone": "(814) 555-0134",
  "notes": "Gate code 4410 (optional)"
}
```

`inspectionType` is one of: `insurance`, `pre-listing`, `rental-turnover`,
`storm-damage`, `general`.

Success response (`201`):

```json
{ "id": "pi_abc123", "status": "ordered" }
```

### `GET /orders/:id` → fetch an order

Success response (`200`):

```json
{
  "id": "pi_abc123",
  "status": "ordered",
  "propertyAddress": "123 W 8th St, Erie, PA 16502",
  "inspectionType": "insurance",
  "customerName": "Jane Smith",
  "customerEmail": "jane@example.com",
  "createdAt": "2026-10-06T03:30:00Z",
  "proofBundleUrl": "https://… (when report is ready)",
  "reportUrl": "https://… (when report is ready)",
  "digest": "sha256:… (when sealed)",
  "timeline": [
    { "stage": "ordered", "at": "2026-10-06T03:30:00Z" },
    { "stage": "inspector_dispatched", "at": "…" }
  ]
}
```

Only `id` and `status` are required. Everything else degrades gracefully when
absent. `timeline` is optional — the tracking page falls back to `createdAt`
for the first stage.

**Status values** are normalized client-side (lowercased, punctuation stripped),
so the backend may use its own vocabulary. Preferred values, in order:

1. `ordered` → "Order received"
2. `inspector_dispatched` → "Inspector dispatched"
3. `inspection_complete` → "Inspection complete"
4. `report_ready` → "Report ready" (terminal — proof bundle shown)

Aliases recognized: `pending`, `created`, `received`, `confirmed` (stage 1);
`assigned`, `scheduled`, `in_progress` (stage 2); `inspected`, `completed`,
`sealed` (stage 3); `delivered`, `done`, `closed` (stage 4). Unknown values
render as stage 1.

While an order is not terminal, the tracking page re-polls
`GET /orders/:id` every 30 seconds.

### Errors

- `404` on `GET /orders/:id` → "order not found" state.
- Non-2xx on `POST /orders` → inline form error with the server message.

## Demo mode (no backend needed)

Append `?demo=1` to the tracking page to preview the complete UI with sample
data: `/track?demo=1`. Clearly labeled as demo data in the UI.

## Serving

Any static file server works:

```sh
cd web && python3 -m http.server 8080
# http://localhost:8080/        -> landing + order form
# http://localhost:8080/track   -> tracking (needs /track/:id rewrite on real hosts)
```

On a real host, add a rewrite so `/track/:id` serves `track.html`
(e.g. Cloudflare Workers, nginx `try_files`, or the API's own static handler).

## Business rules reflected here

- Flat **$199** per inspection, shown upfront (landing hero, pricing section,
  order summary, submit button).
- Service area note: Erie, PA region (FAQ) — update when expanding.
- "Report in 24–48 hours" and "scheduled within 2 business days" promises —
  keep in sync with actual operations.
