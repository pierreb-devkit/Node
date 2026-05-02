/**
 * Module dependencies
 */
import BillingMeterOutboxRepository from '../repositories/billing.meter.outbox.repository.js';
import BillingExtraService from './billing.extra.service.js';
import billingEvents from '../lib/events.js';

/**
 * @function emitExhausted
 * @description Emit the alert event for an outbox row that exhausted retries.
 *              Listener exceptions are swallowed so observer failures cannot affect
 *              retry accounting (markFailedAttempt must not be called a second time
 *              due to a misbehaving listener).
 * @param {Object} row - Original pending outbox row.
 * @param {Object} updated - Updated failed outbox row.
 * @returns {void}
 */
const emitExhausted = (row, updated) => {
  try {
    billingEvents.emit('billing.extras_debit.exhausted', {
      organizationId: String(row.organizationId),
      idempotencyKey: row.idempotencyKey,
      extrasUnits: row.extrasUnits,
      attempts: updated.attempts,
      lastError: updated.lastError,
    });
  } catch (evtErr) {
    // Listener errors must not disrupt outbox retry accounting — log for traceability
    console.error('[billing.outbox] billing.extras_debit.exhausted listener error (non-fatal):', evtErr?.message ?? evtErr);
  }
};

/**
 * @function retryPendingExtrasDebits
 * @description Retry pending extras debit outbox rows. Successful debits are
 *              committed; failed attempts are counted and rows move to failed
 *              after repository retry exhaustion.
 * @param {number} [thresholdMs=300000] - Retry threshold in milliseconds.
 * @param {number} [limit=100] - Maximum outbox rows to process.
 * @returns {Promise<{scanned: number, committed: number, failedAttempts: number, exhausted: number}>}
 */
// biome-ignore lint/correctness/useQwikValidLexicalScope: false positive — Node.js service, not Qwik
const retryPendingExtrasDebits = async (thresholdMs = 5 * 60 * 1000, limit = 100) => {
  const pendingRows = await BillingMeterOutboxRepository.findPendingDue(thresholdMs, limit);
  let committed = 0;
  let failedAttempts = 0;
  let exhausted = 0;

  for (const row of pendingRows) {
    try {
      const debitResult = await BillingExtraService.debit(
        String(row.organizationId),
        row.extrasUnits,
        row.idempotencyKey,
      );

      if (debitResult.applied) {
        await BillingMeterOutboxRepository.markCommitted(row._id);
        committed += 1;
        continue;
      }

      const updated = await BillingMeterOutboxRepository.markFailedAttempt(row._id, 'extras debit not applied');
      failedAttempts += 1;
      if (updated?.status === 'failed') {
        exhausted += 1;
        emitExhausted(row, updated);
      }
    } catch (err) {
      const updated = await BillingMeterOutboxRepository.markFailedAttempt(row._id, err);
      failedAttempts += 1;
      if (updated?.status === 'failed') {
        exhausted += 1;
        emitExhausted(row, updated);
      }
    }
  }

  return {
    scanned: pendingRows.length,
    committed,
    failedAttempts,
    exhausted,
  };
};

export default {
  retryPendingExtrasDebits,
};
