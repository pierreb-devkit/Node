/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.usage.service.js — meter extensions
 */
describe('BillingUsageService — meter extensions unit tests:', () => {
  let BillingUsageService;
  let mockUsageRepository;
  let mockPlanService;
  let mockSubscriptionRepository;
  let mockExtraService;
  let mockConfig;
  let mockBillingEventsEmit;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub plan.
   * @returns {Object} A stub plan object (config-static shape).
   */
  const makePlan = (overrides = {}) => ({
    planId: 'pro',
    version: '2026.05',
    meterQuota: 500000,
    ratios: { scrap: 1, autofix: 2 },
    ...overrides,
  });

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub usage document.
   * @returns {Object} A stub BillingUsage document.
   */
  const makeUsageDoc = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439099',
    organizationId: orgId,
    weekKey: '2026-W18',
    month: '2026-05',
    meterUsed: 0,
    meterQuota: 500000,
    planVersion: '2026.05',
    alertedAt80: null,
    alertedAt100: null,
    consumedAttributionKeys: [],
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        meterMode: true,
        defaultPlan: 'starter',
        meter: {
          runBase: 1,
          dollarsToUnitRatio: 1000,
        },
        alerts: {
          thresholdPercents: [80, 100],
        },
      },
    };

    mockUsageRepository = {
      get: jest.fn(),
      increment: jest.fn(),
      reset: jest.fn(),
      findByWeek: jest.fn(),
      incrementMeter: jest.fn(),
      markThreshold: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    mockPlanService = {
      getActivePlan: jest.fn(),
    };

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
      findPlan: jest.fn(),
    };

    mockExtraService = {
      debit: jest.fn().mockResolvedValue({ applied: true }),
    };

    mockBillingEventsEmit = jest.fn();
    jest.unstable_mockModule('../lib/events.js', () => ({
      default: { emit: mockBillingEventsEmit, on: jest.fn(), off: jest.fn() },
    }));

    // Mock logger to avoid real winston initialisation (requires full config.log)
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockUsageRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockExtraService,
    }));

    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockPlanService,
    }));

    const mod = await import('../services/billing.usage.service.js');
    BillingUsageService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('currentWeekKey', () => {
    test('should return a string matching YYYY-Www format', () => {
      const result = BillingUsageService.currentWeekKey();
      expect(result).toMatch(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
    });

    test('should return consistent result on same day', () => {
      const r1 = BillingUsageService.currentWeekKey();
      const r2 = BillingUsageService.currentWeekKey();
      expect(r1).toBe(r2);
    });
  });

  /**
   * #3991 follow-up — `UsageRepository.increment` can (anomalously, post-fix)
   * return null when its duplicate-key retry matches nothing. The service
   * wrapper must convert that silent null into a LOUD, logged one (silent-catch
   * convention) without throwing (no caller — in this repo or downstream —
   * ever treated a non-null return as guaranteed, and throwing would be a
   * breaking behavior change for this generic devkit module).
   */
  describe('increment (legacy month-keyed) — #3991 loud-null hardening', () => {
    test('happy path — returns the doc, never logs', async () => {
      const loggerMod = await import('../../../lib/services/logger.js');
      const mockLoggerError = loggerMod.default.error;
      const doc = makeUsageDoc({ month: '2026-06' });
      mockUsageRepository.increment.mockResolvedValue(doc);

      const result = await BillingUsageService.increment(orgId, 'executions', 1);

      expect(result).toBe(doc);
      expect(mockUsageRepository.increment).toHaveBeenCalledWith(
        orgId,
        expect.stringMatching(/^\d{4}-\d{2}$/),
        'executions',
        1,
      );
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    test('anomalous lost write (duplicate-key retry matched nothing) — logs error with context, still returns null', async () => {
      const loggerMod = await import('../../../lib/services/logger.js');
      const mockLoggerError = loggerMod.default.error;
      mockUsageRepository.increment.mockResolvedValue(null);

      const result = await BillingUsageService.increment(orgId, 'executions', 5);

      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[billing.usage] increment lost a write — duplicate-key retry matched no document',
        expect.objectContaining({ organizationId: orgId, key: 'executions', amount: 5 }),
      );
    });
  });

  describe('incrementMeter — no-op when meterMode=false', () => {
    test('should return applied=false immediately', async () => {
      mockConfig.billing.meterMode = false;

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'key_1');
      expect(result.applied).toBe(false);
      expect(result.meterUsed).toBe(0);
      expect(mockUsageRepository.incrementMeter).not.toHaveBeenCalled();
    });
  });

  describe('incrementMeter — happy path', () => {
    test('should attribute units and return applied=true', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan());
      const updatedDoc = makeUsageDoc({ meterUsed: 100 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, { scrap: 100 }, 'hist_001');

      expect(mockUsageRepository.incrementMeter).toHaveBeenCalledWith(
        orgId,
        expect.stringMatching(/^\d{4}-W\d{2}$/),
        100,
        { scrap: 100 },
        'hist_001',
        expect.objectContaining({ meterQuota: 500000, planVersion: '2026.05' }),
      );
      expect(result.applied).toBe(true);
      expect(result.meterUsed).toBe(100);
      expect(result.extrasConsumed).toBe(0);
    });

    test('should use subscribed plan as source of truth', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan());
      mockUsageRepository.incrementMeter.mockResolvedValue(makeUsageDoc({ meterUsed: 10 }));

      await BillingUsageService.incrementMeter(orgId, 10, {}, 'hist_plan_pro');

      expect(mockSubscriptionRepository.findPlan).toHaveBeenCalledWith(orgId);
      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('pro');
    });

    test('should use defaultPlan when subscription is missing', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue(null);
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ planId: 'starter' }));
      mockUsageRepository.incrementMeter.mockResolvedValue(makeUsageDoc({ meterUsed: 10 }));

      await BillingUsageService.incrementMeter(orgId, 10, {}, 'hist_default_plan');

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('starter');
    });

    test('should fall back to free when subscription and defaultPlan are missing', async () => {
      mockConfig.billing.defaultPlan = undefined;
      mockSubscriptionRepository.findPlan.mockResolvedValue(null);
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ planId: 'free' }));
      mockUsageRepository.incrementMeter.mockResolvedValue(makeUsageDoc({ meterUsed: 10 }));

      await BillingUsageService.incrementMeter(orgId, 10, {}, 'hist_free_fallback');

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('free');
    });

    test('should return applied=false and fetch existing doc on replay', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan());
      // repo returns null = replay
      mockUsageRepository.incrementMeter.mockResolvedValue(null);
      const existingDoc = makeUsageDoc({ meterUsed: 100 });
      mockUsageRepository.findByWeek.mockResolvedValue(existingDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_replay');

      expect(result.applied).toBe(false);
      expect(result.meterUsed).toBe(100);
    });

    test('replay returns the LIVE plan quota, not the stored (possibly stale) snapshot', async () => {
      // Same rationale as the non-replay overflow path: the stored week-doc snapshot can be
      // stale after a mid-week plan change (e.g. rotation hasn't run yet, or failed non-fatally).
      // A replayed call must report the live quota too, not a pre-rotation value.
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 1000 }));
      mockUsageRepository.incrementMeter.mockResolvedValue(null);
      // Stored doc still carries the stale pre-upgrade quota (0).
      mockUsageRepository.findByWeek.mockResolvedValue(makeUsageDoc({ meterUsed: 100, meterQuota: 0 }));

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_replay_stale_snapshot');

      expect(result.applied).toBe(false);
      expect(result.meterQuota).toBe(1000);
    });

    test('incrementMeter same idempotencyKey twice → second is no-op', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan());
      mockUsageRepository.incrementMeter
        .mockResolvedValueOnce(makeUsageDoc({ meterUsed: 100 }))
        .mockResolvedValueOnce(null); // second call: replay
      mockUsageRepository.findByWeek.mockResolvedValue(makeUsageDoc({ meterUsed: 100 }));

      const r1 = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_idempotent');
      const r2 = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_idempotent');

      expect(r1.applied).toBe(true);
      expect(r2.applied).toBe(false);
    });
  });

  describe('incrementMeter — overflow to extras (inline debit)', () => {
    test('should compute extrasConsumed and debit inline when meterUsed exceeds quota', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      // meterUsed = 510000, quota = 500000 → 10000 overflow
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 50000, {}, 'hist_overflow');

      expect(result.extrasConsumed).toBe(10000);
      expect(mockExtraService.debit).toHaveBeenCalledWith(orgId, 10000, 'hist_overflow');
    });

    test('debit is called even when extras balance would go negative (overage allowed)', async () => {
      // Validates V6 P1 #1 fix: debit repo no longer gates on balance >= amount.
      // The service always calls debit on overflow; repo allows negative balance.
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      // Simulate repo returning applied=true with negative balance (new behaviour)
      mockExtraService.debit.mockResolvedValue({ applied: true, doc: { cachedBalance: -5 } });

      const result = await BillingUsageService.incrementMeter(orgId, 50000, {}, 'hist_overage_negative');

      expect(result.applied).toBe(true);
      expect(result.extrasConsumed).toBe(10000);
      expect(mockExtraService.debit).toHaveBeenCalledWith(orgId, 10000, 'hist_overage_negative');
    });

    test('should return extrasConsumed=0 and not call debit when within quota', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 100, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_within');

      expect(result.extrasConsumed).toBe(0);
      expect(mockExtraService.debit).not.toHaveBeenCalled();
    });

    test('debit applied=false with unexpected reason → logs error, continues', async () => {
      const loggerMod = await import('../../../lib/services/logger.js');
      const mockLoggerError = loggerMod.default.error;
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      // applied=false with reason that is NOT 'duplicate_step' — unexpected, should log error
      mockExtraService.debit.mockResolvedValue({ applied: false, reason: 'insufficient_balance' });

      const result = await BillingUsageService.incrementMeter(orgId, 50000, {}, 'hist_debit_unexpected_skip');

      expect(result.applied).toBe(true);
      expect(result.extrasConsumed).toBe(10000);
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[billing.usage] extras debit unexpectedly not applied',
        expect.objectContaining({ organizationId: orgId, reason: 'insufficient_balance' }),
      );
    });

    test('debit failure is non-fatal — logs warning and still returns applied=true', async () => {
      const loggerMod = await import('../../../lib/services/logger.js');
      const mockLoggerWarn = loggerMod.default.warn;
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      mockExtraService.debit.mockRejectedValue(new Error('balance write failed'));

      const result = await BillingUsageService.incrementMeter(orgId, 50000, {}, 'hist_debit_fail');

      expect(result.applied).toBe(true);
      expect(result.extrasConsumed).toBe(10000);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[billing.usage] extras debit failed (usage already counted)',
        expect.objectContaining({ err: 'balance write failed' }),
      );
    });
  });

  describe('incrementMeter — threshold detection', () => {
    test('should emit threshold 80 alert when crossing 80% (once per cycle)', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      // 80% of 500000 = 400000 → crossing at meterUsed = 400001
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_80pct');

      expect(result.alertCrossed).toBe('80');
      // Should mark alertedAt80 atomically via repository
      expect(mockUsageRepository.markThreshold).toHaveBeenCalledWith(updatedDoc._id, 'alertedAt80');
    });

    test('respects thresholdPercents config override', async () => {
      mockConfig.billing.alerts.thresholdPercents = [100];
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_threshold_override');

      expect(result.alertCrossed).toBeNull();
      expect(mockUsageRepository.markThreshold).not.toHaveBeenCalled();
    });

    test('warns and skips when thresholdPercents contains unsupported value (not 80/100)', async () => {
      const loggerMod = await import('../../../lib/services/logger.js');
      const mockLoggerWarn = loggerMod.default.warn;
      mockConfig.billing.alerts.thresholdPercents = [90];
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 460000, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_threshold_unsupported');

      expect(result.alertCrossed).toBeNull();
      expect(mockUsageRepository.markThreshold).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[billing.usage] threshold has no schema field — skipping',
        expect.objectContaining({ threshold: 90 }),
      );
    });

    test('should NOT re-emit threshold 80 when already alerted (alertedAt80 set)', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({
        meterUsed: 450000,
        meterQuota: 500000,
        alertedAt80: new Date(), // already alerted
        alertedAt100: null,
      });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_80pct_dedup');

      expect(result.alertCrossed).toBeNull();
    });

    test('should emit threshold 100 alert when at 100%', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({
        meterUsed: 500001,
        meterQuota: 500000,
        alertedAt80: new Date(), // 80 already sent
        alertedAt100: null,
      });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_100pct');

      expect(result.alertCrossed).toBe('100');
    });

    test('should NOT re-emit threshold 100 when already alerted', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({
        meterUsed: 600000,
        meterQuota: 500000,
        alertedAt80: new Date(),
        alertedAt100: new Date(), // already alerted
      });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_100pct_dedup');

      expect(result.alertCrossed).toBeNull();
    });

    test('should emit BOTH 80% and 100% when jumping from 0% to 150% in one attribution', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      // meterUsed = 750000 → 150% of 500000 → both 80 and 100 thresholds crossed
      const updatedDoc = makeUsageDoc({
        meterUsed: 750000,
        meterQuota: 500000,
        alertedAt80: null,
        alertedAt100: null,
      });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      mockUsageRepository.markThreshold.mockResolvedValue({ modifiedCount: 1 });

      const result = await BillingUsageService.incrementMeter(orgId, 750000, {}, 'hist_0to150pct');

      // alertCrossed should be the last threshold set (80, since sort is DESC: 100 first, then 80)
      expect(result.alertCrossed).toBe('80');
      expect(mockUsageRepository.markThreshold).toHaveBeenCalledTimes(2);
      expect(mockUsageRepository.markThreshold).toHaveBeenCalledWith(updatedDoc._id, 'alertedAt100');
      expect(mockUsageRepository.markThreshold).toHaveBeenCalledWith(updatedDoc._id, 'alertedAt80');
      // Assert both meter.threshold_crossed events were emitted
      expect(mockBillingEventsEmit).toHaveBeenCalledWith(
        'meter.threshold_crossed',
        expect.objectContaining({ threshold: 100 }),
      );
      expect(mockBillingEventsEmit).toHaveBeenCalledWith(
        'meter.threshold_crossed',
        expect.objectContaining({ threshold: 80 }),
      );
    });

    test('should NOT set alertCrossed when markThreshold returns modifiedCount=0 (another pod won)', async () => {
      mockUsageRepository.markThreshold.mockResolvedValue({ modifiedCount: 0 });
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_race_80');

      expect(result.alertCrossed).toBeNull();
    });

    test('should set alertCrossed when markThreshold returns modifiedCount=1 (we won)', async () => {
      mockUsageRepository.markThreshold.mockResolvedValue({ modifiedCount: 1 });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_won_80');

      expect(result.alertCrossed).toBe('80');
    });
  });

  describe('incrementMeter — free plan (meterQuota=0) extras debit', () => {
    test('every unit goes to extras when meterQuota=0 (extras pack credits balance)', async () => {
      // Free plan has meterQuota=0 — middleware (requireQuota) lets the request through
      // because extrasBalance > 0. Without this branch the extras balance would never
      // decrease (infinite usage from a single $5 pack — money leak).
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'free' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ planId: 'free', meterQuota: 0 }));
      // After increment: meterUsed=5, quota=0. Old code computed extrasConsumed=0; new code = units.
      const updatedDoc = makeUsageDoc({ meterUsed: 5, meterQuota: 0 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      mockExtraService.debit.mockResolvedValue({ applied: true, doc: { cachedBalance: 995 } });

      const result = await BillingUsageService.incrementMeter(orgId, 5, { scrap: 5 }, 'hist_free_5');

      expect(result.applied).toBe(true);
      expect(result.extrasConsumed).toBe(5);
      expect(mockExtraService.debit).toHaveBeenCalledWith(orgId, 5, 'hist_free_5');
    });

    test('free plan with no extras: debit is still called and may go negative (debt persists)', async () => {
      // Middleware should block this case before we reach incrementMeter, but if it
      // somehow leaks through (race / misconfig), the math must still attribute correctly.
      // BillingExtraService.debit allows negative balance — the debt persists until next pack.
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'free' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ planId: 'free', meterQuota: 0 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 10, meterQuota: 0 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      // Simulate repo returning applied=true with a negative cachedBalance (debt).
      mockExtraService.debit.mockResolvedValue({ applied: true, doc: { cachedBalance: -10 } });

      const result = await BillingUsageService.incrementMeter(orgId, 10, {}, 'hist_free_no_extras');

      expect(result.applied).toBe(true);
      expect(result.extrasConsumed).toBe(10);
      expect(mockExtraService.debit).toHaveBeenCalledWith(orgId, 10, 'hist_free_no_extras');
    });

    test('regression: paid plan over quota still debits only the overflow portion', async () => {
      // Existing behaviour preserved: when meterQuota>0 and we cross it, only the
      // portion above the quota goes to extras (not the entire `units` amount).
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 1000 }));
      // previousUsed = 950, after increment meterUsed = 1050, quota = 1000 → overflow = 50.
      const updatedDoc = makeUsageDoc({ meterUsed: 1050, meterQuota: 1000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_paid_overflow');

      expect(result.extrasConsumed).toBe(50);
      expect(mockExtraService.debit).toHaveBeenCalledWith(orgId, 50, 'hist_paid_overflow');
    });
  });

  describe('getMeter', () => {
    test('should return null when meterMode is disabled', async () => {
      mockConfig.billing.meterMode = false;
      const result = await BillingUsageService.getMeter(orgId);
      expect(result).toBeNull();
    });

    test('should return current week usage doc', async () => {
      const doc = makeUsageDoc({ meterUsed: 200, meterQuota: 500000 });
      mockUsageRepository.findByWeek.mockResolvedValue(doc);

      const result = await BillingUsageService.getMeter(orgId);

      expect(mockUsageRepository.findByWeek).toHaveBeenCalledWith(
        orgId,
        expect.stringMatching(/^\d{4}-W\d{2}$/),
      );
      expect(result.meterUsed).toBe(200);
    });

    test('should return null when no doc for current week', async () => {
      mockUsageRepository.findByWeek.mockResolvedValue(null);
      const result = await BillingUsageService.getMeter(orgId);
      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // runaway negative balance detection (Item 3 — Batch 2)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('incrementMeter — runaway negative balance detection (Opus H1):', () => {
    test('normal debit on pro plan — no runaway, no event', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      // Balance just slightly negative — within 10x quota threshold
      mockExtraService.debit.mockResolvedValue({
        applied: true,
        doc: { cachedBalance: -100 },
      });

      await BillingUsageService.incrementMeter(orgId, 10000, {}, 'hist_normal_debit');

      // No runaway event emitted
      const runawayEmits = mockBillingEventsEmit.mock.calls.filter(
        ([name]) => name === 'billing.extras.runaway_debit',
      );
      expect(runawayEmits).toHaveLength(0);
    });

    test('excessive debit pushing balance below -10×quota — emits runaway_debit event and logs error', async () => {
      const loggerMod = await import('../../../lib/services/logger.js');
      const mockLoggerError = loggerMod.default.error;

      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      // Balance far below -10 × 500000 = -5000000 threshold
      mockExtraService.debit.mockResolvedValue({
        applied: true,
        doc: { cachedBalance: -6000000 },
      });

      await BillingUsageService.incrementMeter(orgId, 10000, {}, 'hist_runaway');

      const runawayEmits = mockBillingEventsEmit.mock.calls.filter(
        ([name]) => name === 'billing.extras.runaway_debit',
      );
      expect(runawayEmits).toHaveLength(1);
      expect(runawayEmits[0][1]).toMatchObject({
        organizationId: orgId,
        currentBalance: -6000000,
        planQuota: 500000,
      });

      expect(mockLoggerError).toHaveBeenCalledWith(
        '[billing.extra] runaway negative balance detected — possible debit loop or quota gate bypass',
        expect.objectContaining({
          organizationId: orgId,
          currentBalance: -6000000,
          planQuota: 500000,
        }),
      );
    });

    test('free plan (meterQuota=0) — runaway check skipped (no threshold defined)', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'free' });
      mockPlanService.getActivePlan.mockReturnValue(makePlan({ meterQuota: 0 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 50, meterQuota: 0 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      // Deeply negative balance — but free plan has no quota threshold
      mockExtraService.debit.mockResolvedValue({
        applied: true,
        doc: { cachedBalance: -999999 },
      });

      await BillingUsageService.incrementMeter(orgId, 50, {}, 'hist_free_no_runaway');

      const runawayEmits = mockBillingEventsEmit.mock.calls.filter(
        ([name]) => name === 'billing.extras.runaway_debit',
      );
      expect(runawayEmits).toHaveLength(0);
    });
  });
});
