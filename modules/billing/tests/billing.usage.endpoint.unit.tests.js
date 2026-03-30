/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing usage endpoint (getUsage controller)
 */
describe('Billing usage endpoint unit tests:', () => {
  let billingController;
  let mockBillingService;
  let mockBillingUsageService;
  let mockConfig;
  let res;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockBillingService = {
      getSubscription: jest.fn(),
    };

    mockBillingUsageService = {
      get: jest.fn(),
    };

    mockConfig = {
      billing: {
        quotas: {
          free: { documents: { create: 5 }, requests: { execute: 100 } },
          starter: { documents: { create: 20 }, requests: { execute: 2000 } },
          pro: { documents: { create: Infinity }, requests: { execute: Infinity } },
        },
      },
    };

    jest.unstable_mockModule('../services/billing.service.js', () => ({
      default: mockBillingService,
    }));

    jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
      default: mockBillingUsageService,
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    const mod = await import('../controllers/billing.controller.js');
    billingController = mod.default;

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should return usage and limits for active subscription', async () => {
    mockBillingService.getSubscription.mockResolvedValue({ plan: 'starter', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: { 'documents_create': 5, 'requests_execute': 42 } });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'billing usage',
      data: expect.objectContaining({
        plan: 'starter',
        usage: { 'documents_create': 5, 'requests_execute': 42 },
        limits: { 'documents_create': 20, 'requests_execute': 2000 },
      }),
    }));
  });

  test('should return free plan when no subscription', async () => {
    mockBillingService.getSubscription.mockResolvedValue(null);
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      data: expect.objectContaining({
        plan: 'free',
        limits: { 'documents_create': 5, 'requests_execute': 100 },
      }),
    }));
  });

  test.each([
    'past_due',
    'canceled',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'paused',
  ])('should return free plan when subscription status is %s', async (status) => {
    mockBillingService.getSubscription.mockResolvedValue({ plan: 'starter', status });
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: { 'documents_create': 2 } });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plan: 'free',
        limits: { 'documents_create': 5, 'requests_execute': 100 },
      }),
    }));
  });

  test('should return paid plan when subscription status is trialing', async () => {
    mockBillingService.getSubscription.mockResolvedValue({ plan: 'starter', status: 'trialing' });
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plan: 'starter',
        limits: { 'documents_create': 20, 'requests_execute': 2000 },
      }),
    }));
  });

  test('should return empty limits when plan has no quota config', async () => {
    mockBillingService.getSubscription.mockResolvedValue({ plan: 'enterprise', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plan: 'enterprise',
        limits: {},
      }),
    }));
  });

  test('should return correct flattened limits format', async () => {
    mockBillingService.getSubscription.mockResolvedValue({ plan: 'pro', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plan: 'pro',
        limits: { 'documents_create': null, 'requests_execute': null },
      }),
    }));
  });

  test('should return empty counters for new org (no usage yet)', async () => {
    mockBillingService.getSubscription.mockResolvedValue({ plan: 'starter', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        usage: {},
      }),
    }));
  });

  test('should return period from usage month field', async () => {
    mockBillingService.getSubscription.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ month: '2026-03', counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const { data } = res.json.mock.calls[0][0];
    expect(data.period).toBe('2026-03');
  });

  test('should return 500 when an error occurs', async () => {
    mockBillingService.getSubscription.mockRejectedValue(new Error('DB error'));

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Internal Server Error',
    }));
  });
});
