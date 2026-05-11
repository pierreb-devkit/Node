/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

describe('Analytics captureException():', () => {
  let AnalyticsService;
  let mockPostHogInstance;

  beforeEach(async () => {
    jest.resetModules();
    mockPostHogInstance = {
      capture: jest.fn(),
      captureException: jest.fn(),
      identify: jest.fn(),
      groupIdentify: jest.fn(),
      getFeatureFlag: jest.fn().mockResolvedValue(undefined),
      isFeatureEnabled: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    jest.unstable_mockModule('posthog-node', () => ({
      PostHog: jest.fn().mockImplementation(() => mockPostHogInstance),
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { analytics: { posthog: { enabled: true, key: 'phc_test', host: 'https://eu.i.posthog.com', appTag: 'trawl' } } },
    }));
    const mod = await import('../analytics.js');
    AnalyticsService = mod.default;
    await AnalyticsService.init();
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test('calls SDK captureException with default source="system" when no ctx', () => {
    const err = new Error('boom');
    AnalyticsService.captureException(err);
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'anonymous',
      expect.objectContaining({ source: 'system' }),
    );
  });

  test('honours explicit ctx.source', () => {
    const err = new Error('boom');
    AnalyticsService.captureException(err, { source: 'worker-callback' });
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'anonymous',
      expect.objectContaining({ source: 'worker-callback' }),
    );
  });

  test('merges ctx.properties (logMessage/logLevel) into additionalProperties', () => {
    const err = new Error('boom');
    AnalyticsService.captureException(err, {
      distinctId: 'u1',
      properties: { logMessage: 'something failed', logLevel: 'error' },
    });
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'u1',
      expect.objectContaining({
        logMessage: 'something failed',
        logLevel: 'error',
        source: 'system',
      }),
    );
  });

  test('ctx.properties.source wins over system default', () => {
    const err = new Error('boom');
    AnalyticsService.captureException(err, {
      properties: { source: 'stripe-webhook' },
    });
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'anonymous',
      expect.objectContaining({ source: 'stripe-webhook' }),
    );
  });

  test('explicit ctx.source wins over ctx.properties.source', () => {
    const err = new Error('boom');
    AnalyticsService.captureException(err, {
      source: 'cron',
      properties: { source: 'web' },
    });
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'anonymous',
      expect.objectContaining({ source: 'cron' }),
    );
  });

  test('no-op when err is null/undefined', () => {
    AnalyticsService.captureException(null);
    AnalyticsService.captureException(undefined);
    expect(mockPostHogInstance.captureException).not.toHaveBeenCalled();
  });

  test('passes requestId in additionalProperties', () => {
    const err = new Error('with-req');
    AnalyticsService.captureException(err, { distinctId: 'u2', requestId: 'req-xyz' });
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'u2',
      expect.objectContaining({ requestId: 'req-xyz' }),
    );
  });

  test('ctx.requestId wins over ctx.properties.requestId (authoritative)', () => {
    const err = new Error('req-precedence');
    AnalyticsService.captureException(err, {
      requestId: 'authoritative-req',
      properties: { requestId: 'should-be-overridden' },
    });
    expect(mockPostHogInstance.captureException).toHaveBeenCalledWith(
      err,
      'anonymous',
      expect.objectContaining({ requestId: 'authoritative-req' }),
    );
  });
});
