/**
 * Migration: Slim BillingSubscription — drop currentPeriodEnd and cancelAtPeriodEnd.
 * These fields are now fetched on-demand from the Stripe API via fetchSubscriptionDetails().
 * stripeEventId is added for same-second event tiebreaker ordering (V5 P1 #2) — no migration
 * needed as it is optional and populated at the next webhook delivery.
 *
 * Safe to run multiple times (idempotent).
 */
export async function up() {
  const { default: mongoose } = await import('mongoose');
  const db = mongoose.connection.db;

  await db.collection('subscriptions').updateMany(
    {},
    {
      $unset: {
        currentPeriodEnd: '',
        cancelAtPeriodEnd: '',
      },
    },
  );

  console.info('[migration] slim-subscription-drop-period-fields: dropped currentPeriodEnd + cancelAtPeriodEnd');
}

/**
 * Down: no-op — dropped fields are re-populated by incoming webhooks.
 */
export function down() {
  console.warn('[migration] slim-subscription-drop-period-fields DOWN: no-op; fields will be re-populated by webhooks');
}
