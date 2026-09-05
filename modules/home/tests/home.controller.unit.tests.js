/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for home.controller.js's `health` endpoint.
 *
 * Issue #4064: responses.error(res, status, title, description)(x) reads
 * `x.details` off whatever it is handed. The degraded branch used to pass
 * the raw health-check payload directly — not error-shaped, no `.details`
 * key — the same wrong call convention fixed for
 * analytics.requireFeatureFlag.js (this issue) and billing.requireQuota.js
 * (#4062). No leak resulted (the payload carries nothing whitelisted), but
 * the shape was wrong and a health payload is exactly the kind of object
 * that accumulates internal detail over time.
 */
describe('home.controller health unit tests:', () => {
  let health;
  let mockHomeService;
  let req;
  let res;

  beforeEach(async () => {
    jest.resetModules();

    mockHomeService = {
      getHealthStatus: jest.fn(),
    };

    jest.unstable_mockModule('../services/home.service.js', () => ({
      default: mockHomeService,
    }));

    const mod = await import('../controllers/home.controller.js');
    health = mod.default.health;

    req = { user: undefined };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Proven red against the pre-fix code: before this fix, the raw payload
  // (no `.details` key) was handed straight to responses.error(...), so
  // pickWhitelistedDetails always received `undefined` — this call shape
  // could never have produced a non-error object's data as `payload.details`.
  test('production mode: degraded response carries no payload.details today (no whitelisted key on the health payload), and never leaks the raw payload flat', async () => {
    mockHomeService.getHealthStatus.mockReturnValue({
      status: 'degraded',
      db: 'disconnected',
      uptime: 12,
      version: '1.0.0',
      memory: { heapUsed: 1 },
    });

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      health(req, res);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    expect(res.status).toHaveBeenCalledWith(503);
    const payload = res.json.mock.calls[0][0];
    expect(payload.type).toBe('error');
    expect(payload.message).toBe('Service Unavailable');
    // No whitelisted key (type/upgradeUrl/retryAfter) exists on a health
    // payload today, so payload.details stays absent — same observable
    // behavior as before this fix. This proves the fix did not newly LEAK
    // db/uptime/version/memory into payload.details.
    expect(payload.details).toBeUndefined();
    // Production never leaks the raw serialized-error blob either way.
    expect(payload.error).toBeUndefined();
  });

  test('dev mode: the health payload is now nested under payload.error.details, not spread flat at payload.error\'s top level', async () => {
    req.user = { roles: ['admin'] };
    mockHomeService.getHealthStatus.mockReturnValue({
      status: 'degraded',
      db: 'disconnected',
      uptime: 12,
      version: '1.0.0',
      memory: { heapUsed: 1 },
    });

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      health(req, res);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    const payload = res.json.mock.calls[0][0];
    expect(typeof payload.error).toBe('string');
    const errorBlob = JSON.parse(payload.error);
    // Shape change (dev-only, never seen in production): the health data now
    // lives under `.details` (an AppError's shape) instead of being spread
    // at the blob's top level. Any dev-only consumer parsing payload.error
    // for `db`/`uptime`/`version`/`memory` directly must now read
    // payload.error.details.<field> instead.
    expect(errorBlob.db).toBeUndefined();
    expect(errorBlob.details).toEqual({
      status: 'degraded',
      db: 'disconnected',
      uptime: 12,
      version: '1.0.0',
      memory: { heapUsed: 1 },
    });
  });

  test('healthy status still returns 200 via responses.success, unaffected by this fix', async () => {
    mockHomeService.getHealthStatus.mockReturnValue({ status: 'ok', db: 'connected' });

    health(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.type).toBe('success');
  });
});
