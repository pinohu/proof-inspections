"use strict";
/**
 * lifecycle.js — the self-running loop.
 *
 * Order states: pending -> paid -> dispatched -> inspected -> verified
 *                -> reported -> delivered
 * (with PAY_BEFORE_DISPATCH=false, dispatch can happen from pending.)
 *
 * Two ways to drive it:
 *  1. Event-driven (preferred): the API calls these functions directly from
 *     its handlers — createPaymentIntent on order creation, dispatchOrder on
 *     payment confirmation, submitInspection on contractor submission.
 *  2. Poller (safety net): `node lifecycle.js` ticks every POLL_INTERVAL_MS
 *     and advances any order that is stuck, so nothing ever needs a human.
 */
const config = require("./config");
const audit = require("./audit");
const dispatch = require("./dispatch");
const proof = require("./proof");
const report = require("./report");
const notify = require("./notify");
const billing = require("./billing");

/**
 * Contractor/app submits completed inspection evidence.
 * inspection = { inspectorId, completedAt, gps:{lat,lng}, notes, photos:[{localPath?,file?,caption?,sha256?,capturedAt?}] }
 */
function submitInspection(store, orderId, inspection) {
  const order = store.getOrder(orderId);
  if (!order) throw new Error("order not found: " + orderId);
  if (!["dispatched", "paid", "pending"].includes(order.status)) {
    throw new Error(`order ${orderId} cannot accept inspection in status ${order.status}`);
  }
  if (!inspection || !inspection.inspectorId) {
    throw new Error("inspection.inspectorId is required");
  }
  const normalized = {
    inspectorId: inspection.inspectorId,
    completedAt: inspection.completedAt || new Date().toISOString(),
    gps: inspection.gps || null,
    notes: inspection.notes || "",
    photos: Array.isArray(inspection.photos) ? inspection.photos : [],
  };
  store.updateOrder(orderId, { status: "inspected", inspection: normalized },
    "inspection.submitted", `inspector=${normalized.inspectorId} photos=${normalized.photos.length}`);
  audit.log("inspection.submitted", orderId, `photos=${normalized.photos.length}`);
  return store.getOrder(orderId);
}

/** Compute the cryptographic proof over the inspection evidence. */
function verifyOrder(store, orderId) {
  const order = store.getOrder(orderId);
  if (!order) throw new Error("order not found: " + orderId);
  if (order.status !== "inspected") throw new Error(`order ${orderId} not ready to verify (status ${order.status})`);
  const p = proof.computeProof(order);
  store.updateOrder(orderId, { status: "verified", proof: p },
    "evidence.verified", `sha256=${p.hash.slice(0, 16)}…`);
  audit.log("evidence.verified", orderId, `hash=${p.hash}`);
  return store.getOrder(orderId);
}

/** Generate the PDF report and notify the customer (delivery). */
async function deliverReport(store, orderId) {
  let order = store.getOrder(orderId);
  if (!order) throw new Error("order not found: " + orderId);
  if (order.status === "delivered") return { ok: true, reason: "already delivered" };
  if (!["verified", "reported"].includes(order.status)) {
    throw new Error(`order ${orderId} not ready to deliver (status ${order.status})`);
  }
  const pdfPath = await report.generateReport(store, orderId);
  order = store.getOrder(orderId);
  store.updateOrder(orderId, { status: "reported" }, "report.ready", "pdf=" + pdfPath);
  notify.notifyCustomer(order, "report_ready",
    `Download: /reports/${order.id}.pdf\nProof hash: ${order.proof.hash}\n`);
  store.updateOrder(orderId, { status: "delivered" }, "report.delivered", "customer notified");
  audit.log("report.delivered", orderId, "pdf=" + pdfPath);
  return { ok: true, path: pdfPath };
}

/** Advance one order as far as the automation can take it. */
async function advanceOrder(store, orderId) {
  let order = store.getOrder(orderId);
  if (!order || ["delivered", "cancelled", "failed"].includes(order.status)) return;

  // pending -> ensure a payment intent exists so the customer can pay
  if (order.status === "pending" && !order.payment.intentId) {
    try {
      await billing.createPaymentIntent(store, orderId);
    } catch (e) {
      // Missing Stripe key in dev is fine; the order waits for payment anyway.
      audit.log("payment.intent_skipped", orderId, e.message);
    }
    order = store.getOrder(orderId);
  }

  // pending/paid -> dispatched (payment-gated by config)
  if (["pending", "paid"].includes(order.status) && !order.contractor) {
    const res = dispatch.dispatchOrder(store, orderId);
    if (!res.ok) audit.log("lifecycle.dispatch_wait", orderId, res.reason);
    order = store.getOrder(orderId);
  }

  // inspected -> verified -> reported -> delivered
  if (order.status === "inspected") {
    verifyOrder(store, orderId);
    order = store.getOrder(orderId);
  }
  if (["verified", "reported"].includes(order.status)) {
    await deliverReport(store, orderId);
  }
}

/** One poller pass over every open order. */
async function tick(store) {
  const open = store.listOrders((o) => !["delivered", "cancelled", "failed"].includes(o.status));
  for (const o of open) {
    try {
      await advanceOrder(store, o.id);
    } catch (e) {
      audit.log("lifecycle.error", o.id, e.message);
    }
  }
}

function runPoller(store) {
  audit.log("poller.start", null, `interval=${config.pollIntervalMs}ms payBeforeDispatch=${config.payBeforeDispatch}`);
  console.log(`[lifecycle] poller started — every ${config.pollIntervalMs}ms`);
  const loop = async () => {
    try { await tick(store); } catch (e) { console.error("[lifecycle] tick failed:", e.message); }
  };
  loop();
  const timer = setInterval(loop, config.pollIntervalMs);
  const stop = () => { clearInterval(timer); audit.log("poller.stop", null, "shutting down"); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

module.exports = { submitInspection, verifyOrder, deliverReport, advanceOrder, tick, runPoller };

// `node lifecycle.js` -> run the poller (safety net mode)
if (require.main === module) {
  const store = require("./store");
  runPoller(store);
}
