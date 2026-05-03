/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.usage.service.js — meter extensions (PR-N2)
 */
describe('BillingUsageService — meter extensions unit tests:', () => {
  let BillingUsageService;
  let mockUsageRepository;
  let mockPlanService;
  let mockSubscriptionRepository;
  let mockMeterOutboxRepository;
  let mockConfig;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @param {Object} [overrides={}] - Fields to override on the stub plan.
   * @returns {Object} A stub BillingPlan document.
   */
  const makePlan = (overrides = {}) => ({
    planId: 'pro',
    version: 'v1',
    meterQuota: 500000,
    active: true,
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
    planVersion: 'v1',
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

    mockMeterOutboxRepository = {
      create: jest.fn(),
      findByIdempotencyKey: jest.fn(),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({
      default: mockUsageRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../repositories/billing.meter.outbox.repository.js', () => ({
      default: mockMeterOutboxRepository,
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
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      const updatedDoc = makeUsageDoc({ meterUsed: 100 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, { scrap: 100 }, 'hist_001');

      expect(mockUsageRepository.incrementMeter).toHaveBeenCalledWith(
        orgId,
        expect.stringMatching(/^\d{4}-W\d{2}$/),
        100,
        { scrap: 100 },
        'hist_001',
        expect.objectContaining({ meterQuota: 500000, planVersion: 'v1' }),
      );
      expect(result.applied).toBe(true);
      expect(result.meterUsed).toBe(100);
      expect(result.extrasConsumed).toBe(0);
    });

    test('should use subscribed plan as source of truth', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      mockUsageRepository.incrementMeter.mockResolvedValue(makeUsageDoc({ meterUsed: 10 }));

      await BillingUsageService.incrementMeter(orgId, 10, {}, 'hist_plan_pro');

      expect(mockSubscriptionRepository.findPlan).toHaveBeenCalledWith(orgId);
      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('pro');
    });

    test('should use defaultPlan when subscription is missing', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue(null);
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ planId: 'starter' }));
      mockUsageRepository.incrementMeter.mockResolvedValue(makeUsageDoc({ meterUsed: 10 }));

      await BillingUsageService.incrementMeter(orgId, 10, {}, 'hist_default_plan');

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('starter');
    });

    test('should fall back to free when subscription and defaultPlan are missing', async () => {
      mockConfig.billing.defaultPlan = undefined;
      mockSubscriptionRepository.findPlan.mockResolvedValue(null);
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ planId: 'free' }));
      mockUsageRepository.incrementMeter.mockResolvedValue(makeUsageDoc({ meterUsed: 10 }));

      await BillingUsageService.incrementMeter(orgId, 10, {}, 'hist_free_fallback');

      expect(mockPlanService.getActivePlan).toHaveBeenCalledWith('free');
    });

    test('should return applied=false and fetch existing doc on replay', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
      // repo returns null = replay
      mockUsageRepository.incrementMeter.mockResolvedValue(null);
      const existingDoc = makeUsageDoc({ meterUsed: 100 });
      mockUsageRepository.findByWeek.mockResolvedValue(existingDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_replay');

      expect(result.applied).toBe(false);
      expect(result.meterUsed).toBe(100);
    });

    test('incrementMeter same idempotencyKey twice → second is no-op', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan());
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

  describe('incrementMeter — overflow to extras', () => {
    test('should compute extrasConsumed when meterUsed exceeds quota', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      // meterUsed = 510000, quota = 500000 → 10000 overflow
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 50000, {}, 'hist_overflow');

      expect(result.extrasConsumed).toBe(10000);
    });

    test('should return extrasConsumed=0 when within quota', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 100, meterQuota: 500000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 100, {}, 'hist_within');

      expect(result.extrasConsumed).toBe(0);
    });

    test('incrementMeterWithOutbox creates outbox row when extras are consumed', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      const outbox = { _id: 'outbox_1' };
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      mockMeterOutboxRepository.create.mockResolvedValue(outbox);

      const result = await BillingUsageService.incrementMeterWithOutbox(
        orgId,
        50000,
        {},
        'hist_overflow:initial',
      );

      expect(mockMeterOutboxRepository.create).toHaveBeenCalledWith({
        organizationId: orgId,
        idempotencyKey: 'hist_overflow:initial',
        extrasUnits: 10000,
      });
      expect(result.outbox).toBe(outbox);
      expect(result.extrasConsumed).toBe(10000);
    });

    test('incrementMeterWithOutbox treats E11000 outbox create as existing row', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 });
      const existingOutbox = { _id: 'outbox_existing', idempotencyKey: 'hist_overflow:initial' };
      const e11000 = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);
      mockMeterOutboxRepository.create.mockRejectedValue(e11000);
      mockMeterOutboxRepository.findByIdempotencyKey.mockResolvedValue(existingOutbox);

      const result = await BillingUsageService.incrementMeterWithOutbox(
        orgId,
        50000,
        {},
        'hist_overflow:initial',
      );

      expect(mockMeterOutboxRepository.findByIdempotencyKey).toHaveBeenCalledWith('hist_overflow:initial');
      expect(result.outbox).toBe(existingOutbox);
      expect(result.extrasConsumed).toBe(10000);
    });

    test('incrementMeterWithOutbox throws desync error when E11000 row cannot be fetched', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const e11000 = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      mockUsageRepository.incrementMeter.mockResolvedValue(makeUsageDoc({ meterUsed: 510000, meterQuota: 500000 }));
      mockMeterOutboxRepository.create.mockRejectedValue(e11000);
      mockMeterOutboxRepository.findByIdempotencyKey.mockResolvedValue(null);

      await expect(
        BillingUsageService.incrementMeterWithOutbox(orgId, 50000, {}, 'hist_desync:initial'),
      ).rejects.toThrow('[billing] outbox state desynced');
    });

    test('incrementMeterWithOutbox does not create outbox row for replay', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      mockUsageRepository.incrementMeter.mockResolvedValue(null);
      mockUsageRepository.findByWeek.mockResolvedValue(makeUsageDoc({ meterUsed: 510000 }));

      const result = await BillingUsageService.incrementMeterWithOutbox(
        orgId,
        50000,
        {},
        'hist_replay:initial',
      );

      expect(result.applied).toBe(false);
      expect(mockMeterOutboxRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('incrementMeter — threshold detection', () => {
    test('should emit threshold 80 alert when crossing 80% (once per cycle)', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
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
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_threshold_override');

      expect(result.alertCrossed).toBeNull();
      expect(mockUsageRepository.markThreshold).not.toHaveBeenCalled();
    });

    test('warns and skips when thresholdPercents contains unsupported value (not 80/100)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockConfig.billing.alerts.thresholdPercents = [90];
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 460000, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_threshold_unsupported');

      expect(result.alertCrossed).toBeNull();
      expect(mockUsageRepository.markThreshold).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('threshold 90% has no schema field'));
      warnSpy.mockRestore();
    });

    test('should NOT re-emit threshold 80 when already alerted (alertedAt80 set)', async () => {
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
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
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
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
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
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

    test('should NOT set alertCrossed when markThreshold returns modifiedCount=0 (another pod won)', async () => {
      // markThreshold returns modifiedCount=0 → we lost the race, must not emit
      mockUsageRepository.markThreshold.mockResolvedValue({ modifiedCount: 0 });
      mockSubscriptionRepository.findPlan.mockResolvedValue({ plan: 'pro' });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_race_80');

      expect(result.alertCrossed).toBeNull();
    });

    test('should set alertCrossed when markThreshold returns modifiedCount=1 (we won)', async () => {
      // markThreshold returns modifiedCount=1 → we won the race, must emit
      mockUsageRepository.markThreshold.mockResolvedValue({ modifiedCount: 1 });
      mockPlanService.getActivePlan.mockResolvedValue(makePlan({ meterQuota: 500000 }));
      const updatedDoc = makeUsageDoc({ meterUsed: 400001, meterQuota: 500000, alertedAt80: null, alertedAt100: null });
      mockUsageRepository.incrementMeter.mockResolvedValue(updatedDoc);

      const result = await BillingUsageService.incrementMeter(orgId, 1, {}, 'hist_won_80');

      expect(result.alertCrossed).toBe('80');
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
});
