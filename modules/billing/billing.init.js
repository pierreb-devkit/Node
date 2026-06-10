/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import config from '../../config/index.js';
import AnalyticsService from '../../lib/services/analytics.js';
import logger from '../../lib/services/logger.js';
import billingEvents from './lib/events.js';
import invitationEvents from '../invitations/lib/events.js';
import BillingUsageRepository from './repositories/billing.usage.repository.js';
import { getAlertThresholdPercents } from './lib/billing.constants.js';
import { setupBillingEmails } from './billing.email.js';

/**
 * Billing module initialisation.
 * Wires cross-module integrations that depend on services from lib.
 *
 * @param {import('express').Application} app - Express application instance
 * @returns {Promise<void>}
 */
// eslint-disable-next-line no-unused-vars
export default async (app) => {
  // Warn at startup if any pack is missing a valid priceUsd — refundPartial fallback will be inaccurate
  if (config.billing?.packs?.length) {
    for (const pack of config.billing.packs) {
      if (typeof pack.priceUsd !== 'number' || pack.priceUsd <= 0) {
        logger.warn(`[billing] pack '${pack.packId}' missing valid priceUsd; refundPartial fallback will be inaccurate`);
      }
    }
  }

  // Validate alert threshold percents (meterMode only) — warn on configured values with no schema field.
  // Only 80 and 100 have matching alertedAtN fields in BillingUsage; other values are silently skipped.
  if (config?.billing?.meterMode) {
    const SUPPORTED_THRESHOLD_PERCENTS = new Set([80, 100]);
    for (const threshold of getAlertThresholdPercents()) {
      if (!SUPPORTED_THRESHOLD_PERCENTS.has(threshold)) {
        logger.warn(
          `[billing] Configured alert threshold ${threshold}% is not in schema-supported set [80, 100] — alert will be silently skipped`,
        );
      }
    }
  }

  // Wire billing email listeners (quota warnings + payment-failed notifications).
  setupBillingEmails();

  // Referral substrate (#5) — billing is an OPTIONAL consumer of the invitations
  // fire-and-forget `invitation.accepted` event (dependency direction billing →
  // invitations is fine: billing imports the events singleton, invitations never
  // imports billing). This listener is a deliberate NO-OP that only PROVES the event
  // seam works end-to-end (the payload arrives here on every invite acceptance); the
  // actual credit-grant logic lands in #5. Wrapped so a future grant impl can't crash
  // boot/signup. Mirrors the other cross-module listeners wired on this init.
  // eslint-disable-next-line no-unused-vars
  invitationEvents.on('invitation.accepted', (payload) => {
    // TODO(#5): grant referral credits to payload.invitedBy (skip when invitedBy is null).
    // No-op for P8a — the seam is the deliverable, not the grant.
  });

  // Update analytics group properties when a subscription plan changes
  billingEvents.on('plan.changed', ({ organizationId, newPlan }) => {
    try {
      AnalyticsService.groupIdentify('company', String(organizationId), { plan: newPlan });
    } catch (err) {
      logger.warn('[billing] analytics groupIdentify failed (non-fatal)', { error: err?.message ?? String(err) });
    }
  });

  // Ops alerting — real-money events that require immediate human review.
  //
  // NOTE: devkit has no ntfy helper; the structured logger is the alert sink here.
  // Downstream projects (e.g. trawl_node) wire the actual ntfy push by re-listening
  // on the same billingEvents singleton and calling their own ntfy service.
  // Priority annotations below document the intended ntfy priority for downstream use.

  // billing.dispute.opened — priority 5 (urgent): 7-day evidence window starts now.
  // Downstream projects (e.g. trawl_node) re-listen on billingEvents for ntfy push.
  billingEvents.on('billing.dispute.opened', (payload) => {
    const { disputeId, chargeId, organizationId, stripeSessionId, amount, reason } = payload;
    logger.error('[billing.init] ALERT: dispute opened — 7-day evidence window — manual review required', {
      disputeId,
      chargeId,
      organizationId,
      stripeSessionId,
      amount,
      reason,
      ntfyPriority: 5,
    });
  });

  // billing.dispute.lost — priority 5 (urgent): funds withdrawn, ledger already debited.
  billingEvents.on('billing.dispute.lost', (payload) => {
    const { disputeId, chargeId, organizationId, stripeSessionId, amount } = payload;
    logger.error('[billing.init] ALERT: dispute lost — funds withdrawn — ledger debited', {
      disputeId,
      chargeId,
      organizationId,
      stripeSessionId,
      amount,
      ntfyPriority: 5,
    });
  });

  // billing.refund.unresolved — priority 4 (high): unresolvable refund needs manual reconciliation.
  billingEvents.on('billing.refund.unresolved', (payload) => {
    logger.error('[billing.init] ALERT: refund unresolved — manual reconciliation required', {
      ...payload,
      ntfyPriority: 4,
    });
  });

  // billing.reconciliation.divergence — priority 4 (high): DB vs Stripe plan/status mismatch.
  billingEvents.on('billing.reconciliation.divergence', (payload) => {
    const { organizationId, subscriptionId, stripeSubscriptionId, db, stripe, statusMismatch, planMismatch } = payload;
    logger.error('[billing.init] ALERT: reconciliation divergence — DB vs Stripe mismatch', {
      organizationId,
      subscriptionId,
      stripeSubscriptionId,
      db,
      stripe,
      statusMismatch,
      planMismatch,
      ntfyPriority: 4,
    });
  });

  // Prevent accidental crash if any future code emits 'error' with no listener
  // (Node default behaviour: throws if no 'error' listener is registered).
  // Registered here (after config is ready) so events.js stays config-free and importable without ordering hazards.
  billingEvents.on('error', (err) => {
    logger.error('[billingEvents] uncaught error event', { err });
  });

  // Boot validator: check for legacy migration state before enabling meterMode.
  if (config?.billing?.meterMode) {
    const legacyUsageCount = await BillingUsageRepository.countLegacyConsumedHistoryIds();
    if (legacyUsageCount > 0) {
      throw new Error(
        `[billing] legacy consumedHistoryIds field still present on ${legacyUsageCount} usage document(s); run migration 20260502100000-rename-consumed-history-ids-to-attribution-keys before enabling meterMode`,
      );
    }

    // Boot validator: warn on orphaned Subscription.plan values (meterMode only).
    // Never crashes boot — wrapped in try/catch.
    try {
      const Subscription = mongoose.model('Subscription');
      const knownPlans = new Set(config.billing.plans ?? []);
      const distinctPlans = await Subscription.distinct('plan');
      for (const plan of distinctPlans) {
        if (!knownPlans.has(plan)) {
          logger.warn(`[billing] Subscription.plan value "${plan}" not in planDefinitions — orphaned plan, may resolve quota=0`);
        }
      }
    } catch (err) {
      logger.warn('[billing] Subscription.plan boot validator failed (non-fatal)', { error: err?.message ?? String(err) });
    }
  }
};
