/**
 * Build the event-ordering marker fields to merge into a direct-write update,
 * so a stale Stripe redelivery cannot overwrite the write via updateIfEventNewer.
 * Use ONLY in direct-write paths (admin overrides, dunning sweep, cancellation) —
 * normal webhook handlers go through updateIfEventNewer which sets these on its own.
 *
 * @param {'subscription'|'invoice'} family
 * @param {string} source - prefix for the synthesised event id (e.g. 'admin-bump', 'dunning')
 * @returns {Object} { last{Family}EventCreatedAt, last{Family}EventId }
 */
export const bumpEventMarkers = (family, source) => {
  const ms = Date.now();
  const fieldPrefix = family === 'invoice' ? 'lastInvoiceEvent' : 'lastSubscriptionEvent';
  return {
    [`${fieldPrefix}CreatedAt`]: Math.floor(ms / 1000),
    [`${fieldPrefix}Id`]: `~${source}-${ms}`,
  };
};
