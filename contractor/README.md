# ProofInspect — Contractor App

Mobile-first PWA for field contractors to capture cryptographically-attested inspection evidence.

## Install on your phone

1. Open this page in Safari (iPhone) or Chrome (Android):
   `https://<host>/contractor/index.html`
2. **iPhone:** Share → Add to Home Screen.
   **Android:** Menu (⋮) → Add to Home screen / Install app.
3. Open **ProofInspect** from your home screen.

## Use (under 5 minutes per inspection)

1. Enter your **contractor ID code** (given by the office). It stays saved on your phone.
2. Tap **Show my jobs** — your assigned inspections appear.
3. Tap **Start inspection**.
4. Tap **📷 Take photo** — take before/during/after photos. Tap again to add more.
5. Type quick **condition notes**.
6. Wait for the green **Location locked** indicator (or submit anyway — it'll retry GPS).
7. Tap **Submit evidence** → then **Mark inspection complete**. Done.

## Offline?

If you lose signal, the app **saves your evidence on the phone** and sends it automatically
when you're back online. The yellow "N queued" badge shows what's waiting.

## For the API team

Endpoints consumed (see repo root for the server):

- `GET /contractor/:contractorId/jobs` → `[{id, address, type, notes, ...}]` or `{jobs:[...]}`
- `POST /orders/:id/evidence` (multipart): `photos[]`, `notes`, `lat`, `lng`, `inspectorId`, `capturedAt`
- `POST /orders/:id/complete` (JSON): `{inspectorId}`

API base defaults to the same origin; override on the sign-in screen (Advanced) or via
`?api=https://api.example.com`. Manual job-code entry is available if the jobs endpoint
isn't reachable.
