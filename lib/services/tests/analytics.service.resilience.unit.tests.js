/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for analytics service error resilience, shutdown safety,
 * and edge cases not covered by the primary service unit tests.
 */
describe('Analytics service resilience tests:', () => {
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
      default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://test.posthog.com' } } },
    }));

    const mod = await import('../analytics.js');
    AnalyticsService = mod.default;
    await AnalyticsService.init();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Error resilience — synchronous SDK failures are swallowed
  // ─────────────────────────────────────────────────────────────────────
  describe('synchronous SDK error resilience:', () => {
    test('track should not throw when client.capture throws', () => {
      mockPostHogInstance.capture.mockImplementation(() => {
        throw new Error('Capture error');
      });

      expect(() => AnalyticsService.track('u1', 'evt')).not.toThrow();
    });

    test('identify should not throw when client.identify throws', () => {
      mockPostHogInstance.identify.mockImplementation(() => {
        throw new Error('Identify error');
      });

      expect(() => AnalyticsService.identify('u1', {})).not.toThrow();
    });

    test('groupIdentify should not throw when client.groupIdentify throws', () => {
      mockPostHogInstance.groupIdentify.mockImplementation(() => {
        throw new Error('Group error');
      });

      expect(() => AnalyticsService.groupIdentify('company', 'org', {})).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Error propagation — async SDK failures
  // ─────────────────────────────────────────────────────────────────────
  describe('async SDK error propagation:', () => {
    test('getFeatureFlag should propagate rejection from SDK', async () => {
      mockPostHogInstance.getFeatureFlag.mockRejectedValue(new Error('Timeout'));

      await expect(AnalyticsService.getFeatureFlag('flag', 'u1')).rejects.toThrow('Timeout');
    });

    test('isFeatureEnabled should propagate rejection from SDK', async () => {
      mockPostHogInstance.isFeatureEnabled.mockRejectedValue(new Error('Timeout'));

      await expect(AnalyticsService.isFeatureEnabled('flag', 'u1')).rejects.toThrow('Timeout');
    });

    test('shutdown should propagate rejection from SDK', async () => {
      mockPostHogInstance.shutdown.mockRejectedValue(new Error('Flush failed'));

      await expect(AnalyticsService.shutdown()).rejects.toThrow('Flush failed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Post-shutdown safety
  // ─────────────────────────────────────────────────────────────────────
  describe('post-shutdown safety:', () => {
    test('double shutdown should be safe (second call is no-op)', async () => {
      await AnalyticsService.shutdown();
      // Second call — client is null, returns undefined synchronously
      AnalyticsService.shutdown();

      expect(mockPostHogInstance.shutdown).toHaveBeenCalledTimes(1);
    });

    test('track after shutdown should be a silent no-op', async () => {
      await AnalyticsService.shutdown();

      expect(() => AnalyticsService.track('u1', 'evt')).not.toThrow();
      expect(mockPostHogInstance.capture).not.toHaveBeenCalled();
    });

    test('identify after shutdown should be a silent no-op', async () => {
      await AnalyticsService.shutdown();

      expect(() => AnalyticsService.identify('u1', { name: 'a' })).not.toThrow();
      expect(mockPostHogInstance.identify).not.toHaveBeenCalled();
    });

    test('groupIdentify after shutdown should be a silent no-op', async () => {
      await AnalyticsService.shutdown();

      expect(() => AnalyticsService.groupIdentify('company', 'org', {})).not.toThrow();
      expect(mockPostHogInstance.groupIdentify).not.toHaveBeenCalled();
    });

    test('getFeatureFlag after shutdown returns undefined', async () => {
      await AnalyticsService.shutdown();

      const result = await AnalyticsService.getFeatureFlag('flag', 'u1');
      expect(result).toBeUndefined();
    });

    test('isFeatureEnabled after shutdown returns undefined', async () => {
      await AnalyticsService.shutdown();

      const result = await AnalyticsService.isFeatureEnabled('flag', 'u1');
      expect(result).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Minimal / optional argument handling
  // ─────────────────────────────────────────────────────────────────────
  describe('optional argument handling:', () => {
    test('track with only required args passes undefined for optional params', () => {
      AnalyticsService.track('u1', 'evt');

      expect(mockPostHogInstance.capture).toHaveBeenCalledWith({
        distinctId: 'u1',
        event: 'evt',
        properties: undefined,
        groups: undefined,
      });
    });

    test('identify with no properties passes undefined', () => {
      AnalyticsService.identify('u1');

      expect(mockPostHogInstance.identify).toHaveBeenCalledWith({
        distinctId: 'u1',
        properties: undefined,
      });
    });

    test('groupIdentify with no properties passes undefined', () => {
      AnalyticsService.groupIdentify('company', 'org-1');

      expect(mockPostHogInstance.groupIdentify).toHaveBeenCalledWith({
        groupType: 'company',
        groupKey: 'org-1',
        properties: undefined,
      });
    });

    test('getFeatureFlag forwards options to SDK', async () => {
      const opts = { groups: { company: 'org-1' } };
      await AnalyticsService.getFeatureFlag('flag', 'u1', opts);

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith('flag', 'u1', opts);
    });

    test('isFeatureEnabled forwards options to SDK', async () => {
      const opts = { personProperties: { plan: 'pro' } };
      await AnalyticsService.isFeatureEnabled('flag', 'u1', opts);

      expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith('flag', 'u1', opts);
    });
  });
});
