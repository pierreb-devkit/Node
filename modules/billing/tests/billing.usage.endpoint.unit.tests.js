/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for billing usage endpoint (getUsage controller)
 */
describe('Billing usage endpoint unit tests:', () => {
  let billingController;
  let mockSubscriptionRepository;
  let mockBillingUsageService;
  let mockConfig;
  let res;

  const orgId = '507f1f77bcf86cd799439011';

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
          free: { documents: { create: 5 }, requests: { execute: 100 } },
          starter: { documents: { create: 20 }, requests: { execute: 2000 } },
          pro: { documents: { create: Infinity }, requests: { execute: Infinity } },
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

    // Mock BillingService to avoid stripe dependency
    jest.unstable_mockModule('../services/billing.service.js', () => ({
      default: {},
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
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'starter', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'documents.create': 5, 'requests.execute': 42 } });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'billing usage',
      data: expect.objectContaining({
        plan: 'starter',
        usage: { 'documents.create': 5, 'requests.execute': 42 },
        limits: { 'documents.create': 20, 'requests.execute': 2000 },
      }),
    }));
  });

  test('should return free plan when no subscription', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
    mockBillingUsageService.get.mockResolvedValue({ counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      data: expect.objectContaining({
        plan: 'free',
        limits: { 'documents.create': 5, 'requests.execute': 100 },
      }),
    }));
  });

  test('should return free plan when subscription is past_due', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'starter', status: 'past_due' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'documents.create': 2 } });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plan: 'free',
        limits: { 'documents.create': 5, 'requests.execute': 100 },
      }),
    }));
  });

  test('should return empty limits when plan has no quota config', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'enterprise', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: {} });

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
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        plan: 'pro',
        limits: { 'documents.create': Infinity, 'requests.execute': Infinity },
      }),
    }));
  });

  test('should return empty counters for new org (no usage yet)', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'starter', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        usage: {},
      }),
    }));
  });

  test('should return correct period in YYYY-MM format', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: {} });

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const { data } = res.json.mock.calls[0][0];
    expect(data.period).toMatch(/^\d{4}-\d{2}$/);
  });

  test('should return 500 when an error occurs', async () => {
    mockSubscriptionRepository.findByOrganization.mockRejectedValue(new Error('DB error'));

    const req = { organization: { _id: orgId } };
    await billingController.getUsage(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Internal Server Error',
    }));
  });
});
