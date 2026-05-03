/**
 * Module dependencies.
 */
import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';

/**
 * Integration tests for billing admin endpoints.
 * Tests the /api/admin/billing/refund endpoint with the inline refund logic
 * (billing.refund.service.js was dropped in PR2; Stripe is called directly).
 */
describe('Billing admin integration tests:', () => {
  let billingAdminRoutes;
  let mockStripeInstance;

  /**
   * Create a lightweight route registry compatible with app.route().
   * @returns {{app: Object, routes: Map<string, Object>}} Mock app and collected routes.
   */
  const createRouteRegistry = () => {
    const routes = new Map();
    const app = {
      route: jest.fn((path) => {
        const entry = { all: [], get: [], post: [] };
        routes.set(path, entry);
        const routeBuilder = {
          all: (...handlers) => {
            entry.all.push(...handlers);
            return routeBuilder;
          },
          get: (...handlers) => {
            entry.get.push(...handlers);
            return routeBuilder;
          },
          post: (...handlers) => {
            entry.post.push(...handlers);
            return routeBuilder;
          },
        };
        return routeBuilder;
      }),
    };
    return { app, routes };
  };

  /**
   * Execute middleware/handler chain sequentially.
   * @param {Function[]} handlers - Middleware/handlers to execute.
   * @param {Object} req - Mock Express request.
   * @param {Object} res - Mock Express response.
   * @returns {Promise<void>}
   */
  const runHandlers = async (handlers, req, res) => {
    const dispatch = async (index) => {
      const handler = handlers[index];
      if (!handler) return;
      if (handler.length >= 3) {
        let nextPromise = null;
        await handler(req, res, () => {
          nextPromise = dispatch(index + 1);
          return nextPromise;
        });
        if (nextPromise) await nextPromise;
        return;
      }
      await handler(req, res);
    };

    await dispatch(0);
  };

  /**
   * Build route module with mocked dependencies.
   * @returns {Promise<Map<string, Object>>} Collected route map.
   */
  const buildRoutes = async () => {
    jest.resetModules();

    mockStripeInstance = {
      refunds: {
        create: jest.fn().mockResolvedValue({
          id: 're_test_123',
          charge: 'ch_test_123',
          amount: 2500,
          status: 'succeeded',
        }),
      },
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free', 'starter', 'pro'],
          statuses: ['active', 'canceled'],
        },
        stripe: {
          secretKey: 'sk_test_fake',
        },
        validation: {
          supportedMethods: ['post', 'put', 'patch'],
        },
      },
    }));

    jest.unstable_mockModule('stripe', () => ({
      default: jest.fn(() => mockStripeInstance),
    }));

    jest.unstable_mockModule('passport', () => ({
      default: {
        authenticate: jest.fn(() => (req, _res, next) => {
          const role = req.headers?.['x-role'] || 'user';
          req.user = { _id: '507f1f77bcf86cd799439022', roles: [role] };
          next();
        }),
      },
    }));

    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: {
        isAllowed: jest.fn((req, res, next) => {
          if (req.user?.roles?.includes('admin')) return next();
          return res.status(403).json({
            type: 'error',
            message: 'Unauthorized',
            code: 403,
            status: 403,
            errorCode: 'SERVER_ERROR',
            description: 'User is not authorized',
          });
        }),
      },
    }));

    jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
      default: {
        isValid: (schema) => (req, res, next) => {
          const result = schema.safeParse(req.body);
          if (!result.success) {
            return res.status(422).json({
              type: 'error',
              message: 'Schema validation error',
            });
          }
          req.body = result.data;
          return next();
        },
      },
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        // eslint-disable-next-line no-unused-vars
        success: jest.fn((res, msg) => (data) => res.status(200).json({ type: 'success', data })),
        // eslint-disable-next-line no-unused-vars
        error: jest.fn((res, status, title, desc) => (err) => res.status(status).json({ type: 'error' })),
      },
    }));

    billingAdminRoutes = (await import('../routes/billing.admin.routes.js')).default;

    const { app, routes } = createRouteRegistry();
    billingAdminRoutes(app);
    return routes;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('non-admin user gets 403 on refund endpoint', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'user' }, body: { chargeId: 'ch_test_001', amountCents: 1000 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('admin user can POST refund with valid body', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500, reason: 'duplicate' } },
      res,
    );

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_123', reason: 'duplicate', amount: 2500 },
      { idempotencyKey: expect.stringMatching(/^refund_ch_test_123_2500_[0-9a-f-]{36}$/) },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('two calls same charge same amount produce two separate idempotency keys', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');

    const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
    const body = { chargeId: 'ch_test_dup', amountCents: 1000, reason: 'duplicate' };

    await runHandlers([...refundRoute.all, ...refundRoute.post], { method: 'POST', headers: { 'x-role': 'admin' }, body }, makeRes());
    await runHandlers([...refundRoute.all, ...refundRoute.post], { method: 'POST', headers: { 'x-role': 'admin' }, body }, makeRes());

    const calls = mockStripeInstance.refunds.create.mock.calls;
    expect(calls).toHaveLength(2);
    const key1 = calls[0][1].idempotencyKey;
    const key2 = calls[1][1].idempotencyKey;
    expect(key1).toMatch(/^refund_ch_test_dup_1000_[0-9a-f-]{36}$/);
    expect(key2).toMatch(/^refund_ch_test_dup_1000_[0-9a-f-]{36}$/);
    // Keys are distinct — each call gets its own idempotency window
    expect(key1).not.toBe(key2);
  });

  test('invalid body returns 422 from schema validation', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: '', amountCents: 0 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('invalid Stripe reason returns 422 from schema validation', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', reason: 'not_a_valid_reason' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('admin user can POST full refund without amountCents', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', reason: 'requested_by_customer' } },
      res,
    );

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_123', reason: 'requested_by_customer' },
      { idempotencyKey: expect.stringMatching(/^refund_ch_test_123_full_[0-9a-f-]{36}$/) },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('Stripe upstream error returns 502', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockStripeInstance.refunds.create.mockRejectedValueOnce(new Error('upstream error'));

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(502);
  });

  test('Stripe invalid argument error returns 422', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockStripeInstance.refunds.create.mockRejectedValueOnce(new Error('invalid argument: amountCents must be > 0'));

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('/api/admin/billing/plans/bump route no longer registered (endpoint removed)', async () => {
    const routes = await buildRoutes();
    expect(routes.has('/api/admin/billing/plans/bump')).toBe(false);
  });
});
