/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for analytics auto-capture middleware
 */
describe('Analytics middleware unit tests:', () => {
  let analyticsMiddleware;
  let createAnalyticsMiddleware;
  let mockTrack;

  /** @type {import('express').Request} */
  let req;
  /** @type {import('express').Response & { _finishHandlers: Function[] }} */
  let res;
  /** @type {jest.Mock} */
  let next;

  beforeEach(async () => {
    jest.resetModules();

    mockTrack = jest.fn();

    jest.unstable_mockModule('../../services/analytics.js', () => ({
      default: {
        track: mockTrack,
      },
    }));

    const mod = await import('../analytics.js');
    analyticsMiddleware = mod.default;
    createAnalyticsMiddleware = mod.createAnalyticsMiddleware;

    // Build minimal Express-like req/res mocks
    req = {
      originalUrl: '/api/tasks',
      url: '/api/tasks',
      method: 'GET',
      user: { _id: 'user-123' },
      organization: { _id: 'org-456' },
    };

    const finishHandlers = [];
    res = {
      statusCode: 200,
      on: jest.fn((event, handler) => {
        if (event === 'finish') finishHandlers.push(handler);
      }),
      _finishHandlers: finishHandlers,
    };

    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Helper — trigger all registered 'finish' handlers on res.
   */
  const triggerFinish = () => {
    res._finishHandlers.forEach((fn) => fn());
  };

  test('should call next immediately', () => {
    analyticsMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('should register a finish listener on res', () => {
    analyticsMiddleware(req, res, next);
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  test('should track api_request with correct properties on finish', () => {
    analyticsMiddleware(req, res, next);
    triggerFinish();

    expect(mockTrack).toHaveBeenCalledWith(
      'user-123',
      'api_request',
      expect.objectContaining({
        endpoint: '/api/tasks',
        method: 'GET',
        statusCode: 200,
        responseTime: expect.any(Number),
      }),
      { company: 'org-456' },
    );
  });

  test('should use "anonymous" when req.user is absent', () => {
    req.user = undefined;
    req.organization = undefined;
    analyticsMiddleware(req, res, next);
    triggerFinish();

    expect(mockTrack).toHaveBeenCalledWith(
      'anonymous',
      'api_request',
      expect.any(Object),
      undefined,
    );
  });

  test('should use "anonymous" when req.user._id is missing', () => {
    req.user = {};
    analyticsMiddleware(req, res, next);
    triggerFinish();

    expect(mockTrack).toHaveBeenCalledWith(
      'anonymous',
      'api_request',
      expect.any(Object),
      { company: 'org-456' },
    );
  });

  test('should omit groups when req.organization is absent', () => {
    req.organization = undefined;
    analyticsMiddleware(req, res, next);
    triggerFinish();

    expect(mockTrack).toHaveBeenCalledWith(
      'user-123',
      'api_request',
      expect.any(Object),
      undefined,
    );
  });

  test('should skip /api/health routes', () => {
    req.originalUrl = '/api/health';
    analyticsMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.on).not.toHaveBeenCalled();
  });

  test('should skip /api/health sub-routes', () => {
    req.originalUrl = '/api/health/ready';
    analyticsMiddleware(req, res, next);

    expect(res.on).not.toHaveBeenCalled();
  });

  test('should skip /public static assets', () => {
    req.originalUrl = '/public/images/logo.png';
    analyticsMiddleware(req, res, next);

    expect(res.on).not.toHaveBeenCalled();
  });

  test('should skip /favicon requests', () => {
    req.originalUrl = '/favicon.ico';
    analyticsMiddleware(req, res, next);

    expect(res.on).not.toHaveBeenCalled();
  });

  test('should capture correct statusCode from res on finish', () => {
    analyticsMiddleware(req, res, next);
    res.statusCode = 404;
    triggerFinish();

    expect(mockTrack).toHaveBeenCalledWith(
      expect.any(String),
      'api_request',
      expect.objectContaining({ statusCode: 404 }),
      expect.anything(),
    );
  });

  test('should capture responseTime as a non-negative number', () => {
    analyticsMiddleware(req, res, next);
    triggerFinish();

    const properties = mockTrack.mock.calls[0][2];
    expect(properties.responseTime).toBeGreaterThanOrEqual(0);
  });

  test('should fall back to req.url when originalUrl is absent', () => {
    req.originalUrl = undefined;
    req.url = '/api/fallback';
    analyticsMiddleware(req, res, next);
    triggerFinish();

    expect(mockTrack).toHaveBeenCalledWith(
      expect.any(String),
      'api_request',
      expect.objectContaining({ endpoint: '/api/fallback' }),
      expect.anything(),
    );
  });

  test('should strip query strings from endpoint', () => {
    req.originalUrl = '/api/tasks?page=1&secret=abc';
    analyticsMiddleware(req, res, next);
    triggerFinish();

    expect(mockTrack).toHaveBeenCalledWith(
      expect.any(String),
      'api_request',
      expect.objectContaining({ endpoint: '/api/tasks' }),
      expect.anything(),
    );
  });

  test('should redact a single-use token embedded in the path (no matched route)', () => {
    req.originalUrl = '/api/auth/reset/SECRETTOKEN';
    req.url = '/api/auth/reset/SECRETTOKEN';
    req.route = undefined; // unmatched / 404 — fall back to the path redactor
    analyticsMiddleware(req, res, next);
    triggerFinish();

    const { endpoint } = mockTrack.mock.calls[0][2];
    expect(endpoint).toBe('/api/auth/reset/REDACTED');
    expect(endpoint).not.toContain('SECRETTOKEN');
  });

  test('should redact path tokens for verify-email and invitation verify routes', () => {
    const cases = [
      ['/api/auth/verify-email/SECRETTOKEN', '/api/auth/verify-email/REDACTED'],
      ['/api/auth/invitations/verify/SECRETTOKEN', '/api/auth/invitations/verify/REDACTED'],
      ['/api/invitations/verify/SECRETTOKEN', '/api/invitations/verify/REDACTED'],
    ];

    cases.forEach(([raw, expected]) => {
      mockTrack.mockClear();
      // Fresh res per case so a prior iteration's finish handler is not re-fired.
      const finishHandlers = [];
      const localRes = {
        statusCode: 200,
        on: jest.fn((event, handler) => {
          if (event === 'finish') finishHandlers.push(handler);
        }),
      };
      req.originalUrl = raw;
      req.url = raw;
      req.route = undefined;
      analyticsMiddleware(req, localRes, next);
      finishHandlers.forEach((fn) => fn());

      const { endpoint } = mockTrack.mock.calls[0][2];
      expect(endpoint).toBe(expected);
      expect(endpoint).not.toContain('SECRETTOKEN');
    });
  });

  test('should prefer the matched route pattern over the concrete path', () => {
    req.originalUrl = '/api/auth/reset/SECRETTOKEN';
    req.url = '/api/auth/reset/SECRETTOKEN';
    req.baseUrl = '';
    req.route = { path: '/api/auth/reset/:token' };
    analyticsMiddleware(req, res, next);
    triggerFinish();

    const { endpoint } = mockTrack.mock.calls[0][2];
    expect(endpoint).toBe('/api/auth/reset/:token');
    expect(endpoint).not.toContain('SECRETTOKEN');
  });

  test('should prefix the route pattern with req.baseUrl when the router is mounted', () => {
    req.originalUrl = '/api/auth/reset/SECRETTOKEN';
    req.url = '/api/auth/reset/SECRETTOKEN';
    req.baseUrl = '/api/auth';
    req.route = { path: '/reset/:token' };
    analyticsMiddleware(req, res, next);
    triggerFinish();

    const { endpoint } = mockTrack.mock.calls[0][2];
    expect(endpoint).toBe('/api/auth/reset/:token');
    expect(endpoint).not.toContain('SECRETTOKEN');
  });

  test('should accept custom skipPrefixes via createAnalyticsMiddleware', () => {
    const customMiddleware = createAnalyticsMiddleware({ skipPrefixes: ['/custom'] });
    req.originalUrl = '/custom/path';
    customMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.on).not.toHaveBeenCalled();
  });

  test('should not skip default prefixes when custom skipPrefixes provided', () => {
    const customMiddleware = createAnalyticsMiddleware({ skipPrefixes: ['/custom'] });
    req.originalUrl = '/api/health';
    customMiddleware(req, res, next);

    // /api/health is NOT in the custom prefixes, so it should be tracked
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  test('should not throw when track throws inside finish handler', () => {
    mockTrack.mockImplementation(() => {
      throw new Error('PostHog exploded');
    });

    analyticsMiddleware(req, res, next);

    // The finish handler should swallow the error
    expect(() => triggerFinish()).not.toThrow();
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });
});
