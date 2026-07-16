/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for the shared plan resolver (`../lib/billing.planResolver.js`).
 * Extracted from billing.webhook.service.js (#3964/#1250) so the webhook handler, the admin
 * force-sync tool, and the reconcile cron all resolve a Stripe subscription's plan via ONE
 * implementation instead of three drifted copies.
 */
describe('billing.planResolver unit tests:', () => {
  let buildPriceIdToPlanMap;
  let resolvePlanFromSubscription;
  let lookupPlanByPriceId;
  let mockLogger;

  const mockConfig = {
    billing: { plans: ['free', 'starter', 'pro', 'enterprise'] },
    stripe: {
      prices: {
        starter: { monthly: 'price_starter_monthly', annual: 'price_starter_annual' },
        pro: { monthly: 'price_pro_monthly', annual: 'price_pro_annual' },
        // 'enterprise' deliberately has no Stripe price — sold manually, never mapped.
      },
    },
  };

  beforeEach(async () => {
    jest.resetModules();
    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));

    const mod = await import('../lib/billing.planResolver.js');
    ({ buildPriceIdToPlanMap, resolvePlanFromSubscription, lookupPlanByPriceId } = mod);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('buildPriceIdToPlanMap:', () => {
    test('maps monthly + annual priceIds to their planId', () => {
      const map = buildPriceIdToPlanMap();
      expect(map).toEqual({
        price_starter_monthly: 'starter',
        price_starter_annual: 'starter',
        price_pro_monthly: 'pro',
        price_pro_annual: 'pro',
      });
    });

    test('skips plan entries not present in the valid-plans enum', async () => {
      jest.resetModules();
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          billing: { plans: ['free', 'starter', 'pro', 'enterprise'] },
          stripe: {
            prices: {
              starter: { monthly: 'price_starter_monthly' },
              // 'legacy_gold' is not in billing.plans — must be excluded from the map.
              legacy_gold: { monthly: 'price_legacy_gold_monthly' },
            },
          },
        },
      }));
      jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));

      const { buildPriceIdToPlanMap: freshBuild } = await import('../lib/billing.planResolver.js');
      const map = freshBuild();

      expect(map).toEqual({ price_starter_monthly: 'starter' });
      expect(map.price_legacy_gold_monthly).toBeUndefined();
    });
  });

  describe('resolvePlanFromSubscription — priceId map (primary):', () => {
    test('resolves via priceId map when metadata.planId is absent (real Stripe payload)', () => {
      const plan = resolvePlanFromSubscription({
        id: 'sub_1',
        items: { data: [{ price: { id: 'price_pro_monthly', metadata: {} } }] },
      });
      expect(plan).toBe('pro');
    });

    test('resolves annual priceId to the correct plan', () => {
      const plan = resolvePlanFromSubscription({
        id: 'sub_2',
        items: { data: [{ price: { id: 'price_starter_annual', metadata: {} } }] },
      });
      expect(plan).toBe('starter');
    });

    test('priceId map takes priority over conflicting metadata.planId', () => {
      const plan = resolvePlanFromSubscription({
        id: 'sub_3',
        items: { data: [{ price: { id: 'price_starter_monthly', metadata: { planId: 'pro' } } }] },
      });
      expect(plan).toBe('starter');
    });
  });

  describe('resolvePlanFromSubscription — metadata fallback (legacy):', () => {
    test('falls back to price.metadata.planId when priceId is not mapped', () => {
      const plan = resolvePlanFromSubscription({
        id: 'sub_4',
        items: { data: [{ price: { id: 'price_fixture_unknown', metadata: { planId: 'pro' } } }] },
      });
      expect(plan).toBe('pro');
    });

    test('falls back to plan.metadata.planId when price.metadata is absent', () => {
      const plan = resolvePlanFromSubscription({
        id: 'sub_5',
        items: { data: [{ price: {}, plan: { metadata: { planId: 'starter' } } }] },
      });
      expect(plan).toBe('starter');
    });
  });

  describe('resolvePlanFromSubscription — unresolvable (null):', () => {
    test('returns null and warns when priceId is unmapped and metadata is absent', () => {
      const plan = resolvePlanFromSubscription(
        { id: 'sub_6', items: { data: [{ price: { id: 'price_unmapped_xyz', metadata: {} } }] } },
        { logPrefix: '[billing.test]' },
      );
      expect(plan).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[billing.test] resolvePlanFromSubscription: priceId not in priceIdToPlan map and no metadata',
        expect.objectContaining({ priceId: 'price_unmapped_xyz', stripeSubscriptionId: 'sub_6' }),
      );
    });

    test('returns null and warns when metadata.planId is present but not a valid plan', () => {
      const plan = resolvePlanFromSubscription(
        { id: 'sub_7', items: { data: [{ price: { metadata: { planId: 'prod_unknownXYZ' } } }] } },
        { logPrefix: '[billing.test]' },
      );
      expect(plan).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[billing.test] resolvePlanFromSubscription: unrecognized planId in metadata',
        expect.objectContaining({ raw: 'prod_unknownXYZ' }),
      );
    });

    test('returns null for a subscription with no items (defensive)', () => {
      expect(resolvePlanFromSubscription({ id: 'sub_8' })).toBeNull();
      expect(resolvePlanFromSubscription(null)).toBeNull();
    });
  });

  describe('lookupPlanByPriceId:', () => {
    test('returns the plan for a known priceId', () => {
      expect(lookupPlanByPriceId('price_pro_monthly')).toBe('pro');
    });

    test('returns undefined for an unmapped or missing priceId', () => {
      expect(lookupPlanByPriceId('price_unknown')).toBeUndefined();
      expect(lookupPlanByPriceId(undefined)).toBeUndefined();
    });
  });
});
