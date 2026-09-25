/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for auth.controller oauthCallback() — handleSignupOrganization
 * wiring (issue #4115). Mirrors auth.verifyEmail.signup-org.unit.tests.js.
 *
 * Verifies that:
 *  1. oauthCallback calls handleSignupOrganization when the resolved user has
 *     no currentOrganization (new OAuth signup, or an account orphaned by
 *     this bug before the fix).
 *  2. oauthCallback does NOT call handleSignupOrganization when the resolved
 *     user already has a currentOrganization (normal login — no extra
 *     queries/events).
 *  3. oauthCallback does NOT call handleSignupOrganization on the err/!user
 *     failure paths.
 *  4. A provisioning rejection is best-effort: the TOKEN cookie is still set
 *     and the response still redirects to /token.
 */
describe('auth.controller oauthCallback — handleSignupOrganization wiring:', () => {
  let handleSignupOrganizationMock;
  let mockPassport;

  beforeEach(() => {
    jest.resetModules();

    handleSignupOrganizationMock = jest.fn().mockResolvedValue({ _id: 'org_001' });

    mockPassport = {
      authenticate: jest.fn(),
      _strategy: jest.fn().mockReturnValue({ name: 'google' }),
    };

    jest.unstable_mockModule('passport', () => ({
      default: mockPassport,
    }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        sign: { up: true, in: true },
        jwt: { secret: 's', expiresIn: 3600 },
        cookie: { secure: true, sameSite: 'lax' },
        organizations: { enabled: true },
        app: { title: 'Test', contact: 'a@b.com' },
      },
    }));
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: { create: jest.fn(), getBrut: jest.fn(), update: jest.fn(), remove: jest.fn(), search: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    }));
    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined),
        _reset: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../../../modules/auth/services/auth.signupCapacity.js', () => ({
      computeSignupCapacity: jest.fn().mockResolvedValue({ cap: null, remaining: null }),
    }));
    jest.unstable_mockModule('../../../modules/users/repositories/users.repository.js', () => ({
      default: { update: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
      default: { handleSignupOrganization: handleSignupOrganizationMock },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.crud.service.js', () => ({
      default: { autoSetCurrentOrganization: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.membership.service.js', () => ({
      default: { findByUserAndOrganization: jest.fn(), listPendingByUser: jest.fn().mockResolvedValue([]) },
    }));
    jest.unstable_mockModule('../../../modules/users/models/users.schema.js', () => ({
      default: { User: {} },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
      default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
    }));
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: jest.fn().mockReturnValue(jest.fn()),
        error: jest.fn().mockReturnValue(jest.fn()),
      },
    }));
    jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
      default: { getMessage: jest.fn().mockReturnValue('error') },
    }));
    jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
      default: class AppError extends Error {
        constructor(msg, opts) {
          super(msg);
          this.status = opts?.status;
          this.code = opts?.code;
          this.details = opts?.details;
        }
      },
    }));
    jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
      default: jest.fn().mockReturnValue([]),
    }));
    jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
      default: jest.fn().mockReturnValue('http://localhost:3000'),
    }));
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { identify: jest.fn(), capture: jest.fn(), groupIdentify: jest.fn() },
    }));
  });

  /**
   * Build a mock Express res that records cookie/redirect calls, mirroring
   * the pattern used in auth.integration.tests.js's oauthCallback suite.
   * @returns {{res: Object, cookies: Object, redirectCalls: Array}}
   */
  const buildRes = () => {
    const cookies = {};
    const redirectCalls = [];
    const res = {
      cookie(name, val, opts) { cookies[name] = { val, opts }; return this; },
      redirect(code, url) { redirectCalls.push({ code, url }); },
    };
    return { res, cookies, redirectCalls };
  };

  test('calls handleSignupOrganization when the resolved user has no currentOrganization', async () => {
    const user = { id: 'user_001', currentOrganization: null };
    mockPassport.authenticate.mockImplementation((strategy, callback) => () => callback(null, user));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { params: { strategy: 'google' }, body: {} };
    const { res, cookies, redirectCalls } = buildRes();

    await AuthController.oauthCallback(req, res, () => {});

    expect(handleSignupOrganizationMock).toHaveBeenCalledTimes(1);
    expect(handleSignupOrganizationMock).toHaveBeenCalledWith(user);
    expect(cookies.TOKEN).toBeDefined();
    expect(redirectCalls[0]).toMatchObject({ code: 302 });
    expect(redirectCalls[0].url).toMatch(/\/token$/);
  });

  test('does not call handleSignupOrganization when the resolved user already has a currentOrganization', async () => {
    const user = { id: 'user_002', currentOrganization: 'org_existing' };
    mockPassport.authenticate.mockImplementation((strategy, callback) => () => callback(null, user));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { params: { strategy: 'google' }, body: {} };
    const { res, cookies, redirectCalls } = buildRes();

    await AuthController.oauthCallback(req, res, () => {});

    expect(handleSignupOrganizationMock).not.toHaveBeenCalled();
    expect(cookies.TOKEN).toBeDefined();
    expect(redirectCalls[0]).toMatchObject({ code: 302 });
  });

  test('does not call handleSignupOrganization on the err path', async () => {
    mockPassport.authenticate.mockImplementation((strategy, callback) => () => callback(new Error('token exchange failed'), null));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { params: { strategy: 'google' }, body: {} };
    const { res, redirectCalls } = buildRes();

    await AuthController.oauthCallback(req, res, () => {});

    expect(handleSignupOrganizationMock).not.toHaveBeenCalled();
    expect(redirectCalls[0]).toMatchObject({ code: 302 });
  });

  test('does not call handleSignupOrganization on the !user path', async () => {
    mockPassport.authenticate.mockImplementation((strategy, callback) => () => callback(null, null));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { params: { strategy: 'google' }, body: {} };
    const { res, redirectCalls } = buildRes();

    await AuthController.oauthCallback(req, res, () => {});

    expect(handleSignupOrganizationMock).not.toHaveBeenCalled();
    expect(redirectCalls[0]).toMatchObject({ code: 302 });
  });

  test('a provisioning rejection is best-effort: cookie is still set and it still redirects to /token', async () => {
    handleSignupOrganizationMock.mockRejectedValue(new Error('org boom'));
    const user = { id: 'user_003', currentOrganization: null };
    mockPassport.authenticate.mockImplementation((strategy, callback) => () => callback(null, user));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { params: { strategy: 'google' }, body: {} };
    const { res, cookies, redirectCalls } = buildRes();

    // Must not throw / must not reject the caller's await.
    await AuthController.oauthCallback(req, res, () => {});

    expect(handleSignupOrganizationMock).toHaveBeenCalledWith(user);
    expect(cookies.TOKEN).toBeDefined();
    expect(redirectCalls[0]).toMatchObject({ code: 302 });
    expect(redirectCalls[0].url).toMatch(/\/token$/);
  });

  test('a throw past the org-provisioning branch (e.g. jwt.sign failing) is caught by the outer handler and redirects with the canonical error envelope, not an unhandled rejection', async () => {
    // Real `jsonwebtoken` (not mocked in this suite) throws synchronously when
    // handed no secret — exercises the outer try/catch this fix adds around
    // the whole passport callback, past the org-provisioning best-effort branch.
    jest.resetModules();
    jest.unstable_mockModule('passport', () => ({ default: mockPassport }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    }));
    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: {
        sign: { up: true, in: true },
        jwt: { secret: undefined, expiresIn: 3600 },
        cookie: { secure: true, sameSite: 'lax' },
        organizations: { enabled: true },
        app: { title: 'Test', contact: 'a@b.com' },
      },
    }));
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: { create: jest.fn(), getBrut: jest.fn(), update: jest.fn(), remove: jest.fn(), search: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    }));
    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: { registerSignupEligibility: jest.fn(), assertSignupEligible: jest.fn().mockResolvedValue(undefined), _reset: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/auth/services/auth.signupCapacity.js', () => ({
      computeSignupCapacity: jest.fn().mockResolvedValue({ cap: null, remaining: null }),
    }));
    jest.unstable_mockModule('../../../modules/users/repositories/users.repository.js', () => ({
      default: { update: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
      default: { handleSignupOrganization: jest.fn().mockResolvedValue({ _id: 'org_001' }) },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.crud.service.js', () => ({
      default: { autoSetCurrentOrganization: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.membership.service.js', () => ({
      default: { findByUserAndOrganization: jest.fn(), listPendingByUser: jest.fn().mockResolvedValue([]) },
    }));
    jest.unstable_mockModule('../../../modules/users/models/users.schema.js', () => ({
      default: { User: {} },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
      default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
      default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
    }));
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: jest.fn().mockReturnValue(false), sendMail: jest.fn() },
    }));
    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: { success: jest.fn().mockReturnValue(jest.fn()), error: jest.fn().mockReturnValue(jest.fn()) },
    }));
    jest.unstable_mockModule('../../../lib/helpers/errors.js', () => ({
      default: { getMessage: jest.fn().mockReturnValue('error') },
    }));
    jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({
      default: class AppError extends Error {
        constructor(msg, opts) {
          super(msg);
          this.status = opts?.status;
          this.code = opts?.code;
          this.details = opts?.details;
        }
      },
    }));
    jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
      default: jest.fn().mockReturnValue([]),
    }));
    jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
      default: jest.fn().mockReturnValue('http://localhost:3000'),
    }));
    jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
      default: { identify: jest.fn(), capture: jest.fn(), groupIdentify: jest.fn() },
    }));

    const user = { id: 'user_004', currentOrganization: 'org_existing' };
    mockPassport.authenticate.mockImplementation((strategy, callback) => () => callback(null, user));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { params: { strategy: 'google' }, body: {} };
    const { res, cookies, redirectCalls } = buildRes();

    // Must not throw / must not reject the caller's await — the outer catch owns it.
    await AuthController.oauthCallback(req, res, () => {});

    expect(cookies.TOKEN).toBeUndefined();
    expect(redirectCalls[0]).toMatchObject({ code: 302 });
    expect(redirectCalls[0].url).toMatch(/\/token/);
  });
});
