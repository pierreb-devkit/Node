/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for AnalyticsService.capture() and enabled-flag behaviour.
 */
describe('Analytics capture() and enabled-flag:', () => {
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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. enabled=false disables client creation
  // ─────────────────────────────────────────────────────────────────
  describe('enabled flag:', () => {
    test('returns null client when enabled=false even if key is present', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: false, key: 'phc_test_key', host: 'https://eu.i.posthog.com' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();
      AnalyticsService.capture({ distinctId: 'user-1', event: 'test' });

      const { PostHog } = await import('posthog-node');
      expect(PostHog).not.toHaveBeenCalled();
      expect(mockPostHogInstance.capture).not.toHaveBeenCalled();
    });

    test('returns null client when key is missing even if enabled=true', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();
      AnalyticsService.capture({ distinctId: 'user-1', event: 'test' });

      const { PostHog } = await import('posthog-node');
      expect(PostHog).not.toHaveBeenCalled();
    });

    test('creates client when enabled=true and key is present', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_test_key', host: 'https://eu.i.posthog.com' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();

      const { PostHog } = await import('posthog-node');
      expect(PostHog).toHaveBeenCalledWith('phc_test_key', expect.objectContaining({ host: 'https://eu.i.posthog.com' }));
    });

    test('passes flushAt and flushInterval to PostHog constructor', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://eu.i.posthog.com', flushAt: 20, flushInterval: 10000 } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();

      const { PostHog } = await import('posthog-node');
      expect(PostHog).toHaveBeenCalledWith('phc_key', {
        host: 'https://eu.i.posthog.com',
        flushAt: 20,
        flushInterval: 10000,
      });
    });

    test('singleton: two init() calls on the same module instance result in one PostHog client', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://eu.i.posthog.com' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();
      await AnalyticsService.init(); // singleton guard: no-op, client already set

      const { PostHog } = await import('posthog-node');
      expect(PostHog).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. capture() no-ops
  // ─────────────────────────────────────────────────────────────────
  describe('capture() no-ops:', () => {
    test('is a no-op when client is null', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: false, key: 'phc_key' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();
      AnalyticsService.capture({ distinctId: 'user-1', event: 'some_event' });

      expect(mockPostHogInstance.capture).not.toHaveBeenCalled();
    });

    test('is a no-op when distinctId is missing', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://eu.i.posthog.com' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();
      AnalyticsService.capture({ event: 'some_event' });

      expect(mockPostHogInstance.capture).not.toHaveBeenCalled();
    });

    test('is a no-op when event is missing', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://eu.i.posthog.com' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;

      await AnalyticsService.init();
      AnalyticsService.capture({ distinctId: 'user-1' });

      expect(mockPostHogInstance.capture).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. capture() auto-injects app + env
  // ─────────────────────────────────────────────────────────────────
  describe('capture() property injection:', () => {
    beforeEach(async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://eu.i.posthog.com', appTag: 'myapp' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;
      await AnalyticsService.init();
    });

    test('auto-injects app from appTag and env from NODE_ENV', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      AnalyticsService.capture({ distinctId: 'user-1', event: 'my_event' });

      expect(mockPostHogInstance.capture).toHaveBeenCalledWith({
        distinctId: 'user-1',
        event: 'my_event',
        properties: { app: 'myapp', env: 'test', source: 'system' },
      });

      process.env.NODE_ENV = origEnv;
    });

    test('custom properties win over defaults', async () => {
      AnalyticsService.capture({ distinctId: 'user-1', event: 'my_event', properties: { app: 'override', custom: 'val' } });

      expect(mockPostHogInstance.capture).toHaveBeenCalledWith({
        distinctId: 'user-1',
        event: 'my_event',
        properties: expect.objectContaining({ app: 'override', custom: 'val' }),
      });
    });

    test('does not inject app when appTag is not configured', async () => {
      jest.resetModules();

      jest.unstable_mockModule('posthog-node', () => ({
        PostHog: jest.fn().mockImplementation(() => mockPostHogInstance),
      }));

      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://eu.i.posthog.com' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;
      await AnalyticsService.init();

      AnalyticsService.capture({ distinctId: 'user-1', event: 'my_event' });

      const call = mockPostHogInstance.capture.mock.calls[0][0];
      expect(call.properties).not.toHaveProperty('app');
      expect(call.properties).toHaveProperty('env');
    });

    test('merges req.posthogContext (source + cli_version) into event properties', async () => {
      AnalyticsService.capture({
        distinctId: 'user-1',
        event: 'my_event',
        req: { posthogContext: { source: 'cli', cli_version: '1.2.3' } },
      });

      expect(mockPostHogInstance.capture).toHaveBeenCalledWith({
        distinctId: 'user-1',
        event: 'my_event',
        properties: expect.objectContaining({ source: 'cli', cli_version: '1.2.3', app: 'myapp' }),
      });
    });

    test('user-supplied properties win over req.posthogContext (precedence)', async () => {
      AnalyticsService.capture({
        distinctId: 'user-1',
        event: 'my_event',
        properties: { source: 'override' },
        req: { posthogContext: { source: 'cli', cli_version: '1.2.3' } },
      });

      expect(mockPostHogInstance.capture).toHaveBeenCalledWith({
        distinctId: 'user-1',
        event: 'my_event',
        properties: expect.objectContaining({ source: 'override', cli_version: '1.2.3' }),
      });
    });

    test('absent req injects source="system" default (no cli_version)', async () => {
      AnalyticsService.capture({ distinctId: 'user-1', event: 'my_event' });

      const call = mockPostHogInstance.capture.mock.calls[0][0];
      expect(call.properties).toHaveProperty('source', 'system');
      expect(call.properties).not.toHaveProperty('cli_version');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. shutdown idempotency
  // ─────────────────────────────────────────────────────────────────
  describe('shutdown idempotency:', () => {
    test('two shutdown() calls invoke client.shutdown exactly once', async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_key', host: 'https://eu.i.posthog.com' } } },
      }));

      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;
      await AnalyticsService.init();

      await AnalyticsService.shutdown();
      await AnalyticsService.shutdown();

      expect(mockPostHogInstance.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. source attribution
  // ─────────────────────────────────────────────────────────────────
  describe('source attribution:', () => {
    let AnalyticsService;
    beforeEach(async () => {
      jest.unstable_mockModule('../../../config/index.js', () => ({
        default: { analytics: { posthog: { enabled: true, key: 'phc_test', host: 'https://eu.i.posthog.com', appTag: 'trawl' } } },
      }));
      const mod = await import('../analytics.js');
      AnalyticsService = mod.default;
      await AnalyticsService.init();
    });

    test('defaults to source="system" when no req, no explicit source', () => {
      AnalyticsService.capture({ distinctId: 'u1', event: 'test' });
      expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
        properties: expect.objectContaining({ source: 'system' }),
      }));
    });

    test('explicit source param wins over req.posthogContext', () => {
      const req = { posthogContext: { source: 'web' } };
      AnalyticsService.capture({ distinctId: 'u1', event: 'test', req, source: 'cron' });
      expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
        properties: expect.objectContaining({ source: 'cron' }),
      }));
    });

    test('properties.source wins over req.posthogContext', () => {
      const req = { posthogContext: { source: 'web' } };
      AnalyticsService.capture({ distinctId: 'u1', event: 'test', req, properties: { source: 'stripe-webhook' } });
      expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
        properties: expect.objectContaining({ source: 'stripe-webhook' }),
      }));
    });

    test('req.posthogContext.source wins over default', () => {
      const req = { posthogContext: { source: 'cli', cli_version: '1.12.0' } };
      AnalyticsService.capture({ distinctId: 'u1', event: 'test', req });
      expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
        properties: expect.objectContaining({ source: 'cli', cli_version: '1.12.0' }),
      }));
    });

    test('explicit source param wins over properties.source', () => {
      AnalyticsService.capture({ distinctId: 'u1', event: 'test', source: 'cron', properties: { source: 'web' } });
      expect(mockPostHogInstance.capture).toHaveBeenCalledWith(expect.objectContaining({
        properties: expect.objectContaining({ source: 'cron' }),
      }));
    });
  });
});
