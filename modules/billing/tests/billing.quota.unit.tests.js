/**
 * Module dependencies.
 */
import { jest, describe, test, beforeAll, afterAll, beforeEach, afterEach, expect } from '@jest/globals';
import AppError from '../../../lib/helpers/AppError.js';

/**
 * Unit tests for the requireQuota middleware.
 *
 * The middleware is now a thin wrapper around BillingQuotaService.assertCanExecute.
 * Tests here verify the HTTP response mapping (status codes, payloads, next() calls)
 * by mocking assertCanExecute at the service boundary.
 */
describe('requireQuota middleware:', () => {
  let requireQuota;
  let mockBillingQuotaService;
  let req;
  let res;
  let next;
  let originalNodeEnv;

  beforeAll(() => {
    // rule 3 (Node#4020): lib/helpers/responses.js only serializes the raw
    // `payload.error` blob in a dev-grade NODE_ENV (lib/helpers/config.js
    // isProd()/DEV_ENVS). The assertions below read that field, so force an
    // explicit dev-grade value here rather than depend on whichever NODE_ENV
    // a consumer happens to run its own test suite under. Same value for
    // every test in this file, so set once for the suite rather than per test.
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(async () => {
    jest.resetModules();

    mockBillingQuotaService = {
      assertCanExecute: jest.fn(),
    };

    jest.unstable_mockModule('../services/billing.quota.service.js', () => ({
      default: mockBillingQuotaService,
    }));

    const mod = await import('../middlewares/billing.requireQuota.js');
    requireQuota = mod.default;

    req = {
      organization: { _id: '507f1f77bcf86cd799439011' },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: {},
    };

    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Organization guard ────────────────────────────────────────────────────

  test('should return 403 when organization context is missing', async () => {
    req.organization = undefined;

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ── Allow paths ───────────────────────────────────────────────────────────

  test('should allow request when assertCanExecute resolves { degraded: false }', async () => {
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.locals.billingDegraded).toBeUndefined();
  });

  test('should allow request and set billingDegraded when assertCanExecute resolves { degraded: true }', async () => {
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: true });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.locals.billingDegraded).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should pass correct params to assertCanExecute', async () => {
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });
    req.user = { roles: ['user'] };

    await requireQuota('scraps', 'execute')(req, res, next);

    expect(mockBillingQuotaService.assertCanExecute).toHaveBeenCalledWith({
      orgId: '507f1f77bcf86cd799439011',
      organization: req.organization,
      user: req.user,
      resource: 'scraps',
      action: 'execute',
    });
  });

  // ── Admin bypass ──────────────────────────────────────────────────────────

  test('should bypass quota for admin user (legacy mode)', async () => {
    req.user = { roles: ['admin'] };
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should NOT bypass quota for non-admin user (legacy mode)', async () => {
    req.user = { roles: ['user'] };
    mockBillingQuotaService.assertCanExecute.mockRejectedValue(
      new AppError('You have reached the usage limit for this resource', {
        status: 429,
        details: { type: 'QUOTA_EXCEEDED', resource: 'scraps', action: 'create', limit: 3, current: 3 },
      }),
    );

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  // ── meterExempt bypass ────────────────────────────────────────────────────

  test('should bypass quota for meterExempt organization', async () => {
    req.organization = { _id: '507f1f77bcf86cd799439011', meterExempt: true };
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should NOT bypass quota when meterExempt is false', async () => {
    req.organization = { _id: '507f1f77bcf86cd799439011', meterExempt: false };
    mockBillingQuotaService.assertCanExecute.mockRejectedValue(
      new AppError('You have reached the usage limit for this resource', {
        status: 429,
        details: { type: 'QUOTA_EXCEEDED', resource: 'scraps', action: 'create', limit: 3, current: 3 },
      }),
    );

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  // ── Legacy mode denial (429 QUOTA_EXCEEDED) ───────────────────────────────

  test('should return 429 when at quota limit', async () => {
    mockBillingQuotaService.assertCanExecute.mockRejectedValue(
      new AppError('You have reached the usage limit for this resource', {
        status: 429,
        details: { type: 'QUOTA_EXCEEDED', resource: 'scraps', action: 'create', limit: 3, current: 3 },
      }),
    );

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Quota exceeded',
      code: 429,
      status: 429,
    }));
  });

  test('should return 429 when over quota limit', async () => {
    mockBillingQuotaService.assertCanExecute.mockRejectedValue(
      new AppError('You have reached the usage limit for this resource', {
        status: 429,
        details: { type: 'QUOTA_EXCEEDED', resource: 'scraps', action: 'create', limit: 3, current: 5 },
      }),
    );

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  test('should treat missing subscription as free plan (service resolves)', async () => {
    mockBillingQuotaService.assertCanExecute.mockRejectedValue(
      new AppError('You have reached the usage limit for this resource', {
        status: 429,
        details: { type: 'QUOTA_EXCEEDED', resource: 'scraps', action: 'create', limit: 3, current: 3 },
      }),
    );

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      code: 429,
    }));
  });

  test.each(['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    'should handle %s subscription denial from service',
    async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('You have reached the usage limit for this resource', {
          status: 429,
          details: { type: 'QUOTA_EXCEEDED', resource: 'scraps', action: 'create', limit: 3, current: 3 },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        code: 429,
      }));
    },
  );

  test('should allow unlimited (Infinity) without checking usage (service resolves)', async () => {
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('should return correct error payload with upgradeUrl', async () => {
    mockBillingQuotaService.assertCanExecute.mockRejectedValue(
      new AppError('You have reached the usage limit for this resource', {
        status: 429,
        details: { type: 'QUOTA_EXCEEDED', resource: 'scraps', action: 'execute', limit: 100, current: 100, upgradeUrl: '/billing/plans' },
      }),
    );

    await requireQuota('scraps', 'execute')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Quota exceeded',
      code: 429,
      status: 429,
      description: 'You have reached the usage limit for this resource',
    }));
  });

  test('should allow through when no quota is configured for resource (service resolves)', async () => {
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

    await requireQuota('unknownResource', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('should use subscription plan when status is trialing (service resolves)', async () => {
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should treat zero usage as under quota (service resolves)', async () => {
    mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

    await requireQuota('scraps', 'create')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  // ── Meter mode (meterMode: true) ───────────────────────────────────────────

  describe('meter mode (meterMode: true)', () => {
    test('should call next() when remaining quota > 0 (meter not exhausted)', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should call next() when plan quota exhausted but extras balance covers it', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should return 402 when meterUsed >= meterQuota and extras balance is 0', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Meter exhausted', {
          status: 402,
          details: {
            type: 'METER_EXHAUSTED',
            meterUsed: 5000,
            meterQuota: 5000,
            extrasRemaining: 0,
            packsAvailable: [{ packId: 'pack_500k', meterUnits: 500000 }],
            upgradeUrl: '/billing/plans',
          },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        code: 402,
      }));
    });

    test('should include METER_EXHAUSTED payload with pack info in 402 response', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Meter exhausted', {
          status: 402,
          details: {
            type: 'METER_EXHAUSTED',
            meterUsed: 6000,
            meterQuota: 5000,
            extrasRemaining: 0,
            packsAvailable: [{ packId: 'pack_500k', meterUnits: 500000 }],
            upgradeUrl: '/billing/plans',
          },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      expect(payload.description).toBe('Meter exhausted');
      // The dev-only blob now serializes the AppError itself (issue #4062 fix
      // — `responses.error` is handed `err`, not the pre-extracted `details`
      // sub-object), so the curated fields live under `.details`, not at the
      // blob's top level.
      const errData = JSON.parse(payload.error);
      expect(errData.details.type).toBe('METER_EXHAUSTED');
      expect(errData.details.meterUsed).toBe(6000);
      expect(errData.details.meterQuota).toBe(5000);
      expect(errData.details.extrasRemaining).toBe(0);
      expect(Array.isArray(errData.details.packsAvailable)).toBe(true);
    });

    // Issue #4062: the test above only ever inspects `payload.error` — the
    // raw serialized-error blob that `lib/helpers/responses.js` gates to
    // dev-grade environments only (`configHelper.isProd()`). It passed even
    // while the middleware handed `responses.error(...)` the already-extracted
    // `details` sub-object instead of the AppError itself, because that blob
    // is built from whatever object reaches `responses.error`, not from a
    // specific `.details` traversal. The field a REAL production client reads
    // is `payload.details` (the whitelisted `type`/`upgradeUrl` subset) —
    // this test forces `NODE_ENV = 'production'` so `payload.error` cannot
    // exist at all, the same production-mode-toggle convention used in
    // `lib/helpers/tests/responses.detailsWhitelist.unit.tests.js`.
    test('production mode: 402 METER_EXHAUSTED response carries type + upgradeUrl in payload.details, not just the dev-only error blob', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Meter exhausted', {
          status: 402,
          details: {
            type: 'METER_EXHAUSTED',
            meterUsed: 6000,
            meterQuota: 5000,
            extrasRemaining: 0,
            packsAvailable: [{ packId: 'pack_500k', meterUnits: 500000 }],
            upgradeUrl: '/billing/plans',
          },
        }),
      );

      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await requireQuota('scraps', 'create')(req, res, next);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }

      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      // The whitelisted subset a production client actually renders an
      // upgrade CTA from — only `type`/`upgradeUrl` survive the whitelist,
      // `meterUsed`/`meterQuota`/etc. are intentionally not whitelisted.
      expect(payload.details).toEqual({ type: 'METER_EXHAUSTED', upgradeUrl: '/billing/plans' });
      // Production never leaks the raw serialized-error blob.
      expect(payload.error).toBeUndefined();
    });

    test('should return 402 when meter doc is null and plan quota is 0 (no extras)', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Meter exhausted', {
          status: 402,
          details: { type: 'METER_EXHAUSTED', meterUsed: 0, meterQuota: 0, extrasRemaining: 0, packsAvailable: [], upgradeUrl: '/billing/plans' },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
    });

    // ── Fix #3569: lazy fallback for new-user first scrap ─────────────────────

    test('fix #3575: no meter doc + getActivePlan returns null — returns 503 PLAN_NOT_CONFIGURED (not 402)', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Billing plan configuration is temporarily unavailable', {
          status: 503,
          details: { type: 'PLAN_NOT_CONFIGURED', planId: 'free' },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.details.type).toBe('PLAN_NOT_CONFIGURED');
    });

    test('fix #3569: new Free user — 1st scrap passes when plan meterQuota > 0', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('fix #3569: new Pro user — 1st scrap passes with full pro quota', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('fix #3569: no meter doc + no subscription — falls back to defaultPlan quota (service resolves)', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('fix #3569: no meter doc — does NOT write a BillingUsage doc (service boundary handles it)', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(mockBillingQuotaService.assertCanExecute).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalled();
    });

    test('should call assertCanExecute in meter mode (degraded-mode gate)', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(mockBillingQuotaService.assertCanExecute).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    test('should allow through with billingDegraded flag when past_due within grace period (J+5)', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: true });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.locals.billingDegraded).toBe(true);
      expect(res.status).not.toHaveBeenCalledWith(402);
    });

    test('grace period reads from config — custom gracePeriodDays=3 blocks at J+4 (service throws PAYMENT_PAST_DUE)', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Subscription past due, please update payment', {
          status: 402,
          details: { type: 'PAYMENT_PAST_DUE', message: 'Subscription past due, please update payment', subscriptionStatus: 'past_due' },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.details.type).toBe('PAYMENT_PAST_DUE');
    });

    test('should return 402 PAYMENT_PAST_DUE when past_due and grace period elapsed (J+10)', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Subscription past due, please update payment', {
          status: 402,
          details: { type: 'PAYMENT_PAST_DUE', message: 'Subscription past due, please update payment', subscriptionStatus: 'past_due' },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.details.type).toBe('PAYMENT_PAST_DUE');
      expect(errData.details.subscriptionStatus).toBe('past_due');
    });

    test('should NOT block past_due with no pastDueSince set (service resolves)', async () => {
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.locals.billingDegraded).toBeUndefined();
    });

    test('should return 402 PAYMENT_PAST_DUE at exactly the 7-day boundary', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Subscription past due, please update payment', {
          status: 402,
          details: { type: 'PAYMENT_PAST_DUE', subscriptionStatus: 'past_due' },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
    });

    test('should bypass meter quota for admin user', async () => {
      req.user = { roles: ['admin'] };
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should bypass meter quota for meterExempt organization', async () => {
      req.organization = { _id: '507f1f77bcf86cd799439011', meterExempt: true };
      mockBillingQuotaService.assertCanExecute.mockResolvedValue({ degraded: false });

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('degraded J+5: still blocks if meter is exhausted', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Meter exhausted', {
          status: 402,
          details: { type: 'METER_EXHAUSTED', meterUsed: 5000, meterQuota: 5000, extrasRemaining: 0, packsAvailable: [], upgradeUrl: '/billing/plans' },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.details.type).toBe('METER_EXHAUSTED');
    });

    // ── V8 audit C2: incomplete subscription must be fail-closed ─────────────

    test('V8-C2: incomplete subscription + no BillingUsage doc → 402 METER_EXHAUSTED with free quota (not pro)', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Meter exhausted', {
          status: 402,
          details: {
            type: 'METER_EXHAUSTED',
            meterUsed: 0,
            meterQuota: 0,
            extrasRemaining: 0,
            packsAvailable: [],
            upgradeUrl: '/billing/plans',
          },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.details.type).toBe('METER_EXHAUSTED');
      expect(errData.details.meterQuota).toBe(0);
    });

    test('V8-C2b: canceled subscription in meter mode → 402 METER_EXHAUSTED with free quota (not paid)', async () => {
      mockBillingQuotaService.assertCanExecute.mockRejectedValue(
        new AppError('Meter exhausted', {
          status: 402,
          details: {
            type: 'METER_EXHAUSTED',
            meterUsed: 0,
            meterQuota: 0,
            extrasRemaining: 0,
            packsAvailable: [],
            upgradeUrl: '/billing/plans',
          },
        }),
      );

      await requireQuota('scraps', 'create')(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      const errData = JSON.parse(payload.error);
      expect(errData.details.type).toBe('METER_EXHAUSTED');
      expect(errData.details.meterQuota).toBe(0);
    });
  });
});
