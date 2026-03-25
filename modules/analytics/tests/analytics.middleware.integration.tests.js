/**
 * Module dependencies.
 */
import { jest, beforeAll, afterAll, beforeEach, describe, test, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Integration tests for analytics auto-capture middleware.
 * Boots a minimal Express app with the middleware mounted to validate
 * real HTTP request/response lifecycle behaviour.
 */
describe('Analytics middleware integration tests:', () => {
  let app;
  let mockTrack;

  beforeAll(async () => {
    jest.resetModules();

    mockTrack = jest.fn();

    jest.unstable_mockModule('../services/analytics.service.js', () => ({
      default: {
        track: mockTrack,
      },
    }));

    const { createAnalyticsMiddleware } = await import('../middlewares/analytics.middleware.js');

    app = express();
    app.use(createAnalyticsMiddleware());

    // Simulate auth middleware populating req.user / req.organization
    app.use((req, _res, next) => {
      if (req.headers['x-test-user']) {
        req.user = { _id: req.headers['x-test-user'] };
      }
      if (req.headers['x-test-org']) {
        req.organization = { _id: req.headers['x-test-org'] };
      }
      next();
    });

    app.get('/api/tasks', (_req, res) => res.json({ ok: true }));
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/public/logo.png', (_req, res) => res.send('img'));
    app.get('/favicon.ico', (_req, res) => res.send('ico'));
    app.get('/api/error', (_req, res) => res.status(500).json({ error: true }));
  });

  beforeEach(() => {
    mockTrack.mockClear();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('should track a normal API request with user and org', async () => {
    await request(app)
      .get('/api/tasks')
      .set('x-test-user', 'user-abc')
      .set('x-test-org', 'org-xyz')
      .expect(200);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(
      'user-abc',
      'api_request',
      expect.objectContaining({
        endpoint: '/api/tasks',
        method: 'GET',
        statusCode: 200,
        responseTime: expect.any(Number),
      }),
      { company: 'org-xyz' },
    );
  });

  test('should use "anonymous" when no user header is set', async () => {
    await request(app)
      .get('/api/tasks')
      .expect(200);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(
      'anonymous',
      'api_request',
      expect.any(Object),
      undefined,
    );
  });

  test('should omit groups when no org header is set', async () => {
    await request(app)
      .get('/api/tasks')
      .set('x-test-user', 'user-abc')
      .expect(200);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    const groups = mockTrack.mock.calls[0][3];
    expect(groups).toBeUndefined();
  });

  test('should not track /api/health requests', async () => {
    await request(app)
      .get('/api/health')
      .expect(200);

    expect(mockTrack).not.toHaveBeenCalled();
  });

  test('should not track /public requests', async () => {
    await request(app)
      .get('/public/logo.png')
      .expect(200);

    expect(mockTrack).not.toHaveBeenCalled();
  });

  test('should not track /favicon requests', async () => {
    await request(app)
      .get('/favicon.ico')
      .expect(200);

    expect(mockTrack).not.toHaveBeenCalled();
  });

  test('should capture real status code for error responses', async () => {
    await request(app)
      .get('/api/error')
      .set('x-test-user', 'user-abc')
      .expect(500);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(
      'user-abc',
      'api_request',
      expect.objectContaining({ statusCode: 500 }),
      undefined,
    );
  });

  test('should capture positive responseTime', async () => {
    await request(app)
      .get('/api/tasks')
      .expect(200);

    const properties = mockTrack.mock.calls[0][2];
    expect(properties.responseTime).toBeGreaterThanOrEqual(0);
  });

  test('should strip query strings from endpoint', async () => {
    await request(app)
      .get('/api/tasks?page=1&token=secret')
      .expect(200);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    const properties = mockTrack.mock.calls[0][2];
    expect(properties.endpoint).toBe('/api/tasks');
  });
});
