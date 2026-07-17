/**
 * Module dependencies.
 *
 * Unit tests for express.js initModulesServerRoutes — content-negotiated 404
 * for unmatched routes (#3975). Unknown routes must no longer return an
 * implicit 200 HTML page; API paths and explicit JSON accepts must get a
 * JSON 404, everything else a minimal HTML 404, and root behavior must be
 * unchanged.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

describe('express initModulesServerRoutes — content-negotiated 404 (#3975):', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  /**
   * Helper: extract initModulesServerRoutes from express.js (with all heavy
   * deps mocked) and mount it on a fresh Express app.
   * @returns {Promise<import('express').Express>} A ready-to-request Express app
   */
  const getApp = async () => {
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
    const app = express();
    await mod.default.initModulesServerRoutes(app);
    return app;
  };

  test('GET /api/nope → 404 JSON { error: "not_found" }', async () => {
    const app = await getApp();

    const res = await request(app).get('/api/nope').expect(404);

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  test('GET /api (no trailing slash) → 404 JSON', async () => {
    const app = await getApp();

    const res = await request(app).get('/api').expect(404);

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  test('GET /nope with Accept: text/html → 404 HTML, no JSON', async () => {
    const app = await getApp();

    const res = await request(app).get('/nope').set('Accept', 'text/html').expect(404);

    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('404');
  });

  test('GET /nope with Accept: application/json → 404 JSON { error: "not_found" }', async () => {
    const app = await getApp();

    const res = await request(app).get('/nope').set('Accept', 'application/json').expect(404);

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  // No explicit Accept header — supertest (and curl, and most agents) sends
  // none by default, which Express treats as an implicit `*/*`. Pins the
  // most common agent/curl default for both branches of the negotiation.
  test('GET /api/nope with no explicit Accept header → 404 JSON (isApiPath wins regardless of Accept)', async () => {
    const app = await getApp();

    const res = await request(app).get('/api/nope').expect(404);

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  test('GET /nope with no explicit Accept header → 404 HTML (implicit */* resolves to html)', async () => {
    const app = await getApp();

    const res = await request(app).get('/nope').expect(404);

    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('404');
  });

  // Express itself matches routes case-insensitively, so the isApiPath check
  // must too — otherwise /API/nope falls through to the HTML branch instead
  // of the JSON 404 an API consumer expects.
  test('GET /API/nope (mixed-case) → 404 JSON, matching /api case-insensitively', async () => {
    const app = await getApp();

    const res = await request(app).get('/API/nope').expect(404);

    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  test('GET / → 200, friendly root page unchanged', async () => {
    const app = await getApp();

    const res = await request(app).get('/').expect(200);

    expect(res.text).toContain('Devkit Node Api');
  });
});
