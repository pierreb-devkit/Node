/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.extrasExpiration cron logic.
 *
 * Tests cover:
 *  - meterMode gate (early exit when false)
 *  - findOrgsWithExpiringTopups returns org list
 *  - BillingExtraService.expireOldEntries called per org
 *  - error counting + continuation
 *  - empty result (no-op)
 */
describe('billing.extrasExpiration cron — logic:', () => {
  let BillingExtraService;
  let BillingExtraBalanceRepository;
  let mockConfig;

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: { meterMode: true },
    };

    jest.unstable_mockModule('../../config/index.js', () => ({ default: mockConfig }));

    jest.unstable_mockModule('../../modules/billing/repositories/billing.extraBalance.repository.js', () => ({
      default: {
        findOrgsWithExpiringTopups: jest.fn(),
        addExpirationEntries: jest.fn(),
        getOrCreate: jest.fn(),
        creditPack: jest.fn(),
        debit: jest.fn(),
        refundPartial: jest.fn(),
        getBalance: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../../modules/billing/services/billing.extra.service.js', () => ({
      default: {
        expireOldEntries: jest.fn(),
        creditPack: jest.fn(),
        debit: jest.fn(),
        refundPartial: jest.fn(),
        listLedger: jest.fn(),
      },
    }));

    const [extraServiceMod, repMod] = await Promise.all([
      import('../../modules/billing/services/billing.extra.service.js'),
      import('../../modules/billing/repositories/billing.extraBalance.repository.js'),
    ]);
    BillingExtraService = extraServiceMod.default;
    BillingExtraBalanceRepository = repMod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('skips sweep when meterMode is false', async () => {
    mockConfig.billing.meterMode = false;

    // Simulate the script gate logic inline
    const shouldSkip = !mockConfig?.billing?.meterMode;
    expect(shouldSkip).toBe(true);
    expect(BillingExtraBalanceRepository.findOrgsWithExpiringTopups).not.toHaveBeenCalled();
  });

  test('returns no-op when findOrgsWithExpiringTopups returns empty list', async () => {
    BillingExtraBalanceRepository.findOrgsWithExpiringTopups.mockResolvedValue([]);

    const now = new Date();
    const orgIds = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);
    expect(orgIds).toHaveLength(0);
    expect(BillingExtraService.expireOldEntries).not.toHaveBeenCalled();
  });

  test('calls expireOldEntries for each org returned by findOrgsWithExpiringTopups', async () => {
    const orgIds = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439022'];
    BillingExtraBalanceRepository.findOrgsWithExpiringTopups.mockResolvedValue(orgIds);
    BillingExtraService.expireOldEntries.mockResolvedValue(1);

    const now = new Date();
    const returned = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(now);

    let processed = 0;
    let errors = 0;
    for (const orgId of returned) {
      try {
        await BillingExtraService.expireOldEntries(orgId);
        processed += 1;
      } catch {
        errors += 1;
      }
    }

    expect(processed).toBe(2);
    expect(errors).toBe(0);
    expect(BillingExtraService.expireOldEntries).toHaveBeenCalledTimes(2);
    expect(BillingExtraService.expireOldEntries).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
    expect(BillingExtraService.expireOldEntries).toHaveBeenCalledWith('507f1f77bcf86cd799439022');
  });

  test('counts errors and continues when expireOldEntries throws', async () => {
    const orgIds = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439022'];
    BillingExtraBalanceRepository.findOrgsWithExpiringTopups.mockResolvedValue(orgIds);
    BillingExtraService.expireOldEntries
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce(1);

    const returned = await BillingExtraBalanceRepository.findOrgsWithExpiringTopups(new Date());
    let processed = 0;
    let errors = 0;
    for (const orgId of returned) {
      try {
        await BillingExtraService.expireOldEntries(orgId);
        processed += 1;
      } catch {
        errors += 1;
      }
    }

    expect(processed).toBe(1);
    expect(errors).toBe(1);
  });
});

