import { jest, beforeEach, describe, test, expect } from '@jest/globals';

describe('logger.js — PostHogErrorTransport wiring:', () => {
  beforeEach(() => { jest.resetModules(); });

  test('PostHogErrorTransport is registered when analytics.posthog.errorTracking=true', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { analytics: { posthog: { errorTracking: true, enabled: true, key: 'phc_test' } }, logger: { level: 'info' }, log: { level: 'info', fileLogger: {} } },
    }));
    const mod = await import('../logger.js');
    const logger = mod.default ?? mod.logger;
    const hasTransport = logger.transports.some((t) => t.constructor.name === 'PostHogErrorTransport');
    expect(hasTransport).toBe(true);
  });

  test('PostHogErrorTransport is NOT registered when errorTracking=false', async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: { analytics: { posthog: { errorTracking: false } }, logger: { level: 'info' }, log: { level: 'info', fileLogger: {} } },
    }));
    const mod = await import('../logger.js');
    const logger = mod.default ?? mod.logger;
    const hasTransport = logger.transports.some((t) => t.constructor.name === 'PostHogErrorTransport');
    expect(hasTransport).toBe(false);
  });
});
