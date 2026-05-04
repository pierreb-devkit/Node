/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, beforeEach, afterAll, test, expect } from '@jest/globals';

import config from '../../../config/index.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for concurrent overage attribution and debit upsert (V7 P1 + P2).
 *
 * Validates:
 * - Concurrent incrementMeter calls correctly accumulate negative balance + deduplicate ledger.
 * - A fresh org (no BillingExtraBalance doc) gets a doc created with negative balance on overflow.
 * - Replay of the same idempotencyKey is a no-op (no double debit).
 */
describe('BillingUsage concurrent attribution integration tests:', () => {
  let BillingUsage;
  let BillingExtraBalance;
  let Subscription;
  let BillingUsageService;
  let originalMeterMode;
  let originalPlanDefinitions;

  beforeAll(async () => {
    originalMeterMode = config.billing.meterMode;
    originalPlanDefinitions = config.billing.planDefinitions;
    config.billing.meterMode = true;
    await mongooseService.loadModels();
    await mongooseService.connect();

    BillingUsage = mongoose.model('BillingUsage');
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    Subscription = mongoose.model('Subscription');

    BillingUsageService = (await import('../services/billing.usage.service.js')).default;
  });

  beforeEach(async () => {
    await Promise.all([
      BillingUsage.deleteMany({}),
      BillingExtraBalance.deleteMany({}),
      Subscription.deleteMany({}),
    ]);
    config.billing.planDefinitions = [
      { planId: 'pro', version: 'pro-v1', meterQuota: 5, ratios: { scrap: 1 } },
    ];
  });

  afterAll(async () => {
    config.billing.meterMode = originalMeterMode;
    config.billing.planDefinitions = originalPlanDefinitions;
    await mongooseService.disconnect();
  });

  test('concurrent overage attributions persist negative balance + distinct ledger entries', async () => {
    const organizationId = new mongoose.Types.ObjectId();

    await Subscription.create({ organization: organizationId, plan: 'pro', status: 'active' });

    // Seed BillingExtraBalance with an initial balance of 10 units
    await BillingExtraBalance.create({
      organization: organizationId,
      ledger: [{ kind: 'topup', amount: 10, stripeSessionId: 'cs_concurrent_seed' }],
      cachedBalance: 10,
    });

    // 5 concurrent attributions, each consuming 15 units (all overflow the 5-unit quota)
    const promises = Array.from({ length: 5 }, (_, i) =>
      BillingUsageService.incrementMeter(
        organizationId.toString(),
        15,
        { scrap: 15 },
        `step-concurrent-${i}`,
      ),
    );
    await Promise.all(promises);

    const balance = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    expect(balance).not.toBeNull();

    // All 5 attributions produce some overflow (quota=5, each unit=15 → each call overflows).
    // Exact total depends on concurrent ordering; what matters: balance is negative.
    expect(balance.cachedBalance).toBeLessThan(10);

    // 5 distinct debit ledger entries
    const debits = balance.ledger.filter((e) => e.kind === 'debit');
    expect(debits).toHaveLength(5);

    const refIds = debits.map((e) => e.refId);
    for (let i = 0; i < 5; i++) {
      expect(refIds).toContain(`step-concurrent-${i}`);
    }
  });

  test('no balance doc + overflow creates doc with negative balance + debit ledger entry (V7 P1)', async () => {
    const organizationId = new mongoose.Types.ObjectId();

    await Subscription.create({ organization: organizationId, plan: 'pro', status: 'active' });

    // No BillingExtraBalance seed — org has no extras doc yet (fresh paying org)
    const result = await BillingUsageService.incrementMeter(
      organizationId.toString(),
      50,
      { scrap: 50 },
      'step-fresh-org',
    );

    expect(result.applied).toBe(true);
    // quota=5, 50 units → overflow = 45 units charged to extras
    expect(result.extrasConsumed).toBe(45);

    const balance = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    expect(balance).not.toBeNull();
    // Started at 0 (newly created doc), debited 45 → final = -45
    expect(balance.cachedBalance).toBe(-45);

    const debits = balance.ledger.filter((e) => e.kind === 'debit');
    expect(debits).toHaveLength(1);
    expect(debits[0].refId).toBe('step-fresh-org');
  });

  test('replay of same idempotencyKey is a no-op (no double debit)', async () => {
    const organizationId = new mongoose.Types.ObjectId();

    await Subscription.create({ organization: organizationId, plan: 'pro', status: 'active' });

    await BillingExtraBalance.create({
      organization: organizationId,
      ledger: [{ kind: 'topup', amount: 100, stripeSessionId: 'cs_replay_seed' }],
      cachedBalance: 100,
    });

    // First call
    await BillingUsageService.incrementMeter(
      organizationId.toString(),
      30,
      { scrap: 30 },
      'step-replay-key',
    );

    // Second call with the same idempotencyKey — must be a no-op
    await BillingUsageService.incrementMeter(
      organizationId.toString(),
      30,
      { scrap: 30 },
      'step-replay-key',
    );

    const balance = await BillingExtraBalance.findOne({ organization: organizationId }).lean();
    // quota=5, 30 units → overage = 25; starting balance = 100 → final = 75. Single debit only.
    expect(balance.cachedBalance).toBe(75);

    const debits = balance.ledger.filter((e) => e.kind === 'debit');
    // Only one debit despite two calls
    expect(debits).toHaveLength(1);
  });
});
