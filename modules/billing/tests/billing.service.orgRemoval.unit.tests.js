/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingService.deleteOrganizationData (org-removal cleanup).
 */
describe('BillingService.deleteOrganizationData unit tests:', () => {
  let BillingService;
  let mockSubscriptionRepository;
  let mockUsageRepository;
  let mockExtraBalanceRepository;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = { deleteByOrganization: jest.fn().mockResolvedValue({ deletedCount: 1 }) };
    mockUsageRepository = { deleteByOrganization: jest.fn().mockResolvedValue({ deletedCount: 4 }) };
    mockExtraBalanceRepository = { deleteByOrganization: jest.fn().mockResolvedValue({ deletedCount: 1 }) };

    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({ default: mockSubscriptionRepository }));
    jest.unstable_mockModule('../repositories/billing.usage.repository.js', () => ({ default: mockUsageRepository }));
    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({ default: mockExtraBalanceRepository }));
    jest.unstable_mockModule('../services/billing.plans.service.js', () => ({ default: {} }));
    jest.unstable_mockModule('../lib/billing.stripe.js', () => ({ default: jest.fn() }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: { billing: {} } }));

    BillingService = (await import('../services/billing.service.js')).default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('deletes the subscription, usage and extras balance of the organization', async () => {
    const result = await BillingService.deleteOrganizationData(orgId);

    expect(mockSubscriptionRepository.deleteByOrganization).toHaveBeenCalledWith(orgId);
    expect(mockUsageRepository.deleteByOrganization).toHaveBeenCalledWith(orgId);
    expect(mockExtraBalanceRepository.deleteByOrganization).toHaveBeenCalledWith(orgId);
    expect(result).toEqual({ subscriptions: 1, usage: 4, extraBalances: 1 });
  });

  test('accepts an ObjectId-like value (stringified)', async () => {
    await BillingService.deleteOrganizationData({ toString: () => orgId });
    expect(mockSubscriptionRepository.deleteByOrganization).toHaveBeenCalledWith(orgId);
  });

  test.each([[undefined], [null], [''], ['not-an-id']])(
    'throws and deletes nothing for an invalid organization id (%p)',
    async (badId) => {
      await expect(BillingService.deleteOrganizationData(badId)).rejects.toThrow('invalid organization id');
      expect(mockSubscriptionRepository.deleteByOrganization).not.toHaveBeenCalled();
      expect(mockUsageRepository.deleteByOrganization).not.toHaveBeenCalled();
      expect(mockExtraBalanceRepository.deleteByOrganization).not.toHaveBeenCalled();
    },
  );

  test('one failing delete never skips the others, and the failure is re-raised', async () => {
    mockUsageRepository.deleteByOrganization.mockRejectedValueOnce(new Error('usage down'));

    const err = await BillingService.deleteOrganizationData(orgId).catch((e) => e);

    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.map((e) => e.message)).toEqual(['usage down']);
    expect(mockSubscriptionRepository.deleteByOrganization).toHaveBeenCalled();
    expect(mockExtraBalanceRepository.deleteByOrganization).toHaveBeenCalled();
  });
});
