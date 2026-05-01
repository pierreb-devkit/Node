/**
 * Module dependencies.
 */
import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';

/**
 * Integration tests for billing admin endpoints.
 */
describe('Billing admin integration tests:', () => {
  let billingAdminRoutes;
  let mockBillingRefundService;
  let mockBillingPlanService;

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

    mockBillingRefundService = {
      refundCharge: jest.fn().mockResolvedValue({
        id: 're_test_123',
        charge: 'ch_test_123',
        amount: 2500,
        status: 'succeeded',
      }),
    };

    mockBillingPlanService = {
      bumpVersionWithRetry: jest.fn().mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        planId: 'pro',
        version: 'v7',
        meterQuota: 12345,
        ratios: { llm: 2 },
        active: true,
      }),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free', 'starter', 'pro'],
          statuses: ['active', 'canceled'],
        },
        validation: {
          supportedMethods: ['post', 'put', 'patch'],
        },
      },
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

    jest.unstable_mockModule('../services/billing.refund.service.js', () => ({
      default: mockBillingRefundService,
    }));

    jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
      default: mockBillingPlanService,
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

  test('non-admin user gets 403 on both admin endpoints', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');

    const refundRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'user' }, body: { chargeId: 'ch_test_001', amountCents: 1000 } },
      refundRes,
    );

    const bumpRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.post],
      { method: 'POST', headers: { 'x-role': 'user' }, body: { planId: 'pro', meterQuota: 1000 } },
      bumpRes,
    );

    expect(refundRes.status).toHaveBeenCalledWith(403);
    expect(bumpRes.status).toHaveBeenCalledWith(403);
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

    expect(mockBillingRefundService.refundCharge).toHaveBeenCalledWith('ch_test_123', 2500, { reason: 'duplicate' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('admin user can POST plan bump with valid body', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { planId: 'pro', meterQuota: 12345, ratios: { llm: 2 } } },
      res,
    );

    expect(mockBillingPlanService.bumpVersionWithRetry).toHaveBeenCalledWith('pro', { meterQuota: 12345, ratios: { llm: 2 } });
    expect(res.status).toHaveBeenCalledWith(200);
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

    expect(mockBillingRefundService.refundCharge).toHaveBeenCalledWith('ch_test_123', undefined, { reason: 'requested_by_customer' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('bump plan without meterQuota returns 422 from schema validation', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { planId: 'pro' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('refund service upstream error returns 502', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockBillingRefundService.refundCharge.mockRejectedValueOnce(new Error('upstream error'));

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(502);
  });

  test('refund service invalid argument error returns 422', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockBillingRefundService.refundCharge.mockRejectedValueOnce(new Error('invalid argument: amountCents must be > 0'));

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('bump plan service upstream error returns 502', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockBillingPlanService.bumpVersionWithRetry.mockRejectedValueOnce(new Error('E11000 duplicate key'));

    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { planId: 'pro', meterQuota: 12345 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(502);
  });

  test('bump plan service invalid argument error returns 422', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockBillingPlanService.bumpVersionWithRetry.mockRejectedValueOnce(new Error('invalid argument: meterQuota must be >= 0'));

    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { planId: 'pro', meterQuota: 12345 } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });
});
