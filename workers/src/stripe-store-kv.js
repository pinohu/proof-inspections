/**
 * stripe-store-kv.js — KV adapter for the stripe.js store interface.
 *
 * For deployments using a single KV namespace (instead of D1).
 * Key scheme:
 *   pay:order:{orderId}   -> JSON { status, intentId, amountCents, currency, paidAt }
 *   pay:event:{eventId}    -> "1" (with 24h TTL for idempotency)
 *
 * Payment status lifecycle: unpaid -> requires_payment -> paid | failed
 */

export function kvPaymentStore(kv) {
  return {
    async getOrderPayment(orderId) {
      const raw = await kv.get(`pay:order:${orderId}`, 'json');
      return raw || null;
    },

    async setOrderPayment(orderId, payment) {
      const existing = (await kv.get(`pay:order:${orderId}`, 'json')) || {};
      const merged = {
        status: payment.status,
        intentId: payment.intentId !== undefined ? payment.intentId : existing.intentId || null,
        amountCents: payment.amountCents !== undefined ? payment.amountCents : existing.amountCents || null,
        currency: payment.currency || existing.currency || 'usd',
        paidAt: payment.paidAt !== undefined ? payment.paidAt : existing.paidAt || null,
      };
      await kv.put(`pay:order:${orderId}`, JSON.stringify(merged));
    },

    /** Returns true on first sighting, false for duplicates. */
    async markEventProcessed(eventId) {
      const key = `pay:event:${eventId}`;
      const seen = await kv.get(key, 'text');
      if (seen) return false;
      // 24h TTL — long enough to catch Stripe retries, short enough to bound storage.
      await kv.put(key, '1', { expirationTtl: 86400 });
      return true;
    },
  };
}
