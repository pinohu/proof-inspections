"use strict";
/**
 * dispatch.js — assign pending orders to contractors (round-robin).
 *
 * Rules:
 *  - Only contractors with active !== false are eligible.
 *  - If a contractor lists areas, the property's state/zip must match;
 *    empty areas = serves anywhere.
 *  - Round-robin cursor persists in data/dispatch-state.json so assignments
 *    spread evenly across restarts.
 *  - Dispatch is idempotent: an already-dispatched order is a no-op.
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");
const audit = require("./audit");
const notify = require("./notify");

const STATE_FILE = path.join(config.dataDir, "dispatch-state.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function loadContractors() {
  const doc = readJson(config.contractorsPath, { contractors: [] });
  const list = Array.isArray(doc) ? doc : doc.contractors || [];
  return list.filter((c) => c && c.active !== false);
}

function areaMatches(contractor, property) {
  const areas = contractor.areas || [];
  if (areas.length === 0) return true;
  const state = (property.state || "").toUpperCase();
  const zip = String(property.zip || "");
  return areas.some((a) => {
    if (a.state && a.state.toUpperCase() !== state) return false;
    if (a.zipPrefixes && a.zipPrefixes.length > 0) {
      return a.zipPrefixes.some((p) => zip.startsWith(String(p)));
    }
    return true;
  });
}

/** Round-robin pick among eligible contractors for this order's property. */
function pickContractor(order) {
  const eligible = loadContractors().filter((c) => areaMatches(c, order.property || {}));
  if (eligible.length === 0) return null;
  const state = readJson(STATE_FILE, { cursor: 0 });
  const idx = state.cursor % eligible.length;
  const chosen = eligible[idx];
  state.cursor = (state.cursor + 1) % Number.MAX_SAFE_INTEGER;
  writeJsonAtomic(STATE_FILE, state);
  return chosen;
}

/**
 * Dispatch an order to a contractor. Idempotent.
 * Returns { ok, contractor?, reason? }.
 */
function dispatchOrder(store, orderId) {
  const order = store.getOrder(orderId);
  if (!order) return { ok: false, reason: "order not found" };
  if (order.status === "dispatched") return { ok: true, contractor: order.contractor, reason: "already dispatched" };
  if (!["paid", "pending"].includes(order.status)) {
    return { ok: false, reason: "order not dispatchable in status " + order.status };
  }
  if (config.payBeforeDispatch && order.status !== "paid") {
    return { ok: false, reason: "awaiting payment (PAY_BEFORE_DISPATCH=true)" };
  }

  const contractor = pickContractor(order);
  if (!contractor) {
    audit.log("dispatch.failed", orderId, "no eligible contractor");
    store.recordEvent(orderId, "dispatch.failed", "No eligible contractor available");
    return { ok: false, reason: "no eligible contractor" };
  }

  store.updateOrder(
    orderId,
    {
      status: "dispatched",
      contractor: {
        id: contractor.id,
        name: contractor.name,
        phone: contractor.phone,
        email: contractor.email,
        dispatchedAt: new Date().toISOString(),
      },
    },
    "order.dispatched",
    `Assigned to ${contractor.name} (${contractor.id})`
  );
  audit.log("dispatch.ok", orderId, `contractor=${contractor.id} name=${contractor.name}`);
  notify.notifyContractor(contractor, store.getOrder(orderId));
  notify.notifyCustomer(store.getOrder(orderId), "dispatched");
  return { ok: true, contractor };
}

module.exports = { dispatchOrder, pickContractor, loadContractors, areaMatches };
