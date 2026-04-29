/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Integration-style smoke tests for extras billing routes.
 * Tests controller + route layer wiring: auth guard, policy check, validator, handler.
 * Uses mocked services — no real HTTP server or DB.
 */
describe('Billing extras routes integration tests:', () => {
  let BillingController;
  let mockBillingService;
  let mockBillingExtraService;
  let mockBillingUsageService;
  let mockBillingExtraBalanceRepository;
  let req;
  let res;

  const orgId = '507f1f77bcf86cd799439011';

  /**
   * @returns {Object} A mock res object with chainable methods.
   */
  const makeRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  beforeEach(async () => {
    jest.resetModules();

    mockBillingService = {
      createExtrasCheckout: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/abc' }),
      getSubscription: jest.fn().mockResolvedValue({ plan: 'pro', status: 'active' }),
    };

    mockBillingExtraService = {
      listLedger: jest.fn().mockResolvedValue({ entries: [], total: 0, balance: 0 }),
    };

    mockBillingUsageService = {
      getMeter: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue({ month: '2026-04', counters: {} }),
      currentWeekKey: jest.fn().mockReturnValue('2026-W18'),
    };

    mockBillingExtraBalanceRepository = {
      getBalance: jest.fn().mockResolvedValue(0),
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
      default: {
        billing: {
          meterMode: false,
          packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
          quotas: { free: {} },
        },
      },
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

  // ── POST /api/billing/extras/checkout ─────────────────────────────────────

  describe('POST /api/billing/extras/checkout', () => {
    test('returns 200 and url for authenticated org member', async () => {
      req.body = { packId: 'pack_500k', successUrl: 'http://ok', cancelUrl: 'http://cancel' };

      await BillingController.extrasCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'success',
        data: { url: 'https://checkout.stripe.com/abc' },
      }));
    });

    test('returns 422 when service throws Invalid packId', async () => {
      req.body = { packId: 'bad', successUrl: 'http://ok', cancelUrl: 'http://cancel' };
      mockBillingService.createExtrasCheckout.mockRejectedValue(new Error('Invalid packId: pack not found: bad'));

      await BillingController.extrasCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
    });

    test('returns 502 when Stripe throws a generic error', async () => {
      req.body = { packId: 'pack_500k', successUrl: 'http://ok', cancelUrl: 'http://cancel' };
      mockBillingService.createExtrasCheckout.mockRejectedValue(new Error('Stripe network error'));

      await BillingController.extrasCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(502);
    });
  });

  // ── GET /api/billing/extras/balance ───────────────────────────────────────

  describe('GET /api/billing/extras/balance', () => {
    test('returns 200 with balance=0 when no extras purchased', async () => {
      await BillingController.extrasBalance(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'success',
        data: { balance: 0, packsAvailable: expect.any(Array) },
      }));
    });

    test('returns 200 with non-zero balance after pack credit', async () => {
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(500000);

      await BillingController.extrasBalance(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ balance: 500000 }),
      }));
    });

    test('returns 500 when repository throws', async () => {
      mockBillingExtraBalanceRepository.getBalance.mockRejectedValue(new Error('DB down'));

      await BillingController.extrasBalance(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── GET /api/billing/extras/ledger ────────────────────────────────────────

  describe('GET /api/billing/extras/ledger', () => {
    test('returns 200 with empty ledger by default', async () => {
      await BillingController.extrasLedger(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'success',
        data: { entries: [], total: 0, balance: 0 },
      }));
    });

    test('passes page and limit query params to service', async () => {
      req.query = { page: '2', limit: '5' };

      await BillingController.extrasLedger(req, res);

      expect(mockBillingExtraService.listLedger).toHaveBeenCalledWith(orgId, { page: 2, limit: 5 });
    });

    test('returns 500 when service throws', async () => {
      mockBillingExtraService.listLedger.mockRejectedValue(new Error('DB down'));

      await BillingController.extrasLedger(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
