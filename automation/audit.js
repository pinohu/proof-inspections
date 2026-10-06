"use strict";
/**
 * audit.js — append-only audit log for every automated action.
 *
 * One JSON object per line in data/audit.log. This is the paper trail:
 * dispatch decisions, payment events, report generation, deliveries.
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");

const AUDIT_FILE = path.join(config.dataDir, "audit.log");

function log(action, orderId, detail) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action,
      orderId: orderId || null,
      detail: detail === undefined ? null : detail,
    });
    fs.appendFileSync(AUDIT_FILE, line + "\n", "utf8");
  } catch (e) {
    // Audit must never break the business loop; surface loudly instead.
    console.error("[audit] FAILED to write audit log:", e.message);
  }
  console.log(`[audit] ${action}${orderId ? " " + orderId : ""}${detail ? " — " + detail : ""}`);
}

module.exports = { log };
