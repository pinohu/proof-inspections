/* Proof Inspections — order tracking.
 * GETs /orders/:id per the API contract (see assets/js/config.js).
 *
 * The order ID is read from (in order of preference):
 *   1. path segment: /track/:id   (backend should route this to track.html)
 *   2. query param:   /track?id=:id  or  /track.html?id=:id
 *   3. sessionStorage "proof_last_order" (set right after ordering)
 *   4. the manual lookup form on the page
 *
 * For UI testing without a backend: /track?demo=1 renders sample data.
 */
(function () {
  "use strict";

  var content = document.getElementById("track-content");
  var lookupForm = document.getElementById("track-lookup");
  var idInput = document.getElementById("track-id-input");

  // Stage definitions: ordered -> dispatched -> inspected -> report ready.
  // Labels are normalized (lowercased, non-alphanumerics stripped) and
  // matched loosely so the backend can use its own status vocabulary.
  var STAGES = [
    {
      key: "ordered",
      title: "Order received",
      desc: "Your inspection order is in the queue.",
      labels: ["ordered", "pending", "created", "received", "new", "confirmed"],
    },
    {
      key: "dispatched",
      title: "Inspector dispatched",
      desc: "A licensed inspector has been assigned and scheduled.",
      labels: ["dispatched", "inspectordispatched", "assigned", "scheduled", "inprogress", "inspectorassigned"],
    },
    {
      key: "inspected",
      title: "Inspection complete",
      desc: "The property has been documented and the evidence is being sealed.",
      labels: ["inspectioncomplete", "inspected", "completed", "complete", "sealed", "sealing"],
    },
    {
      key: "report_ready",
      title: "Report ready",
      desc: "Your verified report and proof bundle are available below.",
      labels: ["reportready", "delivered", "done", "closed", "ready"],
    },
  ];

  var STAGE_ICONS = {
    ordered:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
    dispatched:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/></svg>',
    inspected:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    report_ready:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
  };

  function normStatus(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function stageIndex(status) {
    var n = normStatus(status);
    for (var i = STAGES.length - 1; i >= 0; i--) {
      if (STAGES[i].labels.indexOf(n) !== -1) return i;
    }
    return 0; // unknown -> first stage
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  }

  function typeLabel(t) {
    var map = {
      insurance: "Insurance",
      "pre-listing": "Pre-listing",
      "rental-turnover": "Rental turnover",
      "storm-damage": "Storm damage",
      general: "General condition",
    };
    return map[t] || (t ? String(t).replace(/-/g, " ") : "—");
  }

  function currentId() {
    // 1. /track/:id
    var m = window.location.pathname.match(/\/track\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    // 2. ?id=
    var q = new URLSearchParams(window.location.search);
    if (q.get("id")) return q.get("id");
    // 3. sessionStorage (just ordered)
    try {
      var last = sessionStorage.getItem("proof_last_order");
      if (last) return last;
    } catch (e) {}
    return null;
  }

  function demoOrder(id) {
    return {
      id: id,
      status: "report_ready",
      propertyAddress: "123 W 8th St, Erie, PA 16502",
      inspectionType: "insurance",
      customerName: "Demo Customer",
      createdAt: new Date(Date.now() - 3 * 864e5).toISOString(),
      proofBundleUrl: "#demo-proof-bundle",
      reportUrl: "#demo-report",
      digest: "sha256:9f2c4a7e1b5d8f03a6c2e9d4b7f1a83c5e6d2b409f7a1c3e5d689b4f2a7c1e3d5",
      timeline: [
        { stage: "ordered", at: new Date(Date.now() - 3 * 864e5).toISOString() },
        { stage: "dispatched", at: new Date(Date.now() - 2 * 864e5).toISOString() },
        { stage: "inspection_complete", at: new Date(Date.now() - 864e5).toISOString() },
        { stage: "report_ready", at: new Date(Date.now() - 36e5).toISOString() },
      ],
      _demo: true,
    };
  }

  function renderLoading(id) {
    content.innerHTML =
      '<div class="timeline-card"><div class="empty-state">' +
      '<div class="state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
      "<p>Looking up order <strong>" + esc(id) + "</strong>…</p></div></div>";
  }

  function renderEmpty() {
    content.innerHTML =
      '<div class="timeline-card"><div class="empty-state">' +
      '<div class="state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>' +
      "<h3 style=\"margin:0 0 8px;color:var(--ink)\">No order selected</h3>" +
      "<p>Enter your order ID above — you'll find it in your confirmation email.</p></div></div>";
  }

  function renderError(id, message) {
    content.innerHTML =
      '<div class="timeline-card"><div class="error-state">' +
      '<div class="state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
      "<h3 style=\"margin:0 0 8px\">We couldn't find that order</h3>" +
      "<p style=\"color:var(--muted)\">" + esc(message || "") + "</p>" +
      "<p style=\"color:var(--muted);font-size:14px\">Double-check the order ID from your confirmation email, or place a new order.</p>" +
      '<p><a class="btn btn-secondary" href="/#order">Order an inspection</a></p></div></div>';
  }

  function timelineAt(order, stageKey) {
    if (Array.isArray(order.timeline)) {
      for (var i = 0; i < order.timeline.length; i++) {
        var t = order.timeline[i];
        if (normStatus(t.stage) === normStatus(stageKey)) return t.at;
      }
    }
    return null;
  }

  function renderOrder(order) {
    var idx = stageIndex(order.status);
    var isTerminal = idx >= STAGES.length - 1;

    var tl = STAGES.map(function (s, i) {
      var cls = i < idx ? "done" : i === idx ? "current" : "todo";
      var at = timelineAt(order, s.key) || (i === 0 ? order.createdAt : null);
      return (
        '<li class="' + cls + '">' +
        '<span class="tl-dot">' + (STAGE_ICONS[s.key] || "") + "</span>" +
        '<div class="tl-body"><h4>' + esc(s.title) + "</h4>" +
        "<p>" + esc(s.desc) + "</p>" +
        (at ? '<div class="tl-time">' + esc(fmtDate(at)) + "</div>" : "") +
        "</div></li>"
      );
    }).join("");

    var pillCls = isTerminal ? "live" : "wait";
    var pillTxt = isTerminal ? "Report ready" : STAGES[idx].title;

    var details =
      '<div class="detail-card"><div class="detail-grid">' +
      detailItem("Order ID", '<span style="font-family:var(--mono)">' + esc(order.id) + "</span>") +
      detailItem("Status", '<span class="status-pill ' + pillCls + '"><span class="pulse"></span>' + esc(pillTxt) + "</span>") +
      detailItem("Property", esc(order.propertyAddress)) +
      detailItem("Inspection type", esc(typeLabel(order.inspectionType))) +
      detailItem("Ordered", esc(fmtDate(order.createdAt) || "—")) +
      detailItem("Customer", esc(order.customerName || "—")) +
      "</div></div>";

    var proof = "";
    if (isTerminal) {
      var bundleBtn = order.proofBundleUrl
        ? '<a class="btn btn-primary" href="' + esc(order.proofBundleUrl) + '" target="_blank" rel="noopener">Open proof bundle</a>'
        : "";
      var reportBtn = order.reportUrl
        ? '<a class="btn btn-secondary" href="' + esc(order.reportUrl) + '" target="_blank" rel="noopener" download>Download report (PDF)</a>'
        : "";
      var digestRow = order.digest
        ? '<div class="digest-row"><span class="lbl">Digest</span><code>' + esc(order.digest) + "</code></div>"
        : "";
      if (bundleBtn || reportBtn || order.digest) {
        proof =
          '<div class="proof-card-box"><div class="proof-box">' +
          '<h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>Your verified proof</h3>' +
          "<p>The inspection evidence is sealed. Download the signed report, or open the full proof bundle to inspect every signed photo and verify the digest yourself.</p>" +
          digestRow +
          '<div class="proof-actions">' + bundleBtn + reportBtn + "</div>" +
          "</div></div>";
      }
    }

    var demoNote = order._demo
      ? '<div class="form-alert info show" style="margin-bottom:24px">Demo preview — sample data shown because <code>?demo=1</code> is set. Connect the API for live orders.</div>'
      : "";

    content.innerHTML =
      demoNote +
      '<div class="timeline-card"><h2 style="margin:0 0 22px;font-size:21px;letter-spacing:-0.02em">Inspection progress</h2>' +
      '<ol class="timeline">' + tl + "</ol></div>" +
      details +
      proof;

    // Keep the status fresh while the order is still in flight.
    if (!isTerminal && !order._demo) {
      setTimeout(function () { loadOrder(order.id, true); }, 30000);
    }
  }

  function detailItem(k, vHtml) {
    return '<div class="detail-item"><div class="k">' + esc(k) + '</div><div class="v">' + vHtml + "</div></div>";
  }

  var pollTimer = null;

  function loadOrder(id, isPoll) {
    if (!isPoll) renderLoading(id);
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }

    var q = new URLSearchParams(window.location.search);
    if (q.get("demo") === "1") {
      renderOrder(demoOrder(id));
      return;
    }

    fetch(window.PROOF_API.url("/orders/" + encodeURIComponent(id)), {
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        if (res.status === 404) {
          var e = new Error("not_found");
          e.notFound = true;
          throw e;
        }
        if (!res.ok) throw new Error("Server returned " + res.status + ".");
        return res.json();
      })
      .then(function (order) {
        if (!order || !order.id) throw new Error("Unexpected response from server.");
        renderOrder(order);
        var idx = stageIndex(order.status);
        if (idx < STAGES.length - 1) {
          pollTimer = setTimeout(function () { loadOrder(order.id, true); }, 30000);
        }
      })
      .catch(function (err) {
        if (err && err.notFound) {
          renderError(id, 'No order found with ID "' + id + '".');
        } else {
          content.innerHTML =
            '<div class="timeline-card"><div class="error-state">' +
            '<div class="state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>' +
            "<h3 style=\"margin:0 0 8px\">Something went wrong</h3>" +
            "<p style=\"color:var(--muted)\">" + esc(err && err.message ? err.message : "Unknown error") + "</p>" +
            '<p><button class="btn btn-secondary" id="track-retry">Try again</button></p></div></div>';
          var retry = document.getElementById("track-retry");
          if (retry) retry.addEventListener("click", function () { loadOrder(id); });
        }
      });
  }

  lookupForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = idInput.value.trim();
    if (!id) return;
    try {
      history.replaceState(null, "", "/track/" + encodeURIComponent(id));
    } catch (err) {}
    loadOrder(id);
  });

  var id = currentId();
  if (id) {
    idInput.value = id;
    loadOrder(id);
  } else {
    // Also honor ?demo=1 with no id
    var q = new URLSearchParams(window.location.search);
    if (q.get("demo") === "1") loadOrder("pi_demo123");
    else renderEmpty();
  }
})();
