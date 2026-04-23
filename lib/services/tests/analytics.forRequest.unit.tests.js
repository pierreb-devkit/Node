/**
 * Unit tests for the request-aware feature-flag helpers (#3487).
 *
 * These helpers wrap `getFeatureFlag` / `isFeatureEnabled` and resolve the
 * distinctId from an Express request:
 *   req.user?.id → req.sessionID → 'anonymous'
 *
 * Covers the three canonical cases called out in the issue:
 *   - authenticated user  (req.user.id)
 *   - session-only (anon browsing with a sessionID)
 *   - no req at all (defensive fallback)
 * plus a couple of defensive edge cases.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

describe('analytics request-aware feature-flag helpers:', () => {
  let AnalyticsService;
  let mockPostHogInstance;

  beforeEach(async () => {
    jest.resetModules();

    mockPostHogInstance = {
      capture: jest.fn(),
      identify: jest.fn(),
      groupIdentify: jest.fn(),
      getFeatureFlag: jest.fn().mockResolvedValue('variant-a'),
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };

    jest.unstable_mockModule('posthog-node', () => ({
      PostHog: jest.fn().mockImplementation(() => mockPostHogInstance),
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { posthog: { apiKey: 'phk_test', host: 'https://posthog.test' } },
    }));

    const mod = await import('../analytics.js');
    AnalyticsService = mod.default;
    await AnalyticsService.init();
  });

  afterEach(async () => {
    await AnalyticsService.shutdown();
    jest.restoreAllMocks();
  });

  describe('getFeatureFlagForRequest', () => {
    test('uses req.user.id when authenticated', async () => {
      const req = { user: { id: 'user-42' }, sessionID: 'sess-abc' };

      const result = await AnalyticsService.getFeatureFlagForRequest('checkout-v2', req, { personProperties: { plan: 'pro' } });

      expect(result).toBe('variant-a');
      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith(
        'checkout-v2',
        'user-42',
        { personProperties: { plan: 'pro' } },
      );
    });

    test('falls back to req.sessionID when req.user is absent (anonymous browsing)', async () => {
      const req = { sessionID: 'sess-abc' };

      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', req);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith(
        'checkout-v2',
        'sess-abc',
        undefined,
      );
    });

    test('defaults to "anonymous" when req has neither user nor sessionID', async () => {
      const req = {};

      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', req);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith(
        'checkout-v2',
        'anonymous',
        undefined,
      );
    });

    test('defaults to "anonymous" when req itself is null/undefined (defensive edge)', async () => {
      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', null);
      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', undefined);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenNthCalledWith(1, 'checkout-v2', 'anonymous', undefined);
      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenNthCalledWith(2, 'checkout-v2', 'anonymous', undefined);
    });

    test('ignores req.user when user.id is missing (falls back to sessionID)', async () => {
      const req = { user: { email: 'a@b.com' }, sessionID: 'sess-abc' };

      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', req);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith(
        'checkout-v2',
        'sess-abc',
        undefined,
      );
    });

    test('coerces non-string user.id to string', async () => {
      const req = { user: { id: 42 } };

      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', req);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith(
        'checkout-v2',
        '42',
        undefined,
      );
    });

    test('accepts user.id === 0 (nullish-check, not truthy)', async () => {
      const req = { user: { id: 0 }, sessionID: 'sess-abc' };

      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', req);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith(
        'checkout-v2',
        '0',
        undefined,
      );
    });

    test('accepts empty string sessionID when req.user is absent', async () => {
      const req = { sessionID: '' };

      await AnalyticsService.getFeatureFlagForRequest('checkout-v2', req);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith(
        'checkout-v2',
        '',
        undefined,
      );
    });

    test('returns undefined when PostHog is not configured', async () => {
      await AnalyticsService.shutdown();
      jest.resetModules();
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { posthog: {} },
      }));
      const mod = await import('../analytics.js');
      const svc = mod.default;
      await svc.init();

      const result = await svc.getFeatureFlagForRequest('checkout-v2', { user: { id: 'user-42' } });

      expect(result).toBeUndefined();
    });
  });

  describe('isFeatureEnabledForRequest', () => {
    test('uses req.user.id when authenticated', async () => {
      const req = { user: { id: 'user-42' }, sessionID: 'sess-abc' };

      const result = await AnalyticsService.isFeatureEnabledForRequest('billing-portal', req);

      expect(result).toBe(true);
      expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith(
        'billing-portal',
        'user-42',
        undefined,
      );
    });

    test('falls back to sessionID for anonymous browsing', async () => {
      const req = { sessionID: 'sess-abc' };

      await AnalyticsService.isFeatureEnabledForRequest('billing-portal', req, { personProperties: {} });

      expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith(
        'billing-portal',
        'sess-abc',
        { personProperties: {} },
      );
    });

    test('defaults to "anonymous" with no req (edge: called outside request context by mistake)', async () => {
      await AnalyticsService.isFeatureEnabledForRequest('billing-portal', undefined);

      expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith(
        'billing-portal',
        'anonymous',
        undefined,
      );
    });

    test('returns undefined when PostHog is not configured', async () => {
      await AnalyticsService.shutdown();
      jest.resetModules();
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { posthog: {} },
      }));
      const mod = await import('../analytics.js');
      const svc = mod.default;
      await svc.init();

      const result = await svc.isFeatureEnabledForRequest('billing-portal', { user: { id: 'user-42' } });

      expect(result).toBeUndefined();
    });
  });
});
