/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for analytics feature flags service
 */
describe('Analytics feature flags service unit tests:', () => {
  let FeatureFlagsService;
  let mockAnalyticsService;

  beforeEach(async () => {
    jest.resetModules();

    mockAnalyticsService = {
      isFeatureEnabled: jest.fn(),
      getFeatureFlag: jest.fn(),
    };

    jest.unstable_mockModule('../analytics.js', () => ({
      default: mockAnalyticsService,
    }));

    const mod = await import('../analytics.featureFlags.js');
    FeatureFlagsService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isEnabled', () => {
    test('should return true when flag is enabled', async () => {
      mockAnalyticsService.isFeatureEnabled.mockResolvedValue(true);

      const result = await FeatureFlagsService.isEnabled('my-flag', 'user-1');

      expect(result).toBe(true);
      expect(mockAnalyticsService.isFeatureEnabled).toHaveBeenCalledWith('my-flag', 'user-1', {});
    });

    test('should return false when flag is disabled', async () => {
      mockAnalyticsService.isFeatureEnabled.mockResolvedValue(false);

      const result = await FeatureFlagsService.isEnabled('my-flag', 'user-1');

      expect(result).toBe(false);
    });

    test('should return false when analytics is not configured (undefined)', async () => {
      mockAnalyticsService.isFeatureEnabled.mockResolvedValue(undefined);

      const result = await FeatureFlagsService.isEnabled('my-flag', 'user-1');

      expect(result).toBe(false);
    });

    test('should pass personProperties and groups to analytics service', async () => {
      mockAnalyticsService.isFeatureEnabled.mockResolvedValue(true);

      await FeatureFlagsService.isEnabled('my-flag', 'user-1', {
        personProperties: { plan: 'pro' },
        groups: { company: 'org-1' },
        groupProperties: { company: { plan: 'enterprise' } },
      });

      expect(mockAnalyticsService.isFeatureEnabled).toHaveBeenCalledWith('my-flag', 'user-1', {
        personProperties: { plan: 'pro' },
        groups: { company: 'org-1' },
        groupProperties: { company: { plan: 'enterprise' } },
      });
    });

    test('should omit undefined option keys from PostHog options', async () => {
      mockAnalyticsService.isFeatureEnabled.mockResolvedValue(false);

      await FeatureFlagsService.isEnabled('my-flag', 'user-1', {});

      expect(mockAnalyticsService.isFeatureEnabled).toHaveBeenCalledWith('my-flag', 'user-1', {});
    });
  });

  describe('getVariant', () => {
    test('should return variant string when flag has multivariate value', async () => {
      mockAnalyticsService.getFeatureFlag.mockResolvedValue('variant-a');

      const result = await FeatureFlagsService.getVariant('my-flag', 'user-1');

      expect(result).toBe('variant-a');
      expect(mockAnalyticsService.getFeatureFlag).toHaveBeenCalledWith('my-flag', 'user-1', {});
    });

    test('should return boolean when flag is a simple toggle', async () => {
      mockAnalyticsService.getFeatureFlag.mockResolvedValue(false);

      const result = await FeatureFlagsService.getVariant('my-flag', 'user-1');

      expect(result).toBe(false);
    });

    test('should return undefined when analytics is not configured', async () => {
      mockAnalyticsService.getFeatureFlag.mockResolvedValue(undefined);

      const result = await FeatureFlagsService.getVariant('my-flag', 'user-1');

      expect(result).toBeUndefined();
    });

    test('should pass personProperties, groups, and groupProperties', async () => {
      mockAnalyticsService.getFeatureFlag.mockResolvedValue('variant-b');

      await FeatureFlagsService.getVariant('my-flag', 'user-1', {
        personProperties: { email: 'a@b.com' },
        groups: { company: 'org-1' },
        groupProperties: { company: { name: 'Acme' } },
      });

      expect(mockAnalyticsService.getFeatureFlag).toHaveBeenCalledWith('my-flag', 'user-1', {
        personProperties: { email: 'a@b.com' },
        groups: { company: 'org-1' },
        groupProperties: { company: { name: 'Acme' } },
      });
    });
  });
});
