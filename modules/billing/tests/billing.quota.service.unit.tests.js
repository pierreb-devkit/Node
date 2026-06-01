/**
 * Unit tests for billing.quota.service.assertCanExecute
 *
 * The service is the single enforcement source used by:
 *   - billing.requireQuota middleware (HTTP path)
 *   - Any other caller sharing the quota enforcement path (e.g. background workers)
 *
 * Coverage mirrors billing.quota.unit.tests.js for the middleware but
 * exercises the service layer directly. Key scenarios:
 *   - Admin bypass → resolves { degraded: false }
 *   - meterExempt org bypass → resolves { degraded: false }
 *   - Meter mode: exhausted → throws AppError status 402 METER_EXHAUSTED
 *   - Meter mode: past_due grace elapsed → throws AppError status 402 PAYMENT_PAST_DUE
 *   - Meter mode: past_due within grace → resolves { degraded: true }
 *   - Meter mode: fail-closed statuses (paused/canceled/etc.) → 402 METER_EXHAUSTED
 *   - Meter mode: no usage doc + plan fallback (allow / deny / 503 PLAN_NOT_CONFIGURED)
 *   - Legacy mode: under quota → allow; at/over limit → throws 429 QUOTA_EXCEEDED
 *   - Legacy mode: Infinity → allow; no quota configured → allow
 */
import { describe, test, expect, jest } from '@jest/globals';

/* ── shared mocks ── */
let mockSubscriptionRepository;
let mockBillingUsageService;
let mockBillingExtraBalanceRepository;
let mockBillingPlanService;
let mockConfig;

const setupMocks = async (configOverrides = {}) => {
  jest.resetModules();

  mockSubscriptionRepository = { findByOrganization: jest.fn() };
  mockBillingUsageService = { get: jest.fn(), getMeter: jest.fn() };
  mockBillingExtraBalanceRepository = { getBalance: jest.fn() };
  mockBillingPlanService = { getActivePlan: jest.fn() };

  mockConfig = {
    billing: {
      meterMode: false,
      quotas: {
        free: { scraps: { execute: 100, create: 3 } },
        starter: { scraps: { execute: 2000, create: 20 } },
        pro: { scraps: { execute: Infinity, create: Infinity } },
      },
      packs: [],
      upgradeUrl: '/billing/plans',
      defaultPlan: 'free',
      ...configOverrides,
    },
  };

  jest.unstable_mockModule('../repositories/billing.subscription.repository.js', () => ({
    default: mockSubscriptionRepository,
  }));
  jest.unstable_mockModule('../services/billing.usage.service.js', () => ({
    default: mockBillingUsageService,
  }));
  jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
    default: mockBillingExtraBalanceRepository,
  }));
  jest.unstable_mockModule('../services/billing.plan.service.js', () => ({
    default: mockBillingPlanService,
  }));
  jest.unstable_mockModule('../../../config/index.js', () => ({
    default: mockConfig,
  }));

  const mod = await import('../services/billing.quota.service.js');
  return mod.assertCanExecute;
};

const ORG_ID = '507f1f77bcf86cd799439011';
const BASE_ORG = { _id: ORG_ID };

/* =====================================================================
 * Admin & meterExempt bypasses
 * ===================================================================== */

describe('assertCanExecute — bypasses', () => {
  test('resolves { degraded: false } for admin user (no DB calls)', async () => {
    const assertCanExecute = await setupMocks();
    const result = await assertCanExecute({
      orgId: ORG_ID,
      organization: BASE_ORG,
      user: { roles: ['admin'] },
      resource: 'scraps',
      action: 'execute',
    });
    expect(result).toEqual({ degraded: false });
    expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
    expect(mockBillingUsageService.getMeter).not.toHaveBeenCalled();
    expect(mockBillingUsageService.get).not.toHaveBeenCalled();
  });

  test('resolves { degraded: false } for meterExempt org (no DB calls)', async () => {
    const assertCanExecute = await setupMocks();
    const result = await assertCanExecute({
      orgId: ORG_ID,
      organization: { ...BASE_ORG, meterExempt: true },
      user: { roles: ['user'] },
      resource: 'scraps',
      action: 'execute',
    });
    expect(result).toEqual({ degraded: false });
    expect(mockSubscriptionRepository.findByOrganization).not.toHaveBeenCalled();
  });

  test('does NOT bypass for meterExempt: false', async () => {
    const assertCanExecute = await setupMocks();
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { scraps_execute: 50 } });

    const result = await assertCanExecute({
      orgId: ORG_ID,
      organization: { ...BASE_ORG, meterExempt: false },
      user: { roles: ['user'] },
      resource: 'scraps',
      action: 'execute',
    });
    expect(result).toEqual({ degraded: false });
    expect(mockBillingUsageService.get).toHaveBeenCalled();
  });
});

/* =====================================================================
 * Meter mode
 * ===================================================================== */

describe('assertCanExecute — meter mode (meterMode: true)', () => {
  const meterConfig = {
    meterMode: true,
    quotas: {},
    packs: [{ packId: 'pack_500k', meterUnits: 500000 }],
    upgradeUrl: '/billing/plans',
    defaultPlan: 'free',
  };

  test('resolves when remaining quota > 0', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ status: 'active', pastDueSince: null });
    mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 1000, meterQuota: 5000 });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    const result = await assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    });
    expect(result).toEqual({ degraded: false });
  });

  test('resolves when quota exhausted but extras cover it', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ status: 'active', pastDueSince: null });
    mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 5000, meterQuota: 5000 });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(500000);

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).resolves.toEqual({ degraded: false });
  });

  test('throws AppError status 402 METER_EXHAUSTED when meter is exhausted', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ status: 'active', pastDueSince: null });
    mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 5000, meterQuota: 5000 });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).rejects.toMatchObject({ status: 402, message: 'Meter exhausted' });
  });

  test('thrown error includes METER_EXHAUSTED details', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ status: 'active', pastDueSince: null });
    mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 6000, meterQuota: 5000 });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    let caught;
    try {
      await assertCanExecute({
        orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
        resource: 'scraps', action: 'execute',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(402);
    // AppError.details is the array-or-object passed to the constructor
    const details = Array.isArray(caught.details) ? caught.details[0] : caught.details;
    expect(details.type).toBe('METER_EXHAUSTED');
    expect(details.meterUsed).toBe(6000);
    expect(details.meterQuota).toBe(5000);
    expect(details.extrasRemaining).toBe(0);
  });

  test('throws 402 PAYMENT_PAST_DUE when past_due grace elapsed', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ status: 'past_due', pastDueSince: tenDaysAgo });
    mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).rejects.toMatchObject({ status: 402 });
  });

  test('resolves { degraded: true } when past_due within grace period', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ status: 'past_due', pastDueSince: fiveDaysAgo });
    mockBillingUsageService.getMeter.mockResolvedValue({ meterUsed: 100, meterQuota: 5000 });
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    const result = await assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    });
    expect(result).toEqual({ degraded: true });
  });

  test.each(['paused', 'unpaid', 'incomplete_expired', 'incomplete', 'canceled'])(
    'fail-closed: %s subscription with free quota=0 → 402 METER_EXHAUSTED',
    async (status) => {
      const assertCanExecute = await setupMocks(meterConfig);
      mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status });
      mockBillingPlanService.getActivePlan.mockReturnValue({ meterQuota: 0, version: 'v1' });
      mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

      await expect(assertCanExecute({
        orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
        resource: 'scraps', action: 'execute',
      })).rejects.toMatchObject({ status: 402 });
    },
  );

  test('fail-closed: plan not configured → 503 PLAN_NOT_CONFIGURED', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'canceled' });
    mockBillingPlanService.getActivePlan.mockReturnValue(null);
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).rejects.toMatchObject({ status: 503 });
  });

  test('no BillingUsage doc + plan quota > 0 → allow (first run path)', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.getMeter.mockResolvedValue(null);
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
    mockBillingPlanService.getActivePlan.mockReturnValue({ meterQuota: 10, version: 'v1' });

    const result = await assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    });
    expect(result).toEqual({ degraded: false });
  });

  test('no BillingUsage doc + plan null → 503 PLAN_NOT_CONFIGURED', async () => {
    const assertCanExecute = await setupMocks(meterConfig);
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.getMeter.mockResolvedValue(null);
    mockBillingExtraBalanceRepository.getBalance.mockResolvedValue(0);
    mockBillingPlanService.getActivePlan.mockReturnValue(null);

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).rejects.toMatchObject({ status: 503 });
  });
});

/* =====================================================================
 * Legacy mode
 * ===================================================================== */

describe('assertCanExecute — legacy mode (meterMode: false)', () => {
  test('resolves when under quota', async () => {
    const assertCanExecute = await setupMocks();
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { scraps_execute: 50 } });

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).resolves.toEqual({ degraded: false });
  });

  test('throws 429 QUOTA_EXCEEDED when at limit', async () => {
    const assertCanExecute = await setupMocks();
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { scraps_execute: 100 } });

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).rejects.toMatchObject({ status: 429 });
  });

  test('Infinity quota → resolves without usage check', async () => {
    const assertCanExecute = await setupMocks();
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'pro', status: 'active' });

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).resolves.toEqual({ degraded: false });
    expect(mockBillingUsageService.get).not.toHaveBeenCalled();
  });

  test('no quota configured → resolves (allow through)', async () => {
    const assertCanExecute = await setupMocks();
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'free', status: 'active' });

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'unknownResource', action: 'execute',
    })).resolves.toEqual({ degraded: false });
  });

  test('missing subscription → treated as free plan', async () => {
    const assertCanExecute = await setupMocks();
    mockSubscriptionRepository.findByOrganization.mockResolvedValue(null);
    mockBillingUsageService.get.mockResolvedValue({ counters: { scraps_execute: 100 } });

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).rejects.toMatchObject({ status: 429 });
  });

  test('starter plan with higher quota → resolves when under starter limit', async () => {
    const assertCanExecute = await setupMocks();
    mockSubscriptionRepository.findByOrganization.mockResolvedValue({ plan: 'starter', status: 'active' });
    mockBillingUsageService.get.mockResolvedValue({ counters: { scraps_execute: 1500 } });

    await expect(assertCanExecute({
      orgId: ORG_ID, organization: BASE_ORG, user: { roles: ['user'] },
      resource: 'scraps', action: 'execute',
    })).resolves.toEqual({ degraded: false });
  });
});
