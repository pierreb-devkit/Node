/**
 * Module dependencies
 */
import mongoose from 'mongoose';
import config from '../../config/index.js';
import AnalyticsService from '../../lib/services/analytics.js';
import billingEvents from './lib/events.js';
import BillingPlanService from './services/billing.plan.service.js';
import BillingUsageRepository from './repositories/billing.usage.repository.js';
import { getAlertThresholdPercents } from './lib/billing.constants.js';

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
        console.warn(`[billing] pack '${pack.packId}' missing valid priceUsd; refundPartial fallback will be inaccurate`);
      }
    }
  }

  // Validate alert threshold percents (meterMode only) — warn on configured values with no schema field.
  // Only 80 and 100 have matching alertedAtN fields in BillingUsage; other values are silently skipped.
  if (config?.billing?.meterMode) {
    const SUPPORTED_THRESHOLD_PERCENTS = new Set([80, 100]);
    for (const threshold of getAlertThresholdPercents()) {
      if (!SUPPORTED_THRESHOLD_PERCENTS.has(threshold)) {
        console.warn(
          `[billing] Configured alert threshold ${threshold}% is not in schema-supported set [80, 100] — alert will be silently skipped`,
        );
      }
    }
  }

  // Update analytics group properties when a subscription plan changes
  billingEvents.on('plan.changed', ({ organizationId, newPlan }) => {
    try {
      AnalyticsService.groupIdentify('company', String(organizationId), { plan: newPlan });
    } catch (err) {
      console.warn('[billing] analytics groupIdentify failed (non-fatal):', err?.message ?? err);
    }
  });

  try {
    const { seeded, skipped } = await BillingPlanService.ensureSeeded();
    if (seeded > 0) {
      console.info(`[billing] seeded ${seeded} plan(s) from config.billing.planDefinitions (skipped ${skipped} already active)`);
    }
  } catch (err) {
    console.error('[billing] ensureSeeded failed:', err);
    // Fail fast when meterMode is enabled: a seeding failure means quota resolution
    // will return 0 for all plans, silently gating all metered operations.
    // Surfacing the crash here prevents a deploy from succeeding in a broken state.
    if (config?.billing?.meterMode) throw err;
  }

  // Boot validator: warn on orphaned Subscription.plan values (meterMode only).
  // Runs after ensureSeeded so the plan catalog is up to date.
  // Never crashes boot — wrapped in try/catch.
  if (config?.billing?.meterMode) {
    const legacyUsageCount = await BillingUsageRepository.countLegacyConsumedHistoryIds();
    if (legacyUsageCount > 0) {
      throw new Error(
        `[billing] legacy consumedHistoryIds field still present on ${legacyUsageCount} usage document(s); run migration 20260502100000-rename-consumed-history-ids-to-attribution-keys before enabling meterMode`,
      );
    }

    try {
      const Subscription = mongoose.model('Subscription');
      const knownPlans = new Set(config.billing.plans ?? []);
      const distinctPlans = await Subscription.distinct('plan');
      for (const plan of distinctPlans) {
        if (!knownPlans.has(plan)) {
          console.warn(`[billing] Subscription.plan value "${plan}" not in planDefinitions — orphaned plan, may resolve quota=0`);
        }
      }
    } catch (err) {
      console.warn('[billing] Subscription.plan boot validator failed (non-fatal):', err?.message ?? err);
    }
  }
};
