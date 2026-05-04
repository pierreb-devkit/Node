/**
 * Module dependencies.
 */
import { jest, describe, afterEach, test, expect } from '@jest/globals';

/**
 * Integration tests for attachUsageContext route wiring.
 */
describe('Billing usage header integration tests:', () => {
  let billingRoutes;
  let mockBillingService;
  let mockBillingUsageService;
  let mockBillingExtraService;
  let mockBillingExtraBalanceRepository;

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
   * @param {boolean} attachUsageHeader - Whether the header middleware should be mounted.
   * @returns {Promise<Map<string, Object>>} Collected route map.
   */
  const buildRoutes = async (attachUsageHeader) => {
    jest.resetModules();

    mockBillingService = {
      getLocalSubscription: jest.fn().mockResolvedValue({ plan: 'pro', status: 'active' }),
      getSubscription: jest.fn().mockResolvedValue({ plan: 'pro', status: 'active' }),
    };
    mockBillingUsageService = {
      getMeter: jest.fn().mockResolvedValue({
        meterUsed: 1200,
        meterQuota: 5000,
        meterBreakdown: {},
        weekKey: '2026-W18',
        resetAt: new Date('2026-05-04T00:00:00.000Z'),
        planVersion: 'v2',
      }),
      get: jest.fn(),
      currentWeekKey: jest.fn().mockReturnValue('2026-W18'),
    };
    mockBillingExtraService = {
      listLedger: jest.fn(),
      getOrgBalanceContext: jest.fn().mockResolvedValue(700),
    };
    mockBillingExtraBalanceRepository = {
      getBalance: jest.fn().mockResolvedValue(700),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        billing: {
          plans: ['free', 'starter', 'pro'],
          statuses: ['active', 'canceled'],
          meterMode: true,
          attachUsageHeader,
          packs: [],
          quotas: {},
        },
      },
    }));

    jest.unstable_mockModule('passport', () => ({
      default: {
        authenticate: jest.fn(() => (req, _res, next) => {
          req.user = {
            _id: '507f1f77bcf86cd799439022',
            currentOrganization: '507f1f77bcf86cd799439011',
            roles: ['user'],
          };
          next();
        }),
      },
    }));

    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: {
        isAllowed: jest.fn((_req, _res, next) => next()),
      },
    }));

    jest.unstable_mockModule('../../organizations/middlewares/organizations.middleware.js', () => ({
      default: {
        resolveOrganization: jest.fn((req, _res, next) => {
          req.organization = { _id: '507f1f77bcf86cd799439011' };
          req.membership = { role: 'owner', organizationId: '507f1f77bcf86cd799439011' };
          next();
        }),
      },
    }));

    jest.unstable_mockModule('../services/billing.service.js', () => ({
      default: mockBillingService,
    }));

    jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
      default: mockBillingUsageService,
    }));

    jest.unstable_mockModule('../services/billing.extra.service.js', () => ({
      default: mockBillingExtraService,
    }));

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: mockBillingExtraBalanceRepository,
    }));

    jest.unstable_mockModule('../lib/constants.js', () => ({
      activeStatuses: ['active', 'trialing'],
    }));

    billingRoutes = (await import('../routes/billing.routes.js')).default;

    const { app, routes } = createRouteRegistry();
    billingRoutes(app);
    return routes;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('GET /api/billing/usage sets X-Meter-Remaining when attachUsageHeader=true', async () => {
    const routes = await buildRoutes(true);
    const usageRoute = routes.get('/api/billing/usage');
    const req = { method: 'GET', params: {}, query: {} };
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers([...usageRoute.all, ...usageRoute.get], req, res);

    expect(res.setHeader).toHaveBeenCalledWith('X-Meter-Remaining', '4500');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('GET /api/billing/usage does not set X-Meter-Remaining when attachUsageHeader=false', async () => {
    const routes = await buildRoutes(false);
    const usageRoute = routes.get('/api/billing/usage');
    const req = { method: 'GET', params: {}, query: {} };
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await runHandlers([...usageRoute.all, ...usageRoute.get], req, res);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
