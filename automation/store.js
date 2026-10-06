"use strict";
/**
 * store.js — file-backed order store (MVP).
 *
 * Interface is deliberately small so the backend agent can swap in a real
 * database later without touching dispatch/report/billing:
 *   createOrder(data) -> order
 *   getOrder(id) -> order | null
 *   listOrders(predicate?) -> order[]
 *   updateOrder(id, patch, event, detail) -> order
 *   recordEvent(id, event, detail) -> order
 *   markEventProcessed(eventId) -> boolean (true if newly processed)
 *
 * Writes are atomic (tmp file + rename). Every mutation appends to history.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

const ORDERS_FILE = path.join(config.dataDir, "orders.json");
const EVENTS_FILE = path.join(config.dataDir, "processed-events.json");

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.reportsDir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  ensureDir();
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function loadOrders() {
  return readJson(ORDERS_FILE, {});
}

function saveOrders(orders) {
  writeJsonAtomic(ORDERS_FILE, orders);
}

function createOrder(data) {
  ensureDir();
  const orders = loadOrders();
  const id = data.id || newId("ord");
  if (orders[id]) throw new Error("order already exists: " + id);
  const order = {
    id,
    status: "pending",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    customer: data.customer || {},
    property: data.property || {},
    inspectionType: data.inspectionType || "insurance",
    priceCents:
      typeof data.priceCents === "number" ? data.priceCents : config.priceCents,
    currency: data.currency || config.currency,
    payment: { status: "unpaid", intentId: null, paidAt: null },
    contractor: null,
    inspection: null,
    proof: null,
    report: null,
    history: [{ at: nowIso(), event: "order.created", detail: "Order created" }],
  };
  orders[id] = order;
  saveOrders(orders);
  return order;
}

function getOrder(id) {
  const orders = loadOrders();
  return orders[id] || null;
}

function listOrders(predicate) {
  const orders = Object.values(loadOrders());
  return predicate ? orders.filter(predicate) : orders;
}

function updateOrder(id, patch, event, detail) {
  const orders = loadOrders();
  const order = orders[id];
  if (!order) throw new Error("order not found: " + id);
  Object.assign(order, patch);
  order.updatedAt = nowIso();
  if (event) {
    order.history.push({ at: nowIso(), event, detail: detail || "" });
  }
  saveOrders(orders);
  return order;
}

function recordEvent(id, event, detail) {
  return updateOrder(id, {}, event, detail);
}

/** Idempotency guard for webhooks. Returns true if this is the first time. */
function markEventProcessed(eventId) {
  const seen = readJson(EVENTS_FILE, {});
  if (seen[eventId]) return false;
  seen[eventId] = nowIso();
  writeJsonAtomic(EVENTS_FILE, seen);
  return true;
}

module.exports = {
  createOrder,
  getOrder,
  listOrders,
  updateOrder,
  recordEvent,
  markEventProcessed,
  ensureDir,
};
