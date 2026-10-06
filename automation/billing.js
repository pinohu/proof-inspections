"use strict";
/**
 * billing.js — Stripe billing for inspection orders.
 *
 * Flow:
 *   createPaymentIntent(order)  -> Stripe PaymentIntent ($199 test mode),
 *                                  stores intent id on the order.
 *   POST /webhooks/stripe       -> handleStripeWebhook(rawBody, signature):
 *                                  verifies the signature, applies
 *                                  payment_intent.succeeded / payment_failed.
 *
 * The backend agent mounts the webhook: it MUST pass the raw request body
 * buffer (not parsed JSON) and the value of the `stripe-signature` header.
 * applyPaymentEvent() is exported separately so the core logic is testable
 * without Stripe credentials.
 */
const config = require("./config");
const audit = require("./audit");
const notify = require("./notify");

function getStripeClient(override) {
  if (override) return override;
  if (!config.stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is not set (test mode key expected)");
  }
  return require("stripe")(config.stripeSecretKey);
}

/**
 * Create a PaymentIntent for the order. Idempotent: reuses an existing
 * incomplete intent instead of creating duplicates.
 */
async function createPaymentIntent(store, orderId, stripeClient) {
  const order = store.getOrder(orderId);
  if (!order) throw new Error("order not found: " + orderId);
  if (order.payment.status === "paid") return { ok: true, reused: true, reason: "already paid" };
  if (order.payment.intentId && order.payment.status === "requires_payment") {
    return { ok: true, reused: true, intentId: order.payment.intentId };
  }
  const stripe = getStripeClient(stripeClient);
  const intent = await stripe.paymentIntents.create({
    amount: order.priceCents,
    currency: order.currency,
    metadata: { orderId: order.id, business: "proof-inspections" },
    description: `Property inspection ${order.id} — ${order.property.address || ""}`,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  });
  store.updateOrder(
    orderId,
    { payment: { status: "requires_payment", intentId: intent.id, paidAt: null } },
    "payment.intent_created",
    `intent=${intent.id} amount=${order.priceCents}`
  );
  audit.log("payment.intent_created", orderId, `intent=${intent.id}`);
  return { ok: true, intentId: intent.id, clientSecret: intent.client_secret };
}

/**
 * Core webhook logic — pure function of (store, event). Idempotent via
 * store.markEventProcessed. Returns { ok, action }.
 */
function applyPaymentEvent(store, event) {
  if (!store.markEventProcessed(event.id)) {
    return { ok: true, action: "duplicate_ignored" };
  }
  const type = event.type;
  const obj = event.data && event.data.object ? event.data.object : {};
  const orderId = (obj.metadata && obj.metadata.orderId) || null;

  if (type === "payment_intent.succeeded") {
    if (!orderId) {
      audit.log("payment.ignored", null, "succeeded without orderId metadata");
      return { ok: true, action: "ignored_no_order" };
    }
    const order = store.getOrder(orderId);
    if (!order) {
      audit.log("payment.orphan", orderId, "payment succeeded for unknown order");
      return { ok: true, action: "orphan" };
    }
    if (order.payment.status === "paid") {
      return { ok: true, action: "already_paid" };
    }
    store.updateOrder(
      orderId,
      { status: "paid", payment: { status: "paid", intentId: obj.id, paidAt: new Date().toISOString() } },
      "payment.succeeded",
      `intent=${obj.id} amount=${obj.amount_received}`
    );
    audit.log("payment.succeeded", orderId, `intent=${obj.id}`);
    notify.notifyCustomer(store.getOrder(orderId), "payment_confirmed");
    return { ok: true, action: "marked_paid" };
  }

  if (type === "payment_intent.payment_failed") {
    if (orderId && store.getOrder(orderId)) {
      store.recordEvent(orderId, "payment.failed", `intent=${obj.id}`);
      audit.log("payment.failed", orderId, `intent=${obj.id}`);
    } else {
      audit.log("payment.failed", orderId, `intent=${obj.id} (no matching order)`);
    }
    return { ok: true, action: "recorded_failure" };
  }

  return { ok: true, action: "unhandled_type" };
}

/**
 * Express-style webhook entry point.
 *   rawBody: Buffer of the raw request body (REQUIRED for signature check)
 *   signature: value of the `stripe-signature` request header
 */
function handleStripeWebhook(store, rawBody, signature, stripeClient) {
  const stripe = getStripeClient(stripeClient);
  if (!config.stripeWebhookSecret && !stripeClient) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set — cannot verify webhook signatures");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  } catch (e) {
    audit.log("payment.webhook_bad_sig", null, e.message);
    const err = new Error("webhook signature verification failed");
    err.statusCode = 400;
    throw err;
  }
  return applyPaymentEvent(store, event);
}

module.exports = { createPaymentIntent, applyPaymentEvent, handleStripeWebhook };
