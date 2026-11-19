/**
 * Unit tests — BillingService.assertNoLiveSubscription, the organization-removal guard
 * billing registers in billing.init.js (#4321): refuse while a paid subscription is
 * live at the provider, allow otherwise. Local DB read only.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockFindByOrganization = jest.fn();

jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
  default: { findByOrganization: mockFindByOrganization },
}));

const { default: BillingService } = await import('../services/billing.service.js');

describe('BillingService.assertNoLiveSubscription (#4321):', () => {
  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(['active', 'trialing', 'past_due'])('refuses with 409 ORGANIZATION_HAS_LIVE_SUBSCRIPTION while a paid subscription is %s', async (status) => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status, stripeSubscriptionId: 'sub_123' });

    await expect(BillingService.assertNoLiveSubscription(orgId)).rejects.toMatchObject({
      name: 'AppError',
      status: 409,
      code: 'ORGANIZATION_HAS_LIVE_SUBSCRIPTION',
      description: "Cancel the organization's subscription before removing it.",
    });
    expect(mockFindByOrganization).toHaveBeenCalledWith(orgId);
  });

  test('names the organization in the refusal when its name is known', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status: 'active', stripeSubscriptionId: 'sub_123' });

    await expect(BillingService.assertNoLiveSubscription(orgId, { _id: orgId, name: 'Acme' })).rejects.toMatchObject({
      status: 409,
      code: 'ORGANIZATION_HAS_LIVE_SUBSCRIPTION',
      description: 'Cancel the subscription of "Acme" before removing it.',
    });
  });

  test.each(['active', 'trialing', 'past_due'])('allows removal of a %s subscription already set to end at period end (counts as cancelled)', async (status) => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status, stripeSubscriptionId: 'sub_123', cancelAtPeriodEnd: true });

    await expect(BillingService.assertNoLiveSubscription(orgId)).resolves.toBeUndefined();
  });

  test.each(['active', 'trialing', 'past_due'])('allows removal of a %s subscription cancelled at a set date (cancelAt, portal cancel) with cancelAtPeriodEnd false', async (status) => {
    mockFindByOrganization.mockResolvedValue({
      plan: 'pro',
      status,
      stripeSubscriptionId: 'sub_123',
      cancelAtPeriodEnd: false,
      cancelAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });

    await expect(BillingService.assertNoLiveSubscription(orgId)).resolves.toBeUndefined();
  });

  test('still refuses when cancelAt is null and cancelAtPeriodEnd false', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status: 'active', stripeSubscriptionId: 'sub_123', cancelAtPeriodEnd: false, cancelAt: null });

    await expect(BillingService.assertNoLiveSubscription(orgId)).rejects.toMatchObject({ status: 409 });
  });

  test('still refuses when cancelAtPeriodEnd is explicitly false', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status: 'active', stripeSubscriptionId: 'sub_123', cancelAtPeriodEnd: false });

    await expect(BillingService.assertNoLiveSubscription(orgId)).rejects.toMatchObject({ status: 409 });
  });

  test.each(['canceled', 'incomplete_expired', 'unpaid', 'paused'])('allows removal once the subscription is %s', async (status) => {
    mockFindByOrganization.mockResolvedValue({ plan: 'pro', status, stripeSubscriptionId: 'sub_123' });

    await expect(BillingService.assertNoLiveSubscription(orgId)).resolves.toBeUndefined();
  });

  test('allows removal when the organization has no subscription', async () => {
    mockFindByOrganization.mockResolvedValue(null);

    await expect(BillingService.assertNoLiveSubscription(orgId)).resolves.toBeUndefined();
  });

  test('allows removal of a free organization whose shell row is active with no provider subscription', async () => {
    mockFindByOrganization.mockResolvedValue({ plan: 'free', status: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: null });

    await expect(BillingService.assertNoLiveSubscription(orgId)).resolves.toBeUndefined();
  });

  test('accepts an ObjectId-like organizationId (stringified before the lookup)', async () => {
    mockFindByOrganization.mockResolvedValue(null);

    await BillingService.assertNoLiveSubscription({ toString: () => orgId });

    expect(mockFindByOrganization).toHaveBeenCalledWith(orgId);
  });
});
