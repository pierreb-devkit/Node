/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for analytics auto-capture middleware
 */
describe('Analytics middleware unit tests:', () => {
  let analyticsMiddleware;
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

    jest.unstable_mockModule('../services/analytics.service.js', () => ({
      default: {
        track: mockTrack,
      },
    }));

    const mod = await import('../middlewares/analytics.middleware.js');
    analyticsMiddleware = mod.default;

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
      expect.anything(),
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
});
