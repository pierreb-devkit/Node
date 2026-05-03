/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests
 */
describe('requireQuota middleware:', () => {
  let requireQuota;
  let mockSubscriptionRepository;
  let mockBillingUsageService;
  let mockConfig;
  let req;
  let res;
  let next;

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = {
      findByOrganization: jest.fn(),
    };

    mockBillingUsageService = {
      get: jest.fn(),
    };

    mockConfig = {
      billing: {
        quotas: {
          free: { scraps: { create: 3, execute: 100 } },
          starter: { scraps: { create: 20, execute: 2000 } },
          pro: { scraps: { create: Infinity, execute: Infinity } },
        },
      },
    };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: mockSubscriptionRepository,
    }));

    jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
      default: mockBillingUsageService,
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    const mod = await import('../middlewares/billing.requireQuota.js');
    requireQuota = mod.default;

    req = {
      organization: { _id: '507f1f77bcf86cd799439011' },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should allow request when under quota', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 1 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should return 429 when at quota limit', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Quota exceeded',
      code: 429,
      status: 429,
    }));
  });

  test('should return 429 when over quota limit', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 5 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  test('should treat missing subscription as free plan', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      code: 429,
    }));
  });

  test.each(['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    'should treat %s subscription as free plan',
    async (status) => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'starter', status });
      mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 3 } });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        code: 429,
      }));
    },
  );

  test('should allow unlimited (Infinity) without checking usage', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'active' });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockBillingUsageService.get).not.toHaveBeenCalled();
  });

  test('should return correct error payload with upgradeUrl', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_execute': 100 } });

    await requireQuota('scraps', 'execute')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Quota exceeded',
      code: 429,
      status: 429,
      description: 'You have reached the usage limit for this resource',
    }));
  });

  test('should return 403 when organization context is missing', async () => {
    req.organization = undefined;

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('should allow through when no quota is configured for resource', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });

    await requireQuota('unknownResource', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('should use subscription plan when status is trialing', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'starter', status: 'trialing' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 15 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should treat zero usage as under quota', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: {} });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  // ── Admin bypass ──────────────────────────────────────────────────────────

  test('should bypass quota for admin user (legacy mode)', async () => {
    req.user = { roles: ['admin'] };
    // No subscription/usage lookups needed — should short-circuit
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    // Short-circuit: no downstream quota lookups
    expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
    expect(mockBillingUsageService.get).not.toHaveBeenCalled();
  });

  test('should NOT bypass quota for non-admin user (legacy mode)', async () => {
    req.user = { roles: ['user'] };
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  test('should bypass quota for meterExempt organization', async () => {
    req.organization = { _id: '507f1f77bcf86cd799439011', meterExempt: true };
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    // Short-circuit: no downstream quota lookups
    expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
    expect(mockBillingUsageService.get).not.toHaveBeenCalled();
  });

  test('should NOT bypass quota when meterExempt is false', async () => {
    req.organization = { _id: '507f1f77bcf86cd799439011', meterExempt: false };
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps_create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  // ── Meter mode (meterMode: true) ───────────────────────────────────────────

  describe('meter mode (meterMode: true)', () => {
    let mockBillingExtraBalanceRepository;
    let mockBillingPlanService;

    beforeEach(async () => {
      jest.resetModules();

      mockConfig = {
        billing: {
          meterMode: true,
          quotas: {},
          packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
          upgradeUrl: '/billing/plans',
          defaultPlan: 'free',
        },
      };

      mockBillingUsageService = {
        get: jest.fn(),
        getMeter: jest.fn(),
      };

      mockBillingExtraBalanceRepository = {
        getBalance: jest.fn(),
      };

      mockBillingPlanService = {
        getActivePlan: jest.fn(),
      };

      jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
        default: mockSubscriptionRepository,
      }));

      jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
        default: mockBillingUsageService,
      }));

      jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
        default: mockBillingExtraBalanceRepository,
      }));

      jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
        default: mockBillingPlanService,
      }));

      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: mockConfig,
      }));

      const mod = await import('../middlewares/billing.requireQuota.js');
      requireQuota = mod.default;
    });

    test('should call next() when remaining quota > 0 (meter not exhausted)', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 1000, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should call next() when plan quota exhausted but extras balance covers it', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 5000, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(500000);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should return 402 when meterUsed >= meterQuota and extras balance is 0', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 5000, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        code: 402,
      }));
    });

    test('should include METER_EXHAUSTED payload with pack info in 402 response', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 6000, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      expect(payload.description).toBe('Meter exhausted');
      // The error object contains the metadata
      const errData = JSON.parse(payload.error);
      expect(errData.type).toBe('METER_EXHAUSTED');
      expect(errData.meterUsed).toBe(6000);
      expect(errData.meterQuota).toBe(5000);
      expect(errData.extrasRemaining).toBe(0);
      expect(Array.isArray(errData.packsAvailable)).toBe(true);
    });

    test('should return 402 when meter doc is null and plan quota is 0 (no extras)', async () => {
      // No BillingUsage doc yet; plan has meterQuota=0 (e.g. unconfigured plan)
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
      mockBillingPlanService.getActivePlan.mockResolvedValue({ meterQuota: 0, version: 'v1' });

      await requireQuota('scraps', 'create')(req, res, next);

      // meterUsed=0, meterQuota=0 → remaining = (0-0)+0 = 0 → 402
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
    });

    // ── Fix #3569: lazy fallback for new-user first scrap ─────────────────────

    test('fix #3575: no meter doc + getActivePlan returns null — returns 503 PLAN_NOT_CONFIGURED (not 402)', async () => {
      // getActivePlan returns null during seeding / version bump — must NOT surface as 402 METER_EXHAUSTED.
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
      mockBillingPlanService.getActivePlan.mockResolvedValue(null);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.type).toBe('PLAN_NOT_CONFIGURED');
    });

    test('fix #3569: new Free user — 1st scrap passes when plan meterQuota > 0', async () => {
      // No BillingUsage doc yet (getMeter returns null) — first scrap of the week.
      // Middleware should fall back to plan quota instead of blocking with 402.
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
      mockBillingPlanService.getActivePlan.mockResolvedValue({ meterQuota: 10, version: 'v1' });

      await requireQuota('scraps', 'create')(req, res, next);

      // meterUsed=0, meterQuota=10 → remaining = 10 > 0 → allow
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('fix #3569: new Pro user — 1st scrap passes with full pro quota', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'active' });
      mockBillingPlanService.getActivePlan.mockResolvedValue({ meterQuota: 200000, version: 'v1' });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(mockBillingPlanService.getActivePlan).toHaveBeenCalledWith('pro');
    });

    test('fix #3569: no meter doc + no subscription — falls back to defaultPlan quota', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
      mockBillingPlanService.getActivePlan.mockResolvedValue({ meterQuota: 5, version: 'v1' });

      await requireQuota('scraps', 'create')(req, res, next);

      // Falls back to config.billing.defaultPlan = 'free'
      expect(mockBillingPlanService.getActivePlan).toHaveBeenCalledWith('free');
      expect(next).toHaveBeenCalled();
    });

    test('fix #3569: no meter doc — does NOT write a BillingUsage doc (incrementMeter creates it)', async () => {
      // The middleware must never write the usage doc — only incrementMeter should create it.
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'active' });
      mockBillingPlanService.getActivePlan.mockResolvedValue({ meterQuota: 200000, version: 'v1' });

      await requireQuota('scraps', 'create')(req, res, next);

      // incrementMeter and upsert should never be called by the middleware
      expect(mockBillingUsageService.getMeter).toHaveBeenCalledTimes(1);
      // get (legacy path) should not be called at all in meter mode
      expect(mockBillingUsageService.get).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    test('should call SubscriptionRepository in meter mode (degraded-mode gate)', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ status: 'active', pastDueSince: null });
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(mockSubscriptionRepository.findByOrganization).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    test('should allow through with billingDegraded flag when past_due within grace period (J+5)', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        status: 'past_due',
        pastDueSince: fiveDaysAgo,
      });
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      res.locals = {};
      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.locals.billingDegraded).toBe(true);
      expect(res.status).not.toHaveBeenCalledWith(402);
    });

    test('grace period reads from config — custom gracePeriodDays=3 blocks at J+4', async () => {
      mockConfig.billing.gracePeriodDays = 3;
      const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        status: 'past_due',
        pastDueSince: fourDaysAgo,
      });
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      res.locals = {};
      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.type).toBe('PAYMENT_PAST_DUE');
    });

    test('should return 402 PAYMENT_PAST_DUE when past_due and grace period elapsed (J+10)', async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        status: 'past_due',
        pastDueSince: tenDaysAgo,
      });
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      res.locals = {};
      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.type).toBe('PAYMENT_PAST_DUE');
      expect(errData.subscriptionStatus).toBe('past_due');
    });

    test('should NOT block past_due with no pastDueSince set (legacy/missing field)', async () => {
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        status: 'past_due',
        pastDueSince: null,
      });
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      res.locals = {};
      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.locals.billingDegraded).toBeUndefined();
    });

    test('should return 402 PAYMENT_PAST_DUE at exactly the 7-day boundary', async () => {
      // Exactly 7 days ago → elapsed >= gracePeriodMs → block
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 1);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        status: 'past_due',
        pastDueSince: sevenDaysAgo,
      });
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      res.locals = {};
      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
    });

    test('should bypass meter quota for admin user', async () => {
      req.user = { roles: ['admin'] };
      // getMeter would return exhausted, but admin should bypass
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 5000, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      // Short-circuit: no downstream meter/subscription lookups
      expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
      expect(mockBillingUsageService.getMeter).not.toHaveBeenCalled();
      expect(mockBillingExtraBalanceRepository.getBalance).not.toHaveBeenCalled();
    });

    test('should bypass meter quota for meterExempt organization', async () => {
      req.organization = { _id: '507f1f77bcf86cd799439011', meterExempt: true };
      // getMeter would return exhausted, but exempt org should bypass
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 5000, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      // Short-circuit: no downstream meter/subscription lookups
      expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
      expect(mockBillingUsageService.getMeter).not.toHaveBeenCalled();
      expect(mockBillingExtraBalanceRepository.getBalance).not.toHaveBeenCalled();
    });

    test('degraded J+5: still blocks if meter is exhausted', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({
        status: 'past_due',
        pastDueSince: fiveDaysAgo,
      });
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 5000, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      res.locals = {};
      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.type).toBe('METER_EXHAUSTED');
    });
  });
});
