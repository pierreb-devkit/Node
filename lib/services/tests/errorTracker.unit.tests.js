/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for errorTracker service.
 * Tests all 4 combinations:
 *   1. No trackers configured → silent no-op
 *   2. Sentry only → only Sentry receives exception
 *   3. PostHog only (errorTracking=true) → only PostHog receives exception
 *   4. Both active → both receive exception
 * Also verifies the default-safe invariant:
 *   - PostHog key alone (no errorTracking) → no exception captured
 */
describe('errorTracker service unit tests:', () => {
  let mockSentryCapture;
  let mockSentrySetup;
  let mockAnalyticsCapture;

  beforeEach(() => {
    jest.resetModules();

    mockSentryCapture = jest.fn();
    mockSentrySetup = jest.fn();
    mockAnalyticsCapture = jest.fn();

    jest.unstable_mockModule('../sentry.js', () => ({
      default: {
        init: jest.fn().mockResolvedValue(undefined),
        captureException: mockSentryCapture,
        setupExpressErrorHandler: mockSentrySetup,
        shutdown: jest.fn().mockResolvedValue(undefined),
      },
    }));

    jest.unstable_mockModule('../analytics.js', () => ({
      default: {
        init: jest.fn().mockResolvedValue(undefined),
        captureException: mockAnalyticsCapture,
        track: jest.fn(),
        identify: jest.fn(),
        groupIdentify: jest.fn(),
        getFeatureFlag: jest.fn(),
        isFeatureEnabled: jest.fn(),
        shutdown: jest.fn().mockResolvedValue(undefined),
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('no trackers configured', () => {
    test('should be a silent no-op when neither sentry nor posthog is configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { sentry: {}, posthog: {} },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('test error');

      errorTracker.captureException(err, { distinctId: 'user-1' });

      expect(mockSentryCapture).not.toHaveBeenCalled();
      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });

    test('should be a silent no-op when config is missing entirely', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {},
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('test error');

      errorTracker.captureException(err);

      expect(mockSentryCapture).not.toHaveBeenCalled();
      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });
  });

  describe('sentry only', () => {
    test('should call sentry.captureException and NOT analytics when only sentry.dsn is set', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: { dsn: 'https://fake@sentry.io/1', enabled: true },
          posthog: {},
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('sentry test');

      errorTracker.captureException(err, { distinctId: 'user-2', requestId: 'req-abc' });

      expect(mockSentryCapture).toHaveBeenCalledTimes(1);
      expect(mockSentryCapture).toHaveBeenCalledWith(err);
      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });

    test('should call sentry even when enabled is not explicitly set (default behavior)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: { dsn: 'https://fake@sentry.io/2' },
          posthog: {},
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      errorTracker.captureException(new Error('no enabled flag'));

      expect(mockSentryCapture).toHaveBeenCalledTimes(1);
      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });

    test('should NOT call sentry when enabled is false', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: { dsn: 'https://fake@sentry.io/3', enabled: false },
          posthog: {},
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      errorTracker.captureException(new Error('disabled sentry'));

      expect(mockSentryCapture).not.toHaveBeenCalled();
    });
  });

  describe('posthog only with errorTracking=true', () => {
    test('should call analytics.captureException and NOT sentry when posthog is configured with errorTracking=true', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: {},
          posthog: { apiKey: 'ph_test_key', errorTracking: true },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('posthog test');
      const ctx = { distinctId: 'user-3', requestId: 'req-xyz' };

      errorTracker.captureException(err, ctx);

      expect(mockSentryCapture).not.toHaveBeenCalled();
      expect(mockAnalyticsCapture).toHaveBeenCalledTimes(1);
      expect(mockAnalyticsCapture).toHaveBeenCalledWith(err, ctx);
    });

    test('should NOT call analytics when posthog.apiKey is set but errorTracking is false (default-safe)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: {},
          posthog: { apiKey: 'ph_test_key', errorTracking: false },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      errorTracker.captureException(new Error('default-safe test'));

      expect(mockSentryCapture).not.toHaveBeenCalled();
      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });

    test('should NOT call analytics when posthog.apiKey is set but errorTracking is missing (default-safe)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: {},
          posthog: { apiKey: 'ph_test_key' },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      errorTracker.captureException(new Error('no errorTracking key'));

      expect(mockSentryCapture).not.toHaveBeenCalled();
      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });
  });

  describe('both trackers active', () => {
    test('should call both sentry and analytics when both are configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: { dsn: 'https://fake@sentry.io/4', enabled: true },
          posthog: { apiKey: 'ph_test_key', errorTracking: true },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('both trackers test');
      const ctx = { distinctId: 'user-4', requestId: 'req-both' };

      errorTracker.captureException(err, ctx);

      expect(mockSentryCapture).toHaveBeenCalledTimes(1);
      expect(mockSentryCapture).toHaveBeenCalledWith(err);
      expect(mockAnalyticsCapture).toHaveBeenCalledTimes(1);
      expect(mockAnalyticsCapture).toHaveBeenCalledWith(err, ctx);
    });
  });

  describe('init', () => {
    test('should call init on both services', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {},
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      await errorTracker.init();

      const { default: sentryService } = await import('../sentry.js');
      const { default: analyticsService } = await import('../analytics.js');
      expect(sentryService.init).toHaveBeenCalled();
      expect(analyticsService.init).toHaveBeenCalled();
    });
  });

  describe('setupExpressErrorHandler', () => {
    test('should call sentry.setupExpressErrorHandler and mount 4-arg middleware', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          sentry: { dsn: 'https://fake@sentry.io/5', enabled: true },
          posthog: { apiKey: 'ph_test_key', errorTracking: true },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const mockApp = { use: jest.fn() };

      errorTracker.setupExpressErrorHandler(mockApp);

      expect(mockSentrySetup).toHaveBeenCalledWith(mockApp);
      // 4-arg error middleware should be mounted
      expect(mockApp.use).toHaveBeenCalledTimes(1);
      const middleware = mockApp.use.mock.calls[0][0];
      expect(middleware.length).toBe(4); // 4-arg = error middleware

      // Invoke the middleware and verify captureException is called
      const err = new Error('express error');
      const req = { userId: 'user-5', id: 'req-5', user: null };
      const res = {};
      const next = jest.fn();
      middleware(err, req, res, next);

      expect(mockSentryCapture).toHaveBeenCalledWith(err);
      expect(mockAnalyticsCapture).toHaveBeenCalledWith(err, {
        distinctId: 'user-5',
        requestId: 'req-5',
      });
      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
