// Fixture: shared jest.unstable_mockModule() registration for auth.controller
// oauthCall()/oauthCallback() unit tests (issue #3900, CodeRabbit nit on #3947).
//
// Both `oauthCall` and `oauthCallback` describe blocks in
// auth.oauthCall.controller.unit.tests.js need the identical set of mocks
// registered — and registered BEFORE each test's dynamic
// `await import('.../auth.controller.js')` — so this helper must be invoked
// from each block's own `beforeEach`, never from a one-time top-level setup.
import { jest } from '@jest/globals';

/**
 * Reset the module registry and register every mock auth.controller's
 * dependency graph needs, mirroring what each test's dynamic import expects.
 * Call this from `beforeEach` (not `beforeAll`) so the mocks are registered
 * before that test's `await import('.../auth.controller.js')`.
 * @param {Object} [opts]
 * @param {boolean} [opts.realPassport=false] - When true, skip mocking `passport` entirely
 *   so the caller's own `await import('passport')` resolves the REAL package (issue #3954:
 *   a regression test registers an actual strategy via `passport.use()` and asserts
 *   `isEnabledOAuthProvider` sees it through the real `_strategy` API, so a passport
 *   upgrade renaming that private API fails here instead of silently 404-ing OAuth
 *   logins in prod — every other test in this suite mocks `_strategy` away and can't
 *   catch that).
 * @returns {{authenticate: import('@jest/globals').Mock, _strategy: import('@jest/globals').Mock}|undefined} mockPassport - the passport mock, so callers can further customize per-test behavior (e.g. `mockPassport._strategy.mockReturnValue(...)`). `undefined` when `realPassport` is true.
 */
export function setupAuthControllerMocks({ realPassport = false } = {}) {
  jest.resetModules();

  let mockPassport;
  if (!realPassport) {
    mockPassport = {
      authenticate: jest.fn().mockReturnValue(jest.fn()),
      _strategy: jest.fn().mockReturnValue(undefined),
    };
    jest.unstable_mockModule('passport', () => ({
      default: mockPassport,
    }));
  }

  jest.unstable_mockModule('../../../../lib/services/logger.js', () => ({
    default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  }));
  jest.unstable_mockModule('../../../../config/index.js', () => ({
    default: {
      sign: { up: true, in: true },
      jwt: { secret: 's', expiresIn: 3600 },
      cookie: { secure: true, sameSite: 'lax' },
      organizations: { enabled: false },
      app: { title: 'Test', contact: 'a@b.com' },
    },
  }));
  jest.unstable_mockModule('../../../../modules/users/services/users.service.js', () => ({
    default: { create: jest.fn(), getBrut: jest.fn(), update: jest.fn(), remove: jest.fn(), search: jest.fn(), count: jest.fn().mockResolvedValue(0) },
  }));
  // auth.controller imports the generic eligibility registry (not invitation code).
  jest.unstable_mockModule('../../../../modules/auth/services/auth.eligibility.js', () => ({
    default: {
      registerSignupEligibility: jest.fn(),
      assertSignupEligible: jest.fn().mockResolvedValue(undefined),
      _reset: jest.fn(),
    },
  }));
  jest.unstable_mockModule('../../../../modules/users/repositories/users.repository.js', () => ({
    default: { update: jest.fn() },
  }));
  jest.unstable_mockModule('../../../../modules/organizations/services/organizations.service.js', () => ({
    default: { handleSignupOrganization: jest.fn() },
  }));
  jest.unstable_mockModule('../../../../modules/organizations/services/organizations.crud.service.js', () => ({
    default: { autoSetCurrentOrganization: jest.fn() },
  }));
  jest.unstable_mockModule('../../../../modules/organizations/services/organizations.membership.service.js', () => ({
    default: { findByUserAndOrganization: jest.fn(), listPendingByUser: jest.fn().mockResolvedValue([]) },
  }));
  jest.unstable_mockModule('../../../../modules/users/models/users.schema.js', () => ({
    default: { User: {} },
  }));
  jest.unstable_mockModule('../../../../lib/middlewares/model.js', () => ({
    default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
  }));
  jest.unstable_mockModule('../../../../lib/middlewares/policy.js', () => ({
    default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
  }));
  jest.unstable_mockModule('../../../../lib/helpers/mailer/index.js', () => ({
    default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
  }));
  jest.unstable_mockModule('../../../../lib/helpers/responses.js', () => ({
    default: {
      success: jest.fn().mockReturnValue(jest.fn()),
      error: jest.fn().mockReturnValue(jest.fn()),
    },
  }));
  jest.unstable_mockModule('../../../../lib/helpers/errors.js', () => ({
    default: { getMessage: jest.fn().mockReturnValue('error') },
  }));
  jest.unstable_mockModule('../../../../lib/helpers/AppError.js', () => ({
    default: class AppError extends Error {
      constructor(msg, opts) {
        super(msg);
        this.status = opts?.status;
        this.code = opts?.code;
        this.details = opts?.details;
      }
    },
  }));
  jest.unstable_mockModule('../../../../lib/helpers/abilities.js', () => ({
    default: jest.fn().mockReturnValue([]),
  }));
  jest.unstable_mockModule('../../../../lib/helpers/getBaseUrl.js', () => ({
    default: jest.fn().mockReturnValue('http://localhost:3000'),
  }));
  jest.unstable_mockModule('../../../../lib/services/analytics.js', () => ({
    default: { identify: jest.fn(), groupIdentify: jest.fn() },
  }));

  return mockPassport;
}
