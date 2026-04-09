/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Mock config — Sentry disabled by default
jest.unstable_mockModule('../../../config/index.js', () => ({
  default: {
    sentry: { dsn: '', environment: 'test', enabled: false },
  },
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('SentryService unit tests:', () => {
  let SentryService;

  beforeEach(async () => {
    const mod = await import('../sentry.js');
    SentryService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should be a no-op when dsn is empty', async () => {
    await SentryService.init();
    // Should not throw
    SentryService.captureException(new Error('test'));
    SentryService.setupExpressErrorHandler({});
    await SentryService.shutdown();
  });

  test('should export init, setupExpressErrorHandler, captureException, shutdown', () => {
    expect(typeof SentryService.init).toBe('function');
    expect(typeof SentryService.setupExpressErrorHandler).toBe('function');
    expect(typeof SentryService.captureException).toBe('function');
    expect(typeof SentryService.shutdown).toBe('function');
  });
});
