/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { setupAuthControllerMocks } from './fixtures/auth-controller.mock-setup.js';

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
    mockPassport = setupAuthControllerMocks();
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

/**
 * Unit tests for auth.controller oauthCallback()'s isEnabledOAuthProvider guard
 * (issue #3900). The integration suite (auth.integration.tests.js) covers the
 * post-authenticate handling with `_strategy`/`authenticate` both stubbed truthy;
 * these tests cover the guard's reject branch specifically — an unknown or
 * allowlisted-but-unregistered strategy must 404 before passport.authenticate()
 * is ever reached, mirroring the oauthCall reject-path tests above.
 */
describe('auth.controller oauthCallback:', () => {
  let mockPassport;

  beforeEach(() => {
    mockPassport = setupAuthControllerMocks();
  });

  test('unknown strategy (not in ALLOWED_PROVIDERS) is rejected with a 404, passport.authenticate is never called', async () => {
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'me' }, body: {} };
    const res = {};
    const next = jest.fn();

    await AuthController.oauthCallback(req, res, next);

    expect(mockPassport.authenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.code).toBe('OAUTH_PROVIDER_NOT_FOUND');
  });

  test('allowlisted but unregistered provider (not enabled in config) is rejected with a 404', async () => {
    // passport._strategy() returns undefined by default in this suite's mock —
    // simulating a provider that is in ALLOWED_PROVIDERS but was never
    // passport.use()'d at boot (e.g. missing clientID/clientSecret).
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'google' }, body: {} };
    const res = {};
    const next = jest.fn();

    await AuthController.oauthCallback(req, res, next);

    expect(mockPassport._strategy).toHaveBeenCalledWith('google');
    expect(mockPassport.authenticate).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.status).toBe(404);
    expect(err.code).toBe('OAUTH_PROVIDER_NOT_FOUND');
  });
});
