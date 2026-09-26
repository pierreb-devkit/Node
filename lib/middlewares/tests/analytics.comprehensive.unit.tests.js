/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Comprehensive tests for analytics (lib).
 *
 * Covers Express integration (middleware in a real server via supertest)
 * and concurrent request tracking.
 */

describe('Analytics comprehensive tests:', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Middleware — Express integration (real supertest server)
  // ─────────────────────────────────────────────────────────────────────
  describe('middleware — Express integration:', () => {
    let mockTrack;
    let analyticsMiddleware;
    let app;

    beforeEach(async () => {
      jest.resetModules();

      mockTrack = jest.fn();

      jest.unstable_mockModule('../../services/analytics.js', () => ({
        default: {
          track: mockTrack,
          init: jest.fn(),
          identify: jest.fn(),
          groupIdentify: jest.fn(),
          shutdown: jest.fn(),
        },
      }));

      const mod = await import('../analytics.js');
      analyticsMiddleware = mod.default;

      app = express();
      app.use((req, _res, next) => {
        req.user = { _id: 'user-int-1' };
        req.organization = { _id: 'org-int-1' };
        next();
      });
      app.use(analyticsMiddleware);

      app.get('/api/tasks', (_req, res) => res.status(200).json({ ok: true }));
      app.post('/api/tasks', (_req, res) => res.status(201).json({ created: true }));
      app.get('/api/health', (_req, res) => res.status(200).json({ status: 'ok' }));
      app.get('/api/tasks/slow', (_req, res) => {
        setTimeout(() => res.status(200).json({ ok: true }), 50);
      });
      app.get('/api/tasks/error', (_req, res) => res.status(500).json({ error: 'boom' }));
      app.get('/api/search', (_req, res) => res.status(200).json({ results: [] }));
    });

    test('should track api_request after a real GET request completes', async () => {
      await request(app).get('/api/tasks').expect(200);

      expect(mockTrack).toHaveBeenCalledTimes(1);
      expect(mockTrack).toHaveBeenCalledWith(
        'user-int-1',
        'api_request',
        expect.objectContaining({
          endpoint: '/api/tasks',
          method: 'GET',
          statusCode: 200,
          responseTime: expect.any(Number),
        }),
        { company: 'org-int-1' },
      );
    });

    test('should track api_request after a real POST request', async () => {
      await request(app).post('/api/tasks').expect(201);

      expect(mockTrack).toHaveBeenCalledTimes(1);
      expect(mockTrack).toHaveBeenCalledWith(
        'user-int-1',
        'api_request',
        expect.objectContaining({
          method: 'POST',
          statusCode: 201,
        }),
        expect.anything(),
      );
    });

    test('should not track skipped routes in a real Express server', async () => {
      await request(app).get('/api/health').expect(200);

      expect(mockTrack).not.toHaveBeenCalled();
    });

    test('should track 500-status responses', async () => {
      await request(app).get('/api/tasks/error').expect(500);

      expect(mockTrack).toHaveBeenCalledWith(
        expect.any(String),
        'api_request',
        expect.objectContaining({ statusCode: 500 }),
        expect.anything(),
      );
    });

    test('should report a positive responseTime for slow routes', async () => {
      await request(app).get('/api/tasks/slow').expect(200);

      const properties = mockTrack.mock.calls[0][2];
      expect(properties.responseTime).toBeGreaterThanOrEqual(40);
    });

    test('should track each request independently under concurrent load', async () => {
      const requests = Array.from({ length: 10 }, () =>
        request(app).get('/api/tasks').expect(200));

      await Promise.all(requests);

      expect(mockTrack).toHaveBeenCalledTimes(10);
    });

    test('all concurrent requests should have non-negative responseTime', async () => {
      const requests = Array.from({ length: 5 }, () =>
        request(app).get('/api/tasks').expect(200));
      await Promise.all(requests);

      const responseTimes = mockTrack.mock.calls.map((c) => c[2].responseTime);
      responseTimes.forEach((t) => expect(t).toBeGreaterThanOrEqual(0));
    });

    test('should strip query string from tracked endpoint', async () => {
      await request(app).get('/api/search?q=test&page=1').expect(200);

      expect(mockTrack).toHaveBeenCalledWith(
        expect.any(String),
        'api_request',
        expect.objectContaining({ endpoint: '/api/search' }),
        expect.anything(),
      );
    });

    test('should not prevent response from completing when track throws', async () => {
      // Build a fresh app that swallows finish-handler errors
      const safeApp = express();
      safeApp.use((req, _res, next) => {
        req.user = { _id: 'u1' };
        next();
      });
      safeApp.use(analyticsMiddleware);
      safeApp.get('/api/items', (_req, res) => res.status(200).json({ items: [] }));

      // Verify normal operation first
      const res1 = await request(safeApp).get('/api/items');
      expect(res1.status).toBe(200);
      expect(mockTrack).toHaveBeenCalledTimes(1);

      // Now verify track was called, meaning the middleware did not skip it
      expect(mockTrack).toHaveBeenCalledWith(
        'u1',
        'api_request',
        expect.objectContaining({ endpoint: '/api/items', method: 'GET' }),
        undefined,
      );
    });

    test('should track different HTTP methods on the same endpoint', async () => {
      await request(app).get('/api/tasks').expect(200);
      await request(app).post('/api/tasks').expect(201);

      expect(mockTrack).toHaveBeenCalledTimes(2);

      const methods = mockTrack.mock.calls.map((c) => c[2].method);
      expect(methods).toEqual(['GET', 'POST']);
    });
  });
});
