/**
 * Module dependencies.
 *
 * Unit tests for express.js initModulesServerRoutes — content-negotiated 404
 * for unmatched routes (#3975), extended in #3978 to cover every HTTP verb
 * (not just GET) via app.all. Unknown routes must no longer return an
 * implicit 200 HTML page; API paths and explicit JSON accepts must get a
 * JSON 404, everything else a minimal HTML 404, root behavior must be
 * unchanged, and OPTIONS preflight must still be answered by cors rather
 * than the catch-all.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

describe('express initModulesServerRoutes — content-negotiated 404 (#3975, #3978):', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  /**
   * Mocks every heavy dependency initModulesServerRoutes (and, transitively,
   * express.js's module scope) needs, so the real module can be imported in
   * isolation. Used by getApp below.
   * @returns {void}
   */
  const mockCommonDeps = () => {
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
  };

  /**
   * Helper: extract initModulesServerRoutes from express.js (with all heavy
   * deps mocked) and mount it on a fresh Express app. `withCors: true` also
   * mounts the REAL `cors` middleware (not a mock) ahead of the catch-all,
   * with the same order and config express.js's own `init()` uses (there,
   * initMiddleware — which mounts cors — runs before
   * initModulesServerRoutes). This only checks that cors' own preflight
   * handling wins when wired in that order and config; it does not assert
   * that `init()` itself preserves the order (a full-boot test would need
   * to mock most of `init()`'s other steps too — out of scope here).
   * @param {object} [options] - Options
   * @param {boolean} [options.withCors] - Mount the real cors middleware ahead of the catch-all
   * @returns {Promise<import('express').Express>} A ready-to-request Express app
   */
  const getApp = async ({ withCors = false } = {}) => {
    mockCommonDeps();

    const mod = await import('../../../lib/services/express.js');
    const app = express();
    if (withCors) {
      const { default: cors } = await import('cors');
      app.use(cors({ origin: [], credentials: false, optionsSuccessStatus: 200 }));
    }
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

  // #3978: the catch-all was registered with app.get only, so an unmatched
  // POST/PUT/PATCH/DELETE (or OPTIONS, absent cors) fell through to
  // Express's default HTML finalhandler instead of getting the same
  // content-negotiated 404. It is now registered with app.all — verify
  // every non-GET verb on both an API path and a non-API path. `options` is
  // included here (with no cors mounted) to prove the catch-all really does
  // match it — the risk the dedicated cors-ordering test below mitigates.
  describe.each(['post', 'put', 'patch', 'delete', 'options'])('%s (unmatched, all verbs must 404 like GET — #3978)', (method) => {
    test(`${method.toUpperCase()} /api/nope → 404 JSON { error: "not_found" }`, async () => {
      const app = await getApp();

      const res = await request(app)[method]('/api/nope').expect(404);

      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual({ error: 'not_found' });
    });

    test(`${method.toUpperCase()} /nope with Accept: text/html → 404 HTML, no JSON`, async () => {
      const app = await getApp();

      const res = await request(app)[method]('/nope').set('Accept', 'text/html').expect(404);

      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('404');
    });
  });

  // #3978: app.all also matches OPTIONS preflight — the one real risk the
  // issue calls out. The loop above already proves the catch-all matches it
  // when nothing else intercepts; this proves production's actual
  // middleware order (cors mounted ahead of routes in express.js `init()`)
  // means a real preflight never gets there.
  test('OPTIONS preflight is answered by the real cors middleware before the catch-all (production ordering, #3978)', async () => {
    const app = await getApp({ withCors: true });

    const res = await request(app)
      .options('/api/anything')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(200);

    // cors' own preflight response: it sets Access-Control-Allow-Methods and
    // ends the request itself (optionsSuccessStatus: 200), never calling
    // next() — so the catch-all's JSON 404 body must never appear here.
    expect(res.headers['access-control-allow-methods']).toBeDefined();
    expect(res.body).not.toEqual({ error: 'not_found' });
  });
});
