/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';
import { setupAuthControllerMocks } from './fixtures/auth-controller.mock-setup.js';

/**
 * Regression guard (issue #3954): every test in auth.oauthCall.controller.unit.tests.js
 * replaces `passport` wholesale via `jest.unstable_mockModule` and stubs `_strategy` as
 * a `jest.fn()` — so if a future passport upgrade renames or removes the private
 * `_strategy` API that isEnabledOAuthProvider() relies on (see auth.controller.js), none
 * of those mocks would notice; production would silently 404 every OAuth login while
 * that whole suite kept passing green.
 *
 * This test uses the REAL `passport` package, registers a trivial strategy via the real
 * `passport.use()`, and asserts the guard recognizes it through the real `_strategy`
 * lookup (only `passport.authenticate` itself is stubbed, since the trivial strategy's
 * `authenticate()` is never meant to run a full handshake).
 *
 * Deliberately kept in its OWN file rather than added to
 * auth.oauthCall.controller.unit.tests.js: `jest.unstable_mockModule('passport', ...)`
 * mock-factory registrations are sticky for the lifetime of a test FILE — they survive
 * `jest.resetModules()` — so a real-passport test placed after any mocked-passport test
 * in the same file would still resolve `import('passport')` to the stale mock. A
 * dedicated file gives this test a clean module registry with no prior passport mock.
 */
describe('auth.controller oauthCall — isEnabledOAuthProvider against a REAL passport strategy:', () => {
  test('a strategy registered via the real passport.use() is recognized by the guard and delegated to', async () => {
    setupAuthControllerMocks({ realPassport: true });

    const { default: passport } = await import('passport');

    class TrivialStrategy {
      constructor(name) {
        this.name = name;
      }

      // Never actually invoked in this test — passport.authenticate() is stubbed
      // below, so the guard-focused assertions never reach a real handshake.
      authenticate() {
        this.fail({ message: 'trivial strategy stub — not exercised by this guard test' });
      }
    }
    passport.use(new TrivialStrategy('google'));
    const authenticateMiddleware = jest.fn();
    jest.spyOn(passport, 'authenticate').mockReturnValue(authenticateMiddleware);

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const req = { params: { strategy: 'google' } };
    const res = {};
    const next = jest.fn();

    AuthController.oauthCall(req, res, next);

    expect(passport.authenticate).toHaveBeenCalledWith('google', { session: false });
    expect(authenticateMiddleware).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });
});
