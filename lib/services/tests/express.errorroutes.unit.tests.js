/**
 * Module dependencies.
 *
 * Unit tests for express.js initErrorRoutes.
 * Security regression guard: err.message/code must NOT be sent to clients in production (#3726).
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

describe('express initErrorRoutes — prod error leak guard (#3726):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    jest.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /**
   * Helper: extract initErrorRoutes from express.js (with all heavy deps mocked).
   * @returns {Promise<Function>} The initErrorRoutes function extracted from the module
   */
  const getInitErrorRoutes = async () => {
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        domain: 'http://localhost:3000',
        app: { title: 'Test', description: '', keywords: '', url: '', logo: '' },
        secure: { ssl: false },
        log: {},
        bodyParser: {},
        csrf: {},
        cors: { origin: [], credentials: false, optionsSuccessStatus: 200 },
        trust: { proxy: false },
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
    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { discoverPolicies: jest.fn().mockResolvedValue(undefined), defineAbilityFor: jest.fn().mockResolvedValue({}) },
    }));

    const mod = await import('../../../lib/services/express.js');
    return mod.default.initErrorRoutes;
  };

  test('in production: responds with generic { message: "Internal Server Error" } — no err.message/code leak', async () => {
    process.env.NODE_ENV = 'production';
    const initErrorRoutes = await getInitErrorRoutes();

    // Capture the error handler registered via app.use
    let errorHandler;
    const app = {
      use: jest.fn((handler) => { errorHandler = handler; }),
    };
    initErrorRoutes(app);
    expect(typeof errorHandler).toBe('function');

    const internalErr = new Error('E11000 duplicate key index: email_1');
    internalErr.code = 11000;
    internalErr.status = 500;

    const sendPayloads = [];
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn((body) => { sendPayloads.push(body); return res; }),
    };

    await errorHandler(internalErr, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(sendPayloads).toHaveLength(1);
    const body = sendPayloads[0];
    // Must NOT include internal error detail
    expect(body.message).toBe('Internal Server Error');
    expect(body.code).toBeUndefined();
    // Must NOT contain the raw error message
    expect(JSON.stringify(body)).not.toContain('E11000');
    expect(JSON.stringify(body)).not.toContain('email_1');
  });

  test('in a project (non-dev) env: responds with generic body — no err.message/code leak', async () => {
    // Regression guard for the env-gate defect class: hardening must key off the
    // dev-env allow-list, not the literal `production`. A deployment env label
    // (e.g. "someproject") is a production-grade env and must not leak details.
    process.env.NODE_ENV = 'someproject';
    const initErrorRoutes = await getInitErrorRoutes();

    let errorHandler;
    const app = {
      use: jest.fn((handler) => { errorHandler = handler; }),
    };
    initErrorRoutes(app);

    const internalErr = new Error('E11000 duplicate key index: email_1');
    internalErr.code = 11000;
    internalErr.status = 500;

    const sendPayloads = [];
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn((body) => { sendPayloads.push(body); return res; }),
    };

    await errorHandler(internalErr, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = sendPayloads[0];
    expect(body.message).toBe('Internal Server Error');
    expect(body.code).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('E11000');
    expect(JSON.stringify(body)).not.toContain('email_1');
  });

  test('in non-production (development): responds with detailed err.message + err.code', async () => {
    process.env.NODE_ENV = 'development';
    const initErrorRoutes = await getInitErrorRoutes();

    let errorHandler;
    const app = {
      use: jest.fn((handler) => { errorHandler = handler; }),
    };
    initErrorRoutes(app);

    const devErr = new Error('Something went wrong internally');
    devErr.code = 'ERR_INTERNAL';
    devErr.status = 500;

    const sendPayloads = [];
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn((body) => { sendPayloads.push(body); return res; }),
    };

    await errorHandler(devErr, {}, res, jest.fn());

    const body = sendPayloads[0];
    expect(body.message).toBe('Something went wrong internally');
    expect(body.code).toBe('ERR_INTERNAL');
  });

  test('in test env: responds with detailed err.message + err.code (non-production path)', async () => {
    process.env.NODE_ENV = 'test';
    const initErrorRoutes = await getInitErrorRoutes();

    let errorHandler;
    const app = {
      use: jest.fn((handler) => { errorHandler = handler; }),
    };
    initErrorRoutes(app);

    const testErr = new Error('test internal error');
    testErr.code = 'ERR_TEST';
    testErr.status = 422;

    const sendPayloads = [];
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn((body) => { sendPayloads.push(body); return res; }),
    };

    await errorHandler(testErr, {}, res, jest.fn());

    const body = sendPayloads[0];
    expect(res.status).toHaveBeenCalledWith(422);
    expect(body.message).toBe('test internal error');
    expect(body.code).toBe('ERR_TEST');
  });
});
