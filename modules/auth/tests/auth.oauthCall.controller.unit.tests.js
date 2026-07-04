/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Unit tests for auth.controller oauthCall() (issue #3900).
 *
 * Before this guard, `oauthCall` passed `req.params.strategy` straight into
 * `passport.authenticate()` with no validation and no `{ session: false }`:
 *  - an unknown strategy name made passport throw synchronously ("Unknown
 *    authentication strategy") -> 500.
 *  - an allowlisted-but-unregistered provider hit the same throw.
 *  - a registered provider defaulted to `session: true`, which fails on this
 *    stateless JWT stack ("Login sessions require session support").
 *
 * These tests verify the new isEnabledOAuthProvider() guard turns the first
 * two cases into a clean 404 and never reaches passport.authenticate(), and
 * that the third case delegates with `{ session: false }`.
 */
describe('auth.controller oauthCall:', () => {
  let mockPassport;

  beforeEach(() => {
    jest.resetModules();

    mockPassport = {
      authenticate: jest.fn().mockReturnValue(jest.fn()),
      _strategy: jest.fn().mockReturnValue(undefined),
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
        organizations: { enabled: false },
        app: { title: 'Test', contact: 'a@b.com' },
      },
    }));
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: { create: jest.fn(), getBrut: jest.fn(), update: jest.fn(), remove: jest.fn(), search: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    }));
    // auth.controller imports the generic eligibility registry (not invitation code).
    jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
      default: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined),
        _reset: jest.fn(),
      },
    }));
    jest.unstable_mockModule('../../../modules/users/repositories/users.repository.js', () => ({
      default: { update: jest.fn() },
    }));
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
      default: { handleSignupOrganization: jest.fn() },
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
      default: { identify: jest.fn(), groupIdentify: jest.fn() },
    }));
  });

  test('unknown strategy (not in ALLOWED_PROVIDERS) is rejected with a 404, passport.authenticate is never called', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'me' } };
    const res = {};
    const next = jest.fn();

    AuthController.oauthCall(req, res, next);

    expect(mockPassport.authenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.code).toBe('OAUTH_PROVIDER_NOT_FOUND');
  });

  test('another unknown strategy segment (e.g. "callback") is rejected with a 404', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'callback' } };
    const res = {};
    const next = jest.fn();

    AuthController.oauthCall(req, res, next);

    expect(mockPassport.authenticate).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.status).toBe(404);
    expect(err.code).toBe('OAUTH_PROVIDER_NOT_FOUND');
  });

  test('allowlisted but unregistered provider (not enabled in config) is rejected with a 404', async () => {
    // passport._strategy() returns undefined by default in this suite's mock —
    // simulating a provider that is in ALLOWED_PROVIDERS but was never
    // passport.use()'d at boot (e.g. missing clientID/clientSecret).
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'google' } };
    const res = {};
    const next = jest.fn();

    AuthController.oauthCall(req, res, next);

    expect(mockPassport._strategy).toHaveBeenCalledWith('google');
    expect(mockPassport.authenticate).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.status).toBe(404);
    expect(err.code).toBe('OAUTH_PROVIDER_NOT_FOUND');
  });

  test('enabled + allowlisted provider delegates to passport.authenticate with { session: false }', async () => {
    mockPassport._strategy.mockReturnValue({ name: 'google' }); // simulate registered strategy
    const authenticateMiddleware = jest.fn();
    mockPassport.authenticate.mockReturnValue(authenticateMiddleware);

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'google' } };
    const res = {};
    const next = jest.fn();

    AuthController.oauthCall(req, res, next);

    expect(mockPassport.authenticate).toHaveBeenCalledWith('google', { session: false });
    expect(authenticateMiddleware).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  test('apple (the other allowlisted provider) also delegates when registered', async () => {
    mockPassport._strategy.mockReturnValue({ name: 'apple' });
    const authenticateMiddleware = jest.fn();
    mockPassport.authenticate.mockReturnValue(authenticateMiddleware);

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'apple' } };
    const res = {};
    const next = jest.fn();

    AuthController.oauthCall(req, res, next);

    expect(mockPassport.authenticate).toHaveBeenCalledWith('apple', { session: false });
    expect(authenticateMiddleware).toHaveBeenCalledWith(req, res, next);
  });
});
