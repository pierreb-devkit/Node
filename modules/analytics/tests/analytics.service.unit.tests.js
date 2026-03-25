/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for analytics service
 */
describe('Analytics service unit tests:', () => {
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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('no-op mode (PostHog not configured)', () => {
    test('should not create a client when apiKey is missing', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { posthog: {} },
      }));

      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      AnalyticsService.track('user-1', 'test-event');
      AnalyticsService.identify('user-1', { name: 'Alice' });
      AnalyticsService.groupIdentify('company', 'org-1', { name: 'Acme' });

      const { PostHog } = await import('posthog-node');
      expect(PostHog).not.toHaveBeenCalled();
    });

    test('should not create a client when posthog config section is missing', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {},
      }));

      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      AnalyticsService.track('user-1', 'test-event');

      const { PostHog } = await import('posthog-node');
      expect(PostHog).not.toHaveBeenCalled();
    });

    test('getFeatureFlag should return undefined when not configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { posthog: {} },
      }));

      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();

      const result = await AnalyticsService.getFeatureFlag('my-flag', 'user-1');
      expect(result).toBeUndefined();
    });

    test('isFeatureEnabled should return undefined when not configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { posthog: {} },
      }));

      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();

      const result = await AnalyticsService.isFeatureEnabled('my-flag', 'user-1');
      expect(result).toBeUndefined();
    });

    test('shutdown should be safe when not configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { posthog: {} },
      }));

      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      await expect(AnalyticsService.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('configured mode', () => {
    beforeEach(async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          posthog: {
            apiKey: 'phc_test_key',
            host: 'https://test.posthog.com',
          },
        },
      }));
    });

    test('should create PostHog client with correct config', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();

      const { PostHog } = await import('posthog-node');
      expect(PostHog).toHaveBeenCalledWith('phc_test_key', { host: 'https://test.posthog.com' });
    });

    test('should use default host when not provided', async () => {
      jest.resetModules();

      jest.unstable_mockModule('posthog-node', () => ({
        PostHog: jest.fn().mockImplementation(() => mockPostHogInstance),
      }));
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          posthog: {
            apiKey: 'phc_test_key',
            host: '',
          },
        },
      }));

      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();

      const { PostHog } = await import('posthog-node');
      expect(PostHog).toHaveBeenCalledWith('phc_test_key', { host: 'https://us.i.posthog.com' });
    });

    test('track should call client.capture with correct params', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      AnalyticsService.track('user-1', 'page_view', { path: '/' }, { company: 'org-1' });

      expect(mockPostHogInstance.capture).toHaveBeenCalledWith({
        distinctId: 'user-1',
        event: 'page_view',
        properties: { path: '/' },
        groups: { company: 'org-1' },
      });
    });

    test('identify should call client.identify with correct params', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      AnalyticsService.identify('user-1', { email: 'a@b.com' });

      expect(mockPostHogInstance.identify).toHaveBeenCalledWith({
        distinctId: 'user-1',
        properties: { email: 'a@b.com' },
      });
    });

    test('groupIdentify should call client.groupIdentify with correct params', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      AnalyticsService.groupIdentify('company', 'org-1', { name: 'Acme' });

      expect(mockPostHogInstance.groupIdentify).toHaveBeenCalledWith({
        groupType: 'company',
        groupKey: 'org-1',
        properties: { name: 'Acme' },
      });
    });

    test('getFeatureFlag should delegate to client', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      const result = await AnalyticsService.getFeatureFlag('my-flag', 'user-1', { groups: {} });

      expect(mockPostHogInstance.getFeatureFlag).toHaveBeenCalledWith('my-flag', 'user-1', { groups: {} });
      expect(result).toBe('variant-a');
    });

    test('isFeatureEnabled should delegate to client', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      const result = await AnalyticsService.isFeatureEnabled('my-flag', 'user-1', { groups: {} });

      expect(mockPostHogInstance.isFeatureEnabled).toHaveBeenCalledWith('my-flag', 'user-1', { groups: {} });
      expect(result).toBe(true);
    });

    test('shutdown should flush and close the client', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      await AnalyticsService.shutdown();

      expect(mockPostHogInstance.shutdown).toHaveBeenCalled();
    });

    test('shutdown should reset client to null (subsequent calls are no-op)', async () => {
      const mod = await import('../services/analytics.service.js');
      AnalyticsService = mod.default;

      AnalyticsService.init();
      await AnalyticsService.shutdown();

      // After shutdown, track should be a no-op (no error thrown)
      AnalyticsService.track('user-1', 'test');
      expect(mockPostHogInstance.capture).not.toHaveBeenCalled();
    });
  });
});
