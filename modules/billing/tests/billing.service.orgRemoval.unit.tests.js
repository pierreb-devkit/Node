/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for BillingService.cleanupOrganizationData (org-removal cleanup):
 * subscription + extras balance anonymized under one tombstone id, usage deleted.
 */
describe('BillingService.cleanupOrganizationData unit tests:', () => {
  let BillingService;
  let mockSubscriptionRepository;
  let mockUsageRepository;
  let mockExtraBalanceRepository;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockSubscriptionRepository = { tombstoneByOrganization: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    mockUsageRepository = { deleteByOrganization: jest.fn().mockResolvedValue({ deletedCount: 4 }) };
    mockExtraBalanceRepository = { tombstoneByOrganization: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };

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

  test('anonymizes the subscription and extras balance under one fresh tombstone id, deletes usage', async () => {
    const result = await BillingService.cleanupOrganizationData(orgId);

    const [subOrg, subTombstone] = mockSubscriptionRepository.tombstoneByOrganization.mock.calls[0];
    const [balOrg, balTombstone] = mockExtraBalanceRepository.tombstoneByOrganization.mock.calls[0];
    expect(subOrg).toBe(orgId);
    expect(balOrg).toBe(orgId);
    expect(subTombstone).toMatch(/^[0-9a-f]{24}$/);
    expect(subTombstone).not.toBe(orgId);
    expect(balTombstone).toBe(subTombstone);
    expect(mockUsageRepository.deleteByOrganization).toHaveBeenCalledWith(orgId);
    expect(result).toEqual({ tombstoneId: subTombstone, subscriptions: 1, extraBalances: 1, usage: 4 });
  });

  test('each removal gets its own tombstone id', async () => {
    const first = await BillingService.cleanupOrganizationData(orgId);
    const second = await BillingService.cleanupOrganizationData('507f1f77bcf86cd799439022');
    expect(first.tombstoneId).not.toBe(second.tombstoneId);
  });

  test('accepts an ObjectId-like value (stringified)', async () => {
    await BillingService.cleanupOrganizationData({ toString: () => orgId });
    expect(mockSubscriptionRepository.tombstoneByOrganization).toHaveBeenCalledWith(orgId, expect.any(String));
  });

  test.each([[undefined], [null], [''], ['not-an-id']])(
    'throws and writes nothing for an invalid organization id (%p)',
    async (badId) => {
      await expect(BillingService.cleanupOrganizationData(badId)).rejects.toThrow('invalid organization id');
      expect(mockSubscriptionRepository.tombstoneByOrganization).not.toHaveBeenCalled();
      expect(mockUsageRepository.deleteByOrganization).not.toHaveBeenCalled();
      expect(mockExtraBalanceRepository.tombstoneByOrganization).not.toHaveBeenCalled();
    },
  );

  test('one failing write never skips the others, and the failure is re-raised', async () => {
    mockUsageRepository.deleteByOrganization.mockRejectedValueOnce(new Error('usage down'));

    const err = await BillingService.cleanupOrganizationData(orgId).catch((e) => e);

    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.map((e) => e.message)).toEqual(['usage down']);
    expect(err.message).toContain('usage: usage down');
    expect(err.message).not.toContain('subscription:');
    expect(mockSubscriptionRepository.tombstoneByOrganization).toHaveBeenCalled();
    expect(mockExtraBalanceRepository.tombstoneByOrganization).toHaveBeenCalled();
  });
});
