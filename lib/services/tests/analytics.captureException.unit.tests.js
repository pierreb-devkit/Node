import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

describe('Analytics captureException():', () => {
  let AnalyticsService;
  let mockPostHogInstance;

  beforeEach(async () => {
    jest.resetModules();
    mockPostHogInstance = {
      capture: jest.fn(),
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

  test('emits $exception with default source="system" when no ctx', () => {
    AnalyticsService.captureException(new Error('boom'));
    expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
      event: '$exception',
      properties: expect.objectContaining({ source: 'system', $exception_message: 'boom' }),
    }));
  });

  test('honours explicit ctx.source', () => {
    AnalyticsService.captureException(new Error('boom'), { source: 'worker-callback' });
    expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ source: 'worker-callback' }),
    }));
  });

  test('merges ctx.properties (logMessage/logLevel) into event', () => {
    AnalyticsService.captureException(new Error('boom'), {
      distinctId: 'u1',
      properties: { logMessage: 'something failed', logLevel: 'error' },
    });
    expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'u1',
      properties: expect.objectContaining({
        logMessage: 'something failed',
        logLevel: 'error',
        source: 'system',
      }),
    }));
  });

  test('ctx.properties.source wins over system default', () => {
    AnalyticsService.captureException(new Error('boom'), {
      properties: { source: 'stripe-webhook' },
    });
    expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ source: 'stripe-webhook' }),
    }));
  });

  test('explicit ctx.source wins over ctx.properties.source', () => {
    AnalyticsService.captureException(new Error('boom'), {
      source: 'cron',
      properties: { source: 'web' },
    });
    expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ source: 'cron' }),
    }));
  });

  test('no-op when err is null/undefined', () => {
    AnalyticsService.captureException(null);
    AnalyticsService.captureException(undefined);
    expect(mockPostHogInstance.capture).not.toHaveBeenCalled();
  });
});
