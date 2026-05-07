/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, expect } from '@jest/globals';

/**
 * Unit tests for billing CASL policy — subject registration + ability resolution.
 *
 * Covers the Item 3 fix from Batch 3a:
 *   Before the fix, parameterised admin routes (/:orgId, /:eventId) were registered
 *   without their Express patterns, so deriveSubjectType returned null for those routes.
 *   A future narrower role with `can('read', 'BillingAdminOps')` would 403 silently.
 *
 * After the fix, all admin billing paths resolve to their correct CASL subject type.
 */

// Mock logger before importing policy (logger touches config.log at load time)
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Mock CASL — tests only exercise deriveSubjectType (pure string lookup, no ability build needed)
jest.unstable_mockModule('@casl/ability', () => ({
  AbilityBuilder: jest.fn().mockImplementation(() => ({
    can: jest.fn(),
    cannot: jest.fn(),
    build: jest.fn().mockReturnValue({ can: jest.fn().mockReturnValue(true) }),
  })),
  Ability: jest.fn(),
  subject: jest.fn((type, doc) => doc),
}));

const { default: policy } = await import('../../../lib/middlewares/policy.js');
const { billingSubjectRegistration } = await import('../policies/billing.policy.js');

describe('billing.policy — CASL subject registration unit tests:', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset the shared module-level registries before each test to avoid cross-test
    // contamination (registries accumulate entries across calls; discoverPolicies([])
    // clears them without loading any policy file).
    await policy.discoverPolicies([]);
    // Re-register billing subjects so each test has exactly one set of entries.
    billingSubjectRegistration({ registerPathSubject: policy.registerPathSubject });
  });

  // ── User-facing billing routes ──────────────────────────────────────────────

  test.each([
    ['/api/billing/checkout', 'BillingCheckout'],
    ['/api/billing/portal', 'BillingPortal'],
    ['/api/billing/subscription', 'BillingSubscription'],
    ['/api/billing/usage', 'BillingUsage'],
    ['/api/billing/plans', 'BillingPlans'],
    ['/api/billing/extras/checkout', 'BillingExtrasCheckout'],
    ['/api/billing/extras/balance', 'BillingExtrasBalance'],
    ['/api/billing/extras/ledger', 'BillingExtrasLedger'],
  ])('resolves %s → %s', (routePath, expectedSubject) => {
    expect(policy.deriveSubjectType(routePath)).toBe(expectedSubject);
  });

  // ── Admin billing routes — non-parameterised ────────────────────────────────

  test.each([
    ['/api/admin/billing/refund', 'BillingAdminRefund'],
    ['/api/admin/billing/plans/bump', 'BillingAdminPlanBump'],
    ['/api/admin/billing/webhook/replay', 'BillingAdminOps'],
    ['/api/admin/billing/dead-letters', 'BillingAdminOps'],
  ])('resolves %s → %s', (routePath, expectedSubject) => {
    expect(policy.deriveSubjectType(routePath)).toBe(expectedSubject);
  });

  // ── Admin billing routes — parameterised (Item 3 fix) ──────────────────────
  // These were previously registered WITHOUT their Express patterns, so
  // deriveSubjectType returned null. Now they must resolve to 'BillingAdminOps'.

  test.each([
    ['/api/admin/billing/customer/:orgId', 'BillingAdminOps'],
    ['/api/admin/billing/sync/:orgId', 'BillingAdminOps'],
    ['/api/admin/billing/dead-letters/:eventId', 'BillingAdminOps'],
    ['/api/admin/billing/cancel/:orgId', 'BillingAdminOps'],
    ['/api/admin/billing/dispute/credit/:orgId', 'BillingAdminOps'],
  ])('parameterised route %s → %s (was null before fix)', (routePath, expectedSubject) => {
    expect(policy.deriveSubjectType(routePath)).toBe(expectedSubject);
  });

  // ── Unknown route returns null ──────────────────────────────────────────────

  test('unknown path returns null', () => {
    expect(policy.deriveSubjectType('/api/billing/unknown-route')).toBeNull();
  });
});
