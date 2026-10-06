"use strict";
/**
 * notify.js — outbound notifications.
 *
 * MVP mode is "stub": every notification is logged to console + audit trail.
 * To go live, implement the real providers behind the same function
 * signatures and set NOTIFY_MODE=live:
 *   TODO(live): Twilio for SMS  — https://www.twilio.com/docs/sms
 *   TODO(live): Emailit for email — provider already used by the org
 */
const audit = require("./audit");
const config = require("./config");

function stub(kind, to, subject, body) {
  console.log(`[notify:${kind}] to=${to} subject=${JSON.stringify(subject)}`);
  console.log(`[notify:${kind}] body:\n${body}\n---`);
  audit.log("notify." + kind, null, `to=${to} subject=${subject}`);
}

function notifyContractor(contractor, order) {
  const body =
    `New inspection assignment — ${config.businessName}\n` +
    `Order: ${order.id}\n` +
    `Property: ${order.property.address || ""}, ${order.property.city || ""} ${order.property.state || ""} ${order.property.zip || ""}\n` +
    `Type: ${order.inspectionType}\n` +
    `Customer: ${order.customer.name || ""} ${order.customer.phone || ""}\n` +
    `Capture photos + GPS notes in the inspection app, then submit to complete.`;
  if (config.notifyMode === "live") {
    // TODO(live): send via Twilio (SMS to contractor.phone) and/or Emailit (contractor.email)
    stub("contractor.live-todo", contractor.phone || contractor.email, "New inspection assignment", body);
  } else {
    stub("contractor.sms", contractor.phone, "New inspection assignment", body);
  }
}

function notifyCustomer(order, kind, extra) {
  const to = order.customer.email || order.customer.phone || "unknown";
  const subjects = {
    payment_confirmed: "Payment confirmed — inspection scheduled",
    dispatched: "Your inspection has been assigned",
    report_ready: "Your inspection report is ready",
  };
  const body =
    `${subjects[kind] || kind} — ${config.businessName}\n` +
    `Order: ${order.id}\n` +
    `Property: ${order.property.address || ""}\n` +
    (extra || "");
  if (config.notifyMode === "live") {
    // TODO(live): send via Emailit (customer.email) / Twilio (customer.phone)
    stub("customer.live-todo", to, subjects[kind] || kind, body);
  } else {
    stub("customer." + kind, to, subjects[kind] || kind, body);
  }
}

module.exports = { notifyContractor, notifyCustomer };
