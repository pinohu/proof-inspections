/**
 * stripe-store-d1.js — D1 adapter for the stripe.js store interface.
 *
 * Requires the tables in schema-migration-payments.sql:
 *   order_payments (order_id PK, status, intent_id, amount_cents, currency, paid_at, updated_at)
 *   stripe_events  (id PK, type, received_at)
 *
 * Payment status lifecycle: unpaid -> requires_payment -> paid | failed
 */

export function d1PaymentStore(db) {
  return {
    async getOrderPayment(orderId) {
      const row = await db
        .prepare('SELECT * FROM order_payments WHERE order_id = ?')
        .bind(orderId)
        .first();
      if (!row) return null;
      return {
        status: row.status,
        intentId: row.intent_id,
        amountCents: row.amount_cents,
        currency: row.currency,
        paidAt: row.paid_at,
      };
    },

    async setOrderPayment(orderId, payment) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO order_payments (order_id, status, intent_id, amount_cents, currency, paid_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(order_id) DO UPDATE SET
             status = excluded.status,
             intent_id = COALESCE(excluded.intent_id, order_payments.intent_id),
             amount_cents = COALESCE(excluded.amount_cents, order_payments.amount_cents),
             currency = COALESCE(excluded.currency, order_payments.currency),
             paid_at = COALESCE(excluded.paid_at, order_payments.paid_at),
             updated_at = excluded.updated_at`,
        )
        .bind(
          orderId,
          payment.status,
          payment.intentId || null,
          payment.amountCents != null ? payment.amountCents : null,
          payment.currency || 'usd',
          payment.paidAt || null,
          now,
        )
        .run();
    },

    /** Returns true on first sighting, false for duplicates. */
    async markEventProcessed(eventId) {
      const now = new Date().toISOString();
      try {
        await db
          .prepare('INSERT INTO stripe_events (id, received_at) VALUES (?, ?)')
          .bind(eventId, now)
          .run();
        return true;
      } catch (e) {
        // UNIQUE constraint violation => duplicate delivery.
        if (/UNIQUE|unique|constraint/i.test(String(e && e.message))) return false;
        throw e;
      }
    },
  };
}
