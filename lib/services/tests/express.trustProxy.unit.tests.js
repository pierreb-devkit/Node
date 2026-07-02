/**
 * Module dependencies.
 *
 * Unit tests for express.js initMiddleware — `trust proxy` wiring.
 * Security regression guard (#3933): the configured `trust.proxy` value (a
 * bounded hop count, subnet, or boolean) must be forwarded verbatim to Express.
 * The previous code collapsed any truthy value to the fully-permissive `true`,
 * which let a client spoof `req.ip` via a rotating leftmost X-Forwarded-For and
 * bypass the IP-keyed rate limiter (lib/middlewares/rateLimiter.js).
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';

describe('express initMiddleware — honor configured trust proxy hop count (#3933):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    jest.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /**
   * Load express.js with all heavy deps mocked, then return initMiddleware.
   * @param {*} trustProxy - value to place at config.trust.proxy
   * @returns {Promise<Function>} The initMiddleware function from the module
   */
  const getInitMiddleware = async (trustProxy) => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        domain: 'http://localhost:3000',
        app: { title: 'Test', description: '', keywords: '', url: '', logo: '' },
        secure: { ssl: false },
        log: {},
        bodyParser: {},
        csrf: {},
        cors: { origin: [], credentials: false, optionsSuccessStatus: 200 },
        trust: { proxy: trustProxy },
        openapi: { enable: false },
        files: { routes: [], configs: [], policies: [], preRoutes: [], openapi: [], guides: [] },
        analytics: { posthog: { autoCapture: false } },
        docs: {},
      },
    }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        getLogFormat: jest.fn().mockReturnValue('combined'),
        getMorganOptions: jest.fn().mockReturnValue({}),
      },
    }));
    jest.unstable_mockModule('../../../lib/helpers/guides.js', () => ({
      default: { loadGuides: jest.fn().mockReturnValue([]), mergeGuidesIntoSpec: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/requestId.js', () => ({
      default: jest.fn((req, res, next) => next()),
    }));
    jest.unstable_mockModule('../../../lib/middlewares/posthog-context.middleware.js', () => ({
      posthogContextMiddleware: jest.fn((req, res, next) => next()),
    }));
    jest.unstable_mockModule('../../../lib/services/errorTracker.js', () => ({
      default: { setupExpressErrorHandler: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { init: jest.fn().mockResolvedValue(undefined), identify: jest.fn(), groupIdentify: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/analytics.js', () => ({
      default: jest.fn((req, res, next) => next()),
    }));

    const mod = await import('../express.js');
    return mod.default.initMiddleware;
  };

  test('forwards a numeric hop count (1) to Express verbatim — not collapsed to `true`', async () => {
    const initMiddleware = await getInitMiddleware(1);
    const app = express();
    initMiddleware(app);

    // The configured hop count survives — the setting is 1, NOT the permissive `true`.
    expect(app.get('trust proxy')).toBe(1);
  });

  test('a single-hop trust fn trusts only the immediate proxy — spoofed leftmost XFF is not trusted', async () => {
    const initMiddleware = await getInitMiddleware(1);
    const app = express();
    initMiddleware(app);

    // proxy-addr compiles `1` to a trust fn that trusts hop index < 1 only.
    // This is the behavioural difference vs the old permissive `true` (which
    // trusted every hop, letting a client inject a spoofed leftmost XFF).
    const trust = app.get('trust proxy fn');
    expect(typeof trust).toBe('function');
    expect(trust('203.0.113.7', 0)).toBe(true); // the immediate reverse proxy is trusted
    expect(trust('203.0.113.7', 1)).toBe(false); // a further, client-controlled hop is NOT trusted
  });

  test('a boolean `true` still works (a project may opt into fully trusting the proxy chain)', async () => {
    const initMiddleware = await getInitMiddleware(true);
    const app = express();
    initMiddleware(app);

    expect(app.get('trust proxy')).toBe(true);
    const trust = app.get('trust proxy fn');
    expect(trust('203.0.113.7', 5)).toBe(true); // every hop trusted, as intended when true
  });

  test('a falsy trust.proxy leaves Express at its safe default (proxy not trusted)', async () => {
    const initMiddleware = await getInitMiddleware(false);
    const app = express();
    initMiddleware(app);

    // app.set('trust proxy', ...) is never called → Express default (false).
    expect(app.get('trust proxy')).toBe(false);
  });
});
