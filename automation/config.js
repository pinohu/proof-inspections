"use strict";
/**
 * config.js — environment-driven configuration for the automation layer.
 *
 * All secrets come from environment variables. Nothing secret is committed.
 */
const path = require("path");

const AUTOMATION_DIR = __dirname;
const REPO_ROOT = path.resolve(AUTOMATION_DIR, "..");

function boolEnv(name, def) {
  const v = process.env[name];
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

module.exports = {
  automationDir: AUTOMATION_DIR,
  repoRoot: REPO_ROOT,

  businessName: process.env.BUSINESS_NAME || "Proof Inspections",

  // Billing
  priceCents: parseInt(process.env.INSPECTION_PRICE_CENTS || "19900", 10), // $199.00
  currency: (process.env.INSPECTION_CURRENCY || "usd").toLowerCase(),
  // When true (default), contractors are dispatched only after payment confirms.
  // When false, dispatch happens immediately on order creation (pay on delivery).
  payBeforeDispatch: boolEnv("PAY_BEFORE_DISPATCH", true),

  // Stripe — test mode keys expected; set by ops, never committed.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",

  // Paths
  reportsDir: process.env.REPORTS_DIR || path.join(REPO_ROOT, "reports"),
  dataDir: process.env.DATA_DIR || path.join(AUTOMATION_DIR, "data"),
  contractorsPath:
    process.env.CONTRACTORS_PATH || path.join(AUTOMATION_DIR, "contractors.json"),

  // Poller
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000", 10),

  // Notifications (stubs until Twilio/Emailit wired)
  notifyMode: process.env.NOTIFY_MODE || "stub", // stub | live
};
