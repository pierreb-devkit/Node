/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

import { effectivePlanOf } from '../lib/billing.statuses.js';

/**
 * Unit tests for the billing reads other modules call (effective plan, subscription
 * status, extras balance) and the one effective-plan rule behind them.
 */

const mockFindByOrganization = jest.fn();
jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
  default: { findByOrganization: mockFindByOrganization },
}));

const mockGetBalance = jest.fn();
jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
  default: { getBalance: mockGetBalance },
}));

jest.unstable_mockModule('../lib/billing.stripe.js', () => ({ default: jest.fn(() => null) }));
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const { default: BillingService } = await import('../services/billing.service.js');

describe('Billing public reads unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('effectivePlanOf', () => {
    test.each([
      [null, 'free'],
      [{ status: 'active', plan: 'pro' }, 'pro'],
      [{ status: 'trialing', plan: 'starter' }, 'starter'],
      [{ status: 'active' }, 'free'],
      [{ status: 'past_due', plan: 'pro' }, 'free'],
      [{ status: 'canceled', plan: 'pro' }, 'free'],
    ])('%j → %s', (subscription, expected) => {
      expect(effectivePlanOf(subscription)).toBe(expected);
    });
  });

  test('getEffectivePlan reads the local subscription', async () => {
    mockFindByOrganization.mockResolvedValue({ status: 'active', plan: 'pro' });
    await expect(BillingService.getEffectivePlan('org1')).resolves.toBe('pro');
    expect(mockFindByOrganization).toHaveBeenCalledWith('org1');
  });

  test('getSubscriptionStatus returns the status, or null without a subscription', async () => {
    mockFindByOrganization.mockResolvedValueOnce({ status: 'past_due' }).mockResolvedValueOnce(null);
    await expect(BillingService.getSubscriptionStatus('org1')).resolves.toBe('past_due');
    await expect(BillingService.getSubscriptionStatus('org2')).resolves.toBeNull();
  });

  test('getExtrasBalance returns the cached balance', async () => {
    mockGetBalance.mockResolvedValue(42);
    await expect(BillingService.getExtrasBalance('org1')).resolves.toBe(42);
    expect(mockGetBalance).toHaveBeenCalledWith('org1');
  });
});
