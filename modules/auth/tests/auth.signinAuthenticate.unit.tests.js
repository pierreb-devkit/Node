/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { setupAuthControllerMocks } from './fixtures/auth-controller.mock-setup.js';

/**
 * Unit tests — issue #4059 review item 4. `signinAuthenticate`'s
 * `ACCOUNT_LOCKED` branch reads `err.description` directly (a deliberate,
 * explicit bypass of `getDescription`'s production gate — decided the SAME
 * way as review item 1's two OAuth messages: `auth.service.js#checkLockout`,
 * the only producer of this code, always sets a code-authored, user-facing
 * string, never a caught exception's text). Zero test coverage existed for
 * this path before — these tests exist so a future "fix" that routes it
 * through the gate (silently blanking the lockout message in production)
 * fails loudly instead of shipping unnoticed.
 */
describe('signinAuthenticate — ACCOUNT_LOCKED description bypass (issue #4059 review item 4):', () => {
  let mockPassport;
  let originalNodeEnv;

  beforeEach(() => {
    mockPassport = setupAuthControllerMocks();
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /**
   * Drives `signinAuthenticate` with `err` as the passport 'local' strategy's
   * callback error, and returns the mocked `responses.error` so the caller can
   * assert on its call arguments.
   * @param {Object} err
   * @returns {Promise<import('@jest/globals').Mock>}
   */
  const runSigninAuthenticate = async (err) => {
    mockPassport.authenticate.mockImplementationOnce(
      (strategy, opts, callback) => () => callback(err, null, null),
    );
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const { default: responses } = await import('../../../lib/helpers/responses.js');

    await AuthController.signinAuthenticate({}, {}, jest.fn());
    return responses.error;
  };

  test('the authored lockout message reaches responses.error even in production — description is NEVER gated for this producer', async () => {
    process.env.NODE_ENV = 'production';
    const err = { code: 'ACCOUNT_LOCKED', description: 'Account is locked. Try again in 5 minute(s).' };

    const mockResponsesError = await runSigninAuthenticate(err);

    expect(mockResponsesError).toHaveBeenCalledWith(
      expect.anything(),
      423,
      'Account locked',
      'Account is locked. Try again in 5 minute(s).',
    );
  });

  test('the SAME error, outside production — identical behavior (the bypass is not environment-conditional)', async () => {
    process.env.NODE_ENV = 'test';
    const err = { code: 'ACCOUNT_LOCKED', description: 'Account is locked. Try again in 5 minute(s).' };

    const mockResponsesError = await runSigninAuthenticate(err);

    expect(mockResponsesError).toHaveBeenCalledWith(
      expect.anything(),
      423,
      'Account locked',
      'Account is locked. Try again in 5 minute(s).',
    );
  });

  test('falls back to the generic message when `description` is absent (defensive default — the real producer always sets it)', async () => {
    process.env.NODE_ENV = 'production';
    const err = { code: 'ACCOUNT_LOCKED' };

    const mockResponsesError = await runSigninAuthenticate(err);

    expect(mockResponsesError).toHaveBeenCalledWith(
      expect.anything(),
      423,
      'Account locked',
      'Account is locked. Try again later.',
    );
  });
});
