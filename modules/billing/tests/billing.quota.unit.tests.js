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

  // ── Meter mode (meterMode: true) ───────────────────────────────────────────

  describe('meter mode (meterMode: true)', () => {
    let mockBillingExtraBalanceRepository;

    beforeEach(async () => {
      jest.resetModules();

      mockConfig = {
        billing: {
          meterMode: true,
          quotas: {},
          packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
          upgradeUrl: '/billing/plans',
        },
      };

      mockBillingUsageService = {
        get: jest.fn(),
        getMeter: jest.fn(),
      };

      mockBillingExtraBalanceRepository = {
        getBalance: jest.fn(),
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

    test('should return 402 when meter doc is null (no usage yet) and no extras', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      // meterUsed=0, meterQuota=0 → remaining = (0-0)+0 = 0 → 402
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
    });

    test('should not call SubscriptionRepository in meter mode', async () => {
      mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await requireQuota('scraps', 'create')(req, res, next);

      expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
    });
  });
});
