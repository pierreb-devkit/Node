/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for extras controller handlers: extrasCheckout, extrasBalance, extrasLedger,
 * and the updated getUsage (meter mode).
 */
describe('Billing extras controller unit tests:', () => {
  let BillingController;
  let mockBillingService;
  let mockBillingExtraService;
  let mockBillingUsageService;
  let mockBillingExtraBalanceRepository;
  let mockConfig;
  let req;
  let res;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @returns {Object} A mock res object with chainable methods.
   */
  const makeRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  });

  beforeEach(async () => {
    jest.resetModules();

    mockBillingService = {
      createExtrasCheckout: jest.fn(),
      getSubscription: jest.fn(),
    };

    mockBillingExtraService = {
      listLedger: jest.fn(),
    };

    mockBillingUsageService = {
      getMeter: jest.fn(),
      get: jest.fn(),
      currentWeekKey: jest.fn().mockReturnValue('2026-W18'),
    };

    mockBillingExtraBalanceRepository = {
      getBalance: jest.fn(),
    };

    mockConfig = {
      billing: {
        meterMode: false,
        packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
        quotas: {
          free: { scraps: { create: 3 } },
        },
      },
    };

    jest.unstable_mockModule('../services/billing.service.js', () => ({
      default: mockBillingService,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockBillingExtraService,
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

    jest.unstable_mockModule('../lib/constants.js', () => ({
      activeStatuses: ['active', 'trialing'],
    }));

    const mod = await import('../controllers/billing.controller.js');
    BillingController = mod.default;

    req = {
      organization: { _id: orgId },
      body: {},
      query: {},
    };

    res = makeRes();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── extrasCheckout ─────────────────────────────────────────────────────────

  describe('extrasCheckout', () => {
    test('should return 200 with url on success', async () => {
      req.body = { packId: 'pack_500k', successUrl: 'http://ok', cancelUrl: 'http://cancel' };
      mockBillingService.createExtrasCheckout.mockResolvedValue({ url: 'https://checkout.stripe.com/abc' });

      await BillingController.extrasCheckout(req, res);

      expect(mockBillingService.createExtrasCheckout).toHaveBeenCalledWith(
        req.organization, 'pack_500k', 'http://ok', 'http://cancel',
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'success',
        data: { url: 'https://checkout.stripe.com/abc' },
      }));
    });

    test('should return 422 when packId is invalid', async () => {
      req.body = { packId: 'pack_unknown', successUrl: 'http://ok', cancelUrl: 'http://cancel' };
      mockBillingService.createExtrasCheckout.mockRejectedValue(new Error('Invalid packId: pack not found: pack_unknown'));

      await BillingController.extrasCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
    });

    test('should return 502 when Stripe call fails with generic error', async () => {
      req.body = { packId: 'pack_500k', successUrl: 'http://ok', cancelUrl: 'http://cancel' };
      mockBillingService.createExtrasCheckout.mockRejectedValue(new Error('Network error'));

      await BillingController.extrasCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(502);
    });

    test('should return 422 when Stripe is not configured', async () => {
      req.body = { packId: 'pack_500k', successUrl: 'http://ok', cancelUrl: 'http://cancel' };
      mockBillingService.createExtrasCheckout.mockRejectedValue(new Error('Invalid redirect URL'));

      await BillingController.extrasCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
    });
  });

  // ── extrasBalance ──────────────────────────────────────────────────────────

  describe('extrasBalance', () => {
    test('should return 200 with balance and packsAvailable', async () => {
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(150000);

      await BillingController.extrasBalance(req, res);

      expect(mockBillingExtraBalanceRepository.getBalance).toHaveBeenCalledWith(orgId);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'success',
        data: {
          balance: 150000,
          packsAvailable: mockConfig.billing.packs,
        },
      }));
    });

    test('should return 500 when repository throws', async () => {
      mockBillingExtraBalanceRepository.getBalance.mockRejectedValue(new Error('DB error'));

      await BillingController.extrasBalance(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── extrasLedger ───────────────────────────────────────────────────────────

  describe('extrasLedger', () => {
    test('should return 200 with paginated ledger', async () => {
      req.query = { page: '1', limit: '10' };
      const ledgerResult = { entries: [{ kind: 'topup', amount: 500000 }], total: 1, balance: 500000 };
      mockBillingExtraService.listLedger.mockResolvedValue(ledgerResult);

      await BillingController.extrasLedger(req, res);

      expect(mockBillingExtraService.listLedger).toHaveBeenCalledWith(orgId, { page: 1, limit: 10 });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'success',
        data: ledgerResult,
      }));
    });

    test('should use default page=1, limit=20 when query params are absent', async () => {
      req.query = {};
      mockBillingExtraService.listLedger.mockResolvedValue({ entries: [], total: 0, balance: 0 });

      await BillingController.extrasLedger(req, res);

      expect(mockBillingExtraService.listLedger).toHaveBeenCalledWith(orgId, { page: 1, limit: 20 });
    });

    test('should cap limit to 100 max', async () => {
      req.query = { page: '1', limit: '999' };
      mockBillingExtraService.listLedger.mockResolvedValue({ entries: [], total: 0, balance: 0 });

      await BillingController.extrasLedger(req, res);

      expect(mockBillingExtraService.listLedger).toHaveBeenCalledWith(orgId, { page: 1, limit: 100 });
    });

    test('should return 500 when service throws', async () => {
      mockBillingExtraService.listLedger.mockRejectedValue(new Error('DB error'));

      await BillingController.extrasLedger(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── getUsage — meter mode ──────────────────────────────────────────────────

  describe('getUsage (meter mode)', () => {
    test('should return meter fields when meterMode=true', async () => {
      mockConfig.billing.meterMode = true;
      mockBillingService.getSubscription.mockResolvedValue({ plan: 'pro', status: 'active' });
      mockBillingUsageService.getMeter.mockResolvedValue({
        weekKey: '2026-W18',
        planVersion: 'v2',
        resetAt: new Date('2026-05-04'),
        meterUsed: 1200,
        meterQuota: 5000,
        meterBreakdown: { scrape: 1000, llm: 200 },
      });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(2500);

      await BillingController.getUsage(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          plan: 'pro',
          planVersion: 'v2',
          weekKey: '2026-W18',
          meterUsed: 1200,
          meterQuota: 5000,
          meterBreakdown: { scrape: 1000, llm: 200 },
          extrasRemaining: 2500,
          packsAvailable: mockConfig.billing.packs,
        }),
      }));
    });

    test('should return zeroed meter fields when meter doc is null', async () => {
      mockConfig.billing.meterMode = true;
      mockBillingService.getSubscription.mockResolvedValue({ plan: 'free', status: 'active' });
      mockBillingUsageService.getMeter.mockResolvedValue(null);
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await BillingController.getUsage(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          meterUsed: 0,
          meterQuota: 0,
          extrasRemaining: 0,
          weekKey: '2026-W18',
        }),
      }));
    });

    test('should return legacy usage shape when meterMode=false', async () => {
      mockConfig.billing.meterMode = false;
      mockBillingService.getSubscription.mockResolvedValue({ plan: 'free', status: 'active' });
      mockBillingUsageService.get.mockResolvedValue({ month: '2026-04', counters: { scraps_create: 1 } });

      await BillingController.getUsage(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          plan: 'free',
          period: '2026-04',
          usage: { scraps_create: 1 },
        }),
      }));
      // meter fields should NOT be present in legacy mode
      const data = res.json.mock.calls[0][0].data;
      expect(data.meterUsed).toBeUndefined();
      expect(data.meterQuota).toBeUndefined();
    });
  });
});
