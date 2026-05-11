/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for errorTracker service (PostHog single-source).
 * Tests PostHog-only fan-out — Sentry has been removed.
 * Combinations:
 *   1. No PostHog configured → silent no-op
 *   2. PostHog apiKey set, errorTracking=true → exception captured
 *   3. PostHog apiKey set, errorTracking=false → no capture (default-safe)
 *   4. PostHog apiKey set, errorTracking missing → no capture (default-safe)
 */
describe('errorTracker service unit tests:', () => {
  let mockAnalyticsCapture;

  beforeEach(() => {
    jest.resetModules();

    mockAnalyticsCapture = jest.fn();

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
    test('should be a silent no-op when posthog is not configured', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: {} } },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('test error');

      errorTracker.captureException(err, { distinctId: 'user-1' });

      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });

    test('should be a silent no-op when config is missing entirely', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {},
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('test error');

      errorTracker.captureException(err);

      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });
  });

  describe('posthog only with errorTracking=true', () => {
    test('should call analytics.captureException when posthog is configured with errorTracking=true', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          analytics: { posthog: { key: 'ph_test_key', errorTracking: true } },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const err = new Error('posthog test');
      const ctx = { distinctId: 'user-3', requestId: 'req-xyz' };

      errorTracker.captureException(err, ctx);

      expect(mockAnalyticsCapture).toHaveBeenCalledTimes(1);
      expect(mockAnalyticsCapture).toHaveBeenCalledWith(err, ctx);
    });

    test('should NOT call analytics when analytics.posthog.key is set but errorTracking is false (default-safe)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          analytics: { posthog: { key: 'ph_test_key', errorTracking: false } },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      errorTracker.captureException(new Error('default-safe test'));

      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });

    test('should NOT call analytics when analytics.posthog.key is set but errorTracking is missing (default-safe)', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          analytics: { posthog: { key: 'ph_test_key' } },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      errorTracker.captureException(new Error('no errorTracking key'));

      expect(mockAnalyticsCapture).not.toHaveBeenCalled();
    });
  });

  describe('init', () => {
    test('should call init on analytics service', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {},
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      await errorTracker.init();

      const { default: analyticsService } = await import('../analytics.js');
      expect(analyticsService.init).toHaveBeenCalled();
    });
  });

  describe('setupExpressErrorHandler', () => {
    test('should mount PostHog 4-arg error middleware', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          analytics: { posthog: { key: 'ph_test_key', errorTracking: true } },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const mockApp = { use: jest.fn() };

      errorTracker.setupExpressErrorHandler(mockApp);

      expect(mockApp.use).toHaveBeenCalledTimes(1);
      const middleware = mockApp.use.mock.calls[0][0];
      expect(middleware.length).toBe(4); // 4-arg = error middleware

      // Invoke the middleware and verify PostHog is called
      const err = new Error('express error');
      const req = { user: { _id: 'user-5' }, id: 'req-5' };
      const res = {};
      const next = jest.fn();
      middleware(err, req, res, next);

      expect(mockAnalyticsCapture).toHaveBeenCalledWith(err, {
        distinctId: 'user-5',
        requestId: 'req-5',
      });
      expect(next).toHaveBeenCalledWith(err);
    });

    test('should use req.user.id fallback when _id is absent', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          analytics: { posthog: { key: 'ph_test_key', errorTracking: true } },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const mockApp = { use: jest.fn() };
      errorTracker.setupExpressErrorHandler(mockApp);

      const middleware = mockApp.use.mock.calls[0][0];
      const err = new Error('fallback id test');
      const req = { user: { id: 'user-6' }, id: 'req-6' };
      middleware(err, req, {}, jest.fn());

      expect(mockAnalyticsCapture).toHaveBeenCalledWith(err, {
        distinctId: 'user-6',
        requestId: 'req-6',
      });
    });

    test('should use anonymous when no user is attached', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: {
          analytics: { posthog: { key: 'ph_test_key', errorTracking: true } },
        },
      }));

      const { default: errorTracker } = await import('../errorTracker.js');
      const mockApp = { use: jest.fn() };
      errorTracker.setupExpressErrorHandler(mockApp);

      const middleware = mockApp.use.mock.calls[0][0];
      const err = new Error('anonymous test');
      const req = { user: null, id: 'req-7' };
      middleware(err, req, {}, jest.fn());

      expect(mockAnalyticsCapture).toHaveBeenCalledWith(err, {
        distinctId: 'anonymous',
        requestId: 'req-7',
      });
    });
  });

  describe('setupExpressErrorHandler — dedup flag:', () => {
    test('marks err.posthogCaptured = true after capture so Winston transport skips it', async () => {
      jest.unstable_mockModule('../analytics.js', () => ({
        default: { captureException: jest.fn(), init: jest.fn().mockResolvedValue() },
      }));
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_test', errorTracking: true } } },
      }));
      const mod = await import('../errorTracker.js');
      const errorTracker = mod.default;

      const handlers = [];
      const app = { use: (fn) => handlers.push(fn) };
      errorTracker.setupExpressErrorHandler(app);

      const middleware = handlers[handlers.length - 1];
      const err = new Error('boom');
      const next = jest.fn();
      middleware(err, { user: { _id: 'u1' }, id: 'r1' }, {}, next);

      expect(err.posthogCaptured).toBe(true);
      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
