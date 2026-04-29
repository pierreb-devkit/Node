/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.attachUsageContext middleware
 */
describe('billing.attachUsageContext middleware unit tests:', () => {
  let attachUsageContext;
  let mockBillingUsageService;
  let mockBillingExtraBalanceRepository;
  let mockConfig;
  let req;
  let res;
  let next;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockBillingUsageService = {
      getMeter: jest.fn(),
    };

    mockBillingExtraBalanceRepository = {
      getBalance: jest.fn(),
    };

    mockConfig = {
      billing: {
        meterMode: true,
      },
    };

    jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
      default: mockBillingUsageService,
    }));

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockBillingExtraBalanceRepository,
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      },
    }));

    const mod = await import('../middlewares/billing.attachUsageContext.js');
    attachUsageContext = mod.default;

    req = {
      organization: { _id: orgId },
    };

    res = {
      setHeader: jest.fn(),
    };

    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should decorate req.meterContext with meter data', async () => {
    mockBillingUsageService.getMeter.mockResolvedValue({
      meterUsed: 1200,
      meterQuota: 5000,
      meterBreakdown: { scrape: 1000, llm: 200 },
    });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(2500);

    await attachUsageContext(req, res, next);

    expect(req.meterContext).toEqual({
      used: 1200,
      quota: 5000,
      extrasRemaining: 2500,
      breakdown: { scrape: 1000, llm: 200 },
    });
    expect(next).toHaveBeenCalled();
  });

  test('should set X-Meter-Remaining header', async () => {
    mockBillingUsageService.getMeter.mockResolvedValue({
      meterUsed: 1000,
      meterQuota: 5000,
      meterBreakdown: {},
    });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(500);

    await attachUsageContext(req, res, next);

    // remaining = (5000 - 1000) + 500 = 4500
    expect(res.setHeader).toHaveBeenCalledWith('X-Meter-Remaining', '4500');
    expect(next).toHaveBeenCalled();
  });

  test('should be a no-op when meterMode is false', async () => {
    mockConfig.billing.meterMode = false;

    await attachUsageContext(req, res, next);

    expect(mockBillingUsageService.getMeter).not.toHaveBeenCalled();
    expect(mockBillingExtraBalanceRepository.getBalance).not.toHaveBeenCalled();
    expect(req.meterContext).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  test('should be a no-op when req.organization is missing', async () => {
    req.organization = undefined;

    await attachUsageContext(req, res, next);

    expect(mockBillingUsageService.getMeter).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test('should call next() even when getMeter throws (non-blocking failure)', async () => {
    mockBillingUsageService.getMeter.mockRejectedValue(new Error('DB error'));
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    await attachUsageContext(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.meterContext).toBeUndefined();
  });

  test('should handle null meter doc gracefully (zeros)', async () => {
    mockBillingUsageService.getMeter.mockResolvedValue(null);
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(100);

    await attachUsageContext(req, res, next);

    expect(req.meterContext).toEqual({
      used: 0,
      quota: 0,
      extrasRemaining: 100,
      breakdown: {},
    });
    // remaining = (0 - 0) + 100 = 100
    expect(res.setHeader).toHaveBeenCalledWith('X-Meter-Remaining', '100');
    expect(next).toHaveBeenCalled();
  });

  test('should not throw 500 when getBalance also fails', async () => {
    mockBillingUsageService.getMeter.mockRejectedValue(new Error('DB error on getMeter'));
    mockBillingExtraBalanceRepository.getBalance.mockRejectedValue(new Error('DB error on getBalance'));

    await attachUsageContext(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
