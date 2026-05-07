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
        const entry = { all: [], get: [], post: [], patch: [], delete: [] };
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
          patch: (...handlers) => {
            entry.patch.push(...handlers);
            return routeBuilder;
          },
          delete: (...handlers) => {
            entry.delete.push(...handlers);
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

    // Lazy-imported by adminBumpPlan — must be mocked before the handler runs.
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn().mockResolvedValue({
          _id: '607f1f77bcf86cd799439033',
          plan: 'free',
          organization: '507f1f77bcf86cd799439011',
        }),
        adminUpdatePlanOnly: jest.fn().mockResolvedValue({
          _id: '607f1f77bcf86cd799439033',
          plan: 'pro',
        }),
      },
    }));

    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: {
        setPlan: jest.fn().mockResolvedValue({}),
      },
    }));

    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    // Mock admin service to prevent deep import chain from touching mongoose models.
    jest.unstable_mockModule('../services/billing.admin.service.js', () => ({
      default: {
        getCustomerStatus: jest.fn(),
        syncOrgFromStripe: jest.fn(),
        replayWebhookEvent: jest.fn(),
        listDeadLetters: jest.fn(),
        purgeDeadLetter: jest.fn(),
        cancelSubscription: jest.fn(),
        creditDisputeReinstated: jest.fn(),
        // Batch 3a: adminBumpPlan now delegates here (controller→service refactor)
        bumpOrgPlan: jest.fn().mockResolvedValue({ _id: '607f1f77bcf86cd799439033', plan: 'pro' }),
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

  test('admin user can POST refund with valid body and stable idempotency key', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...refundRoute.all, ...refundRoute.post],
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500, reason: 'duplicate', refundRequestId: 'req-int-test001' } },
      res,
    );

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_123', reason: 'duplicate', amount: 2500 },
      { idempotencyKey: 'refund_admin_req-int-test001' },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('two calls with same refundRequestId use identical idempotency key (double-click protection)', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');

    const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
    const body = { chargeId: 'ch_test_dup', amountCents: 1000, reason: 'duplicate', refundRequestId: 'req-abc12345' };

    await runHandlers([...refundRoute.all, ...refundRoute.post], { method: 'POST', headers: { 'x-role': 'admin' }, body }, makeRes());
    await runHandlers([...refundRoute.all, ...refundRoute.post], { method: 'POST', headers: { 'x-role': 'admin' }, body }, makeRes());

    const calls = mockStripeInstance.refunds.create.mock.calls;
    expect(calls).toHaveLength(2);
    const key1 = calls[0][1].idempotencyKey;
    const key2 = calls[1][1].idempotencyKey;
    // Both calls share the same key → Stripe deduplicates → 1 effective refund
    expect(key1).toBe('refund_admin_req-abc12345');
    expect(key2).toBe('refund_admin_req-abc12345');
  });

  test('missing refundRequestId returns 422 from schema validation (BREAKING — required field)', async () => {
    const routes = await buildRoutes();
    const refundRoute = routes.get('/api/admin/billing/refund');

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const body = { chargeId: 'ch_test_dup2', amountCents: 500, reason: 'duplicate' };

    await runHandlers([...refundRoute.all, ...refundRoute.post], { method: 'POST', headers: { 'x-role': 'admin' }, body }, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
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
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', reason: 'requested_by_customer', refundRequestId: 'req-int-full001' } },
      res,
    );

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith(
      { charge: 'ch_test_123', reason: 'requested_by_customer' },
      { idempotencyKey: 'refund_admin_req-int-full001' },
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
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500, refundRequestId: 'req-int-err001' } },
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
      { method: 'POST', headers: { 'x-role': 'admin' }, body: { chargeId: 'ch_test_123', amountCents: 2500, refundRequestId: 'req-int-arg001' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });

  test('/api/admin/billing/plans/bump route is registered as PATCH with auth + validation middleware', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    // Route must exist and expose a PATCH handler array (not just be registered)
    expect(bumpRoute).toBeDefined();
    expect(bumpRoute.patch).toBeDefined();
    expect(bumpRoute.patch.length).toBeGreaterThan(0);
    // The .all chain should contain the JWT + policy guards (2 middleware functions)
    expect(bumpRoute.all.length).toBe(2);
  });

  test('admin can PATCH /api/admin/billing/plans/bump with valid body and gets 200', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.patch],
      {
        method: 'PATCH',
        headers: { 'x-role': 'admin' },
        body: { orgId: '507f1f77bcf86cd799439011', planId: 'pro' },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('non-admin user gets 403 on bump endpoint', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.patch],
      {
        method: 'PATCH',
        headers: { 'x-role': 'user' },
        body: { orgId: '507f1f77bcf86cd799439011', planId: 'pro' },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('invalid body for bump returns 422 from schema validation', async () => {
    const routes = await buildRoutes();
    const bumpRoute = routes.get('/api/admin/billing/plans/bump');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers(
      [...bumpRoute.all, ...bumpRoute.patch],
      {
        method: 'PATCH',
        headers: { 'x-role': 'admin' },
        // orgId missing, planId is not a valid enum value
        body: { planId: 'not-a-plan' },
      },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(422);
  });
});
