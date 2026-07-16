/**
 * Module dependencies.
 */
import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';

/**
 * Integration tests for billing admin toolkit endpoints (feat/billing-admin-toolkit-foundations).
 * Covers all 6 new routes: customer/:orgId, sync/:orgId, webhook/replay, dead-letters,
 * dead-letters/:eventId, cancel/:orgId.
 */
describe('Billing admin toolkit integration tests:', () => {
  let billingAdminRoutes;
  let mockAdminService;
  let mockStripeInstance;

  const orgId = '507f1f77bcf86cd799439011';
  const eventId = 'evt_test_replay_001';

  /**
   * Create a lightweight route registry.
   */
  const createRouteRegistry = () => {
    const routes = new Map();
    const app = {
      route: jest.fn((path) => {
        const entry = { all: [], get: [], post: [], patch: [], delete: [] };
        routes.set(path, entry);
        const routeBuilder = {
          all: (...handlers) => { entry.all.push(...handlers); return routeBuilder; },
          get: (...handlers) => { entry.get.push(...handlers); return routeBuilder; },
          post: (...handlers) => { entry.post.push(...handlers); return routeBuilder; },
          patch: (...handlers) => { entry.patch.push(...handlers); return routeBuilder; },
          delete: (...handlers) => { entry.delete.push(...handlers); return routeBuilder; },
        };
        return routeBuilder;
      }),
    };
    return { app, routes };
  };

  /**
   * Execute middleware/handler chain sequentially.
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
   */
  const buildRoutes = async () => {
    jest.resetModules();

    mockAdminService = {
      getCustomerStatus: jest.fn().mockResolvedValue({ db: { plan: 'pro', status: 'active' }, stripe: null }),
      syncOrgFromStripe: jest.fn().mockResolvedValue({ previous: { plan: 'pro' }, updated: { plan: 'pro' } }),
      replayWebhookEvent: jest.fn().mockResolvedValue({ eventId, eventType: 'customer.subscription.updated', result: {} }),
      listDeadLetters: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      purgeDeadLetter: jest.fn().mockResolvedValue({ purged: true }),
      cancelSubscription: jest.fn().mockResolvedValue({ previous: { plan: 'pro', status: 'active' }, updated: {}, stripeStatus: 'canceled' }),
      creditDisputeReinstated: jest.fn().mockResolvedValue({ applied: true, ledgerEntry: { refId: 'dispute-credit-test', amount: 2500 } }),
    };

    mockStripeInstance = {
      refunds: { create: jest.fn().mockResolvedValue({ id: 're_test', amount: 2500, status: 'succeeded' }) },
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: { plans: ['free', 'starter', 'pro'], statuses: ['active', 'canceled', 'past_due'] },
        stripe: { secretKey: 'sk_test_fake' },
        validation: { supportedMethods: ['post', 'put', 'patch'] },
      },
    }));

    jest.unstable_mockModule('stripe', () => ({ default: jest.fn(() => mockStripeInstance) }));

    jest.unstable_mockModule('passport', () => ({
      default: {
        authenticate: jest.fn(() => (req, _res, next) => {
          req.user = { _id: '507f1f77bcf86cd799439022', roles: [req.headers?.['x-role'] || 'user'] };
          next();
        }),
      },
    }));

    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: {
        isAllowed: jest.fn((req, res, next) => {
          if (req.user?.roles?.includes('admin')) return next();
          return res.status(403).json({ type: 'error', code: 403, message: 'Unauthorized' });
        }),
      },
    }));

    jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
      default: {
        isValid: (schema) => (req, res, next) => {
          const result = schema.safeParse(req.body);
          if (!result.success) return res.status(422).json({ type: 'error' });
          req.body = result.data;
          return next();
        },
      },
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: jest.fn((_res, _msg) => (data) => _res.status(200).json({ type: 'success', data })), // eslint-disable-line no-unused-vars
        error: jest.fn((_res, status) => (_err) => _res.status(status).json({ type: 'error' })), // eslint-disable-line no-unused-vars
      },
    }));

    jest.unstable_mockModule('../services/billing.admin.service.js', () => ({
      default: mockAdminService,
    }));

    // Lazy-imported by adminBumpPlan — needed for the bump route that's still in the file
    jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
      default: {
        findByOrganization: jest.fn().mockResolvedValue({ _id: 'x', plan: 'free' }),
        adminUpdatePlanOnly: jest.fn().mockResolvedValue({ plan: 'pro' }),
      },
    }));
    jest.unstable_mockModule('../../organizations/repositories/organizations.repository.js', () => ({
      default: { setPlan: jest.fn().mockResolvedValue({}) },
    }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    }));

    billingAdminRoutes = (await import('../routes/billing.admin.routes.js')).default;
    const { app, routes } = createRouteRegistry();
    billingAdminRoutes(app);
    return routes;
  };

  const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Route registration ────────────────────────────────────────────────────────

  test('all 6 admin toolkit routes are registered', async () => {
    const routes = await buildRoutes();

    expect(routes.has(`/api/admin/billing/customer/:orgId`)).toBe(true);
    expect(routes.has(`/api/admin/billing/sync/:orgId`)).toBe(true);
    expect(routes.has(`/api/admin/billing/webhook/replay`)).toBe(true);
    expect(routes.has(`/api/admin/billing/dead-letters`)).toBe(true);
    expect(routes.has(`/api/admin/billing/dead-letters/:eventId`)).toBe(true);
    expect(routes.has(`/api/admin/billing/cancel/:orgId`)).toBe(true);
  });

  // ── GET /api/admin/billing/customer/:orgId ────────────────────────────────────

  describe('GET /api/admin/billing/customer/:orgId', () => {
    test('admin gets 200 with customer status', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/customer/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.get],
        { headers: { 'x-role': 'admin' }, params: { orgId } },
        res,
      );

      expect(mockAdminService.getCustomerStatus).toHaveBeenCalledWith(orgId);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('non-admin gets 403', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/customer/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.get],
        { headers: { 'x-role': 'user' }, params: { orgId } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('returns 404 when service throws 404', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/customer/:orgId');
      const res = makeRes();

      mockAdminService.getCustomerStatus.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));

      await runHandlers(
        [...route.all, ...route.get],
        { headers: { 'x-role': 'admin' }, params: { orgId } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // ── POST /api/admin/billing/sync/:orgId ──────────────────────────────────────

  describe('POST /api/admin/billing/sync/:orgId', () => {
    test('admin gets 200 on successful sync', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/sync/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(mockAdminService.syncOrgFromStripe).toHaveBeenCalledWith(orgId);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('non-admin gets 403', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/sync/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'user' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('returns 422 when service throws 422', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/sync/:orgId');
      const res = makeRes();
      mockAdminService.syncOrgFromStripe.mockRejectedValue(
        Object.assign(new Error('no stripe sub id'), { status: 422 }),
      );

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(422);
    });

    test('returns 502 when service throws 502', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/sync/:orgId');
      const res = makeRes();
      mockAdminService.syncOrgFromStripe.mockRejectedValue(
        Object.assign(new Error('Stripe not configured'), { status: 502 }),
      );

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(502);
    });

    // #3964 — resolveStripePlan aborts (409) rather than silently downgrading to 'free'
    // when the Stripe price is unresolvable; the controller must surface that status.
    test('returns 409 when service throws 409 (unresolvable plan — sync aborted)', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/sync/:orgId');
      const res = makeRes();
      mockAdminService.syncOrgFromStripe.mockRejectedValue(
        Object.assign(new Error('cannot resolve plan for Stripe subscription'), { status: 409 }),
      );

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(409);
    });

    test('returns 500 on unexpected error', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/sync/:orgId');
      const res = makeRes();
      mockAdminService.syncOrgFromStripe.mockRejectedValue(new Error('unexpected'));

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── POST /api/admin/billing/webhook/replay ────────────────────────────────────

  describe('POST /api/admin/billing/webhook/replay', () => {
    test('admin replays event and gets 200', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/webhook/replay');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, body: { eventId } },
        res,
      );

      expect(mockAdminService.replayWebhookEvent).toHaveBeenCalledWith(eventId);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('missing eventId returns 422 from schema validation', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/webhook/replay');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(422);
      expect(mockAdminService.replayWebhookEvent).not.toHaveBeenCalled();
    });

    test('non-admin gets 403', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/webhook/replay');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'user' }, body: { eventId } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('returns 502 when service throws 502', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/webhook/replay');
      const res = makeRes();
      mockAdminService.replayWebhookEvent.mockRejectedValue(
        Object.assign(new Error('Stripe unreachable'), { status: 502 }),
      );

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, body: { eventId } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(502);
    });

    test('returns 500 on unexpected error', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/webhook/replay');
      const res = makeRes();
      mockAdminService.replayWebhookEvent.mockRejectedValue(new Error('unexpected'));

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, body: { eventId } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── GET /api/admin/billing/dead-letters ──────────────────────────────────────

  describe('GET /api/admin/billing/dead-letters', () => {
    test('admin gets paginated dead-letters list', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dead-letters');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.get],
        { headers: { 'x-role': 'admin' }, query: { page: '1', limit: '10' } },
        res,
      );

      expect(mockAdminService.listDeadLetters).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('non-admin gets 403', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dead-letters');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.get],
        { headers: { 'x-role': 'user' }, query: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('returns 500 on unexpected error', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dead-letters');
      const res = makeRes();
      mockAdminService.listDeadLetters.mockRejectedValue(new Error('db down'));

      await runHandlers(
        [...route.all, ...route.get],
        { headers: { 'x-role': 'admin' }, query: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── DELETE /api/admin/billing/dead-letters/:eventId ──────────────────────────

  describe('DELETE /api/admin/billing/dead-letters/:eventId', () => {
    test('admin deletes dead-letter event and gets 200', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dead-letters/:eventId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.delete],
        { headers: { 'x-role': 'admin' }, params: { eventId: 'evt_dead_001' } },
        res,
      );

      expect(mockAdminService.purgeDeadLetter).toHaveBeenCalledWith('evt_dead_001');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('non-admin gets 403', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dead-letters/:eventId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.delete],
        { headers: { 'x-role': 'user' }, params: { eventId: 'evt_dead_001' } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('returns 404 when event not found', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dead-letters/:eventId');
      const res = makeRes();
      mockAdminService.purgeDeadLetter.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));

      await runHandlers(
        [...route.all, ...route.delete],
        { headers: { 'x-role': 'admin' }, params: { eventId: 'evt_gone' } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // ── POST /api/admin/billing/cancel/:orgId ────────────────────────────────────

  describe('POST /api/admin/billing/cancel/:orgId', () => {
    test('admin cancels subscription and gets 200', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/cancel/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(mockAdminService.cancelSubscription).toHaveBeenCalledWith(orgId);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('non-admin gets 403', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/cancel/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'user' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('returns 404 when no subscription found', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/cancel/:orgId');
      const res = makeRes();
      mockAdminService.cancelSubscription.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 502 when Stripe verify returns unexpected status (Decision #5)', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/cancel/:orgId');
      const res = makeRes();
      mockAdminService.cancelSubscription.mockRejectedValue(
        Object.assign(new Error('unexpected Stripe status'), { status: 502 }),
      );

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: {} },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(502);
    });
  });

  // ── POST /api/admin/billing/dispute/credit/:orgId ─────────────────────────────

  describe('POST /api/admin/billing/dispute/credit/:orgId', () => {
    const validBody = {
      chargeId: 'ch_test_dispute_001',
      amountCents: 2500,
      reason: 'Stripe ruled in our favor — restore extras balance',
      refundRequestId: 'req-dispute-credit-12345',
    };

    test('admin gets 200 on successful credit', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dispute/credit/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: validBody },
        res,
      );

      expect(mockAdminService.creditDisputeReinstated).toHaveBeenCalledWith(
        validBody.chargeId,
        validBody.amountCents,
        validBody.reason,
        validBody.refundRequestId,
        orgId,
        '507f1f77bcf86cd799439022',
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('non-admin gets 403', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dispute/credit/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'user' }, params: { orgId }, body: validBody },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('invalid body returns 422 from schema validation', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dispute/credit/:orgId');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: { chargeId: '', amountCents: -1 } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(422);
      expect(mockAdminService.creditDisputeReinstated).not.toHaveBeenCalled();
    });

    test('returns 404 when charge not found', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dispute/credit/:orgId');
      const res = makeRes();
      mockAdminService.creditDisputeReinstated.mockRejectedValue(
        Object.assign(new Error('charge not found'), { status: 404 }),
      );

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: validBody },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 on unexpected error', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dispute/credit/:orgId');
      const res = makeRes();
      mockAdminService.creditDisputeReinstated.mockRejectedValue(new Error('boom'));

      await runHandlers(
        [...route.all, ...route.post],
        { headers: { 'x-role': 'admin' }, params: { orgId }, body: validBody },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── GET /api/admin/billing/dead-letters — invalid query (line 219) ────────────

  describe('GET /api/admin/billing/dead-letters — invalid query', () => {
    test('returns 422 when query params fail Zod validation', async () => {
      const routes = await buildRoutes();
      const route = routes.get('/api/admin/billing/dead-letters');
      const res = makeRes();

      await runHandlers(
        [...route.all, ...route.get],
        { headers: { 'x-role': 'admin' }, query: { page: 'not-a-number', limit: 'also-bad' } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(422);
      expect(mockAdminService.listDeadLetters).not.toHaveBeenCalled();
    });
  });
});
