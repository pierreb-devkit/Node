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
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps.create': 1 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should return 429 when at quota limit', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps.create': 3 } });

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
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps.create': 5 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  test('should treat missing subscription as free plan', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps.create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      code: 429,
    }));
  });

  test('should treat past_due subscription as free plan', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'starter', status: 'past_due' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps.create': 3 } });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      code: 429,
    }));
  });

  test('should allow unlimited (Infinity) without checking usage', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'active' });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockBillingUsageService.get).not.toHaveBeenCalled();
  });

  test('should return correct error payload with upgradeUrl', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { 'scraps.execute': 100 } });

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

  test('should treat zero usage as under quota', async () => {
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: {} });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
