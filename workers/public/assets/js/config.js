/* Proof Inspections — API integration config.
 *
 * SINGLE INTEGRATION POINT.
 *
 * By default the frontend talks to the same origin it was served from
 * (relative paths like "/orders"). The API is expected to serve these
 * static files itself, or the files may be served from a CDN with the
 * API on a known host.
 *
 * To point the frontend at a different API host, set before loading
 * order.js / track.js:
 *
 *     <script>window.PROOF_API_BASE = "https://api.example.com";</script>
 *
 * API contract (implemented by the backend, built in parallel):
 *   POST /orders
 *     body: { propertyAddress, inspectionType, customerName, customerEmail, customerPhone, notes? }
 *     -> 201 { id, status }
 *   GET /orders/:id
 *     -> 200 {
 *            id, status, propertyAddress, inspectionType,
 *            customerName, customerEmail, createdAt,
 *            proofBundleUrl?, reportUrl?, digest?,
 *            timeline?: [{ stage, at }]
 *          }
 *
 * Status values are normalized client-side (see track.js STAGES), so the
 * backend may use any reasonable naming; the listed labels are preferred:
 *   ordered -> inspector_dispatched -> inspection_complete -> report_ready
 */
(function () {
  var base = (window.PROOF_API_BASE || "").replace(/\/+$/, "");
  window.PROOF_API = {
    base: base,
    url: function (path) {
      return base + (path.charAt(0) === "/" ? path : "/" + path);
    },
  };
})();
