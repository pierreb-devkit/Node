/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { setupAuthControllerMocks } from './fixtures/auth-controller.mock-setup.js';
// Captured via a plain static import — evaluated once, before any test runs and
// before any `jest.unstable_mockModule` call — so this is genuinely the REAL
// `AppError` class (with `.description` support), never a stub. `loadController`
// below explicitly re-registers this reference as its own "mock" for
// `AppError.js` on every call: `setupAuthControllerMocks` (used by the
// `oauthCallback / oauthErrorRedirect` describe block further down THIS SAME
// file) mocks that same module path with a simplified stub that does NOT set
// `.description`, and jest's ESM module mocking is last-registration-wins per
// resolved specifier, NOT reset just because a later `jest.resetModules()` ran
// without re-mocking it — so `loadController` must win that race explicitly on
// every call, not rely on "just don't mock it".
import RealAppError from '../../../lib/helpers/AppError.js';

/**
 * Unit tests — issue #4059 and its review follow-up. Proven here by
 * EXECUTION, not by reading the source:
 *  1. Each of the four `checkOAuthUserProfile` catch sites curates `details`
 *     to `{ message: err.message }` ONLY — never the raw caught exception,
 *     which may carry a stack, driver metadata, or other fields nobody chose
 *     to publish (`auth.controller.js` lines ~315/328/364/473).
 *  2. `oauthErrorRedirect` (which never goes through `responses.error`/
 *     `getDescription` — it builds its own envelope by hand) gates its
 *     curated `details.message` read to non-production, mirroring
 *     `getDescription`'s own gate added by the same issue — confirmed by
 *     constructing an error carrying obviously-internal text and inspecting
 *     the actual redirect payload under `NODE_ENV=production`.
 *  3. (review item 1) Two deliberately-authored, user-facing OAuth messages
 *     (branch 3's unverified-account notice, branch 4's registration-closed
 *     notice) are passed via `AppError`'s `description` option instead of
 *     `details.message` — an explicit, NEVER-gated channel `oauthErrorRedirect`
 *     now also reads — so they reach the client in every environment,
 *     production included, driven through the REAL throw sites end to end.
 *  4. (review item 2) `oauthErrorRedirect`'s `title` is now ALSO
 *     production-gated for a non-AppError `err` (the earlier claim that this
 *     function was gated "the same way" as `getDescription` was true only for
 *     `details.message`, not `title` — see ERRORS.md 2026-09-05).
 */

/**
 * Loads a fresh auth.controller.js instance with UserService methods
 * stubbable per test (kept local rather than reusing
 * auth.oauth.signup.analytics.unit.tests.js's `loadController` — that file's
 * per-branch RESOLVE wiring and this suite's per-method REJECT wiring differ
 * enough that sharing would need as many options as duplicating).
 * `passport` is mocked (not left to resolve the real package) so a test can
 * drive a real `checkOAuthUserProfile` throw all the way through the real
 * `oauthCallback` → `oauthErrorRedirect` in this SAME module registry — the
 * real (unmocked) `AppError` and `configHelper` this file's `checkOAuthUserProfile`
 * tests already rely on, which the `description`/title-gate tests below need too
 * (a synthetic error built in a DIFFERENT jest module registry, e.g. via
 * `setupAuthControllerMocks` below, would not be `instanceof` this registry's
 * `AppError`).
 * @param {Object} [userServiceOverrides] - per-method jest.fn() overrides merged over safe defaults
 * @param {Object} [signOverrides] - merged over the default `config.sign` ({ up: true, in: true }) —
 *   e.g. `{ up: false }` to exercise branch 4's registration-closed gate
 * @returns {Promise<{AuthController: Object, mockPassport: {authenticate: import('@jest/globals').Mock, _strategy: import('@jest/globals').Mock}}>}
 */
const loadController = async (userServiceOverrides = {}, signOverrides = {}) => {
  jest.resetModules();

  const mockPassport = {
    authenticate: jest.fn().mockReturnValue(jest.fn()),
    _strategy: jest.fn().mockReturnValue(undefined),
  };
  jest.unstable_mockModule('passport', () => ({ default: mockPassport }));

  // Explicitly re-win the real class every call — see the top-of-file comment
  // on `RealAppError` for why this can't just be "leave it unmocked".
  jest.unstable_mockModule('../../../lib/helpers/AppError.js', () => ({ default: RealAppError }));

  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
    default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  }));

  jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
    default: {
      create: jest.fn().mockResolvedValue({ id: 'u1', email: 'new@test.com' }),
      search: jest.fn().mockResolvedValue([]),
      linkProviderByEmail: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      ...userServiceOverrides,
    },
  }));

  jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
    default: { registerSignupEligibility: jest.fn(), assertSignupEligible: jest.fn().mockResolvedValue(undefined), _reset: jest.fn() },
  }));

  jest.unstable_mockModule('../../../modules/auth/services/auth.signupCapacity.js', () => ({
    computeSignupCapacity: jest.fn().mockResolvedValue({ cap: null, remaining: null }),
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

  jest.unstable_mockModule('../../../config/index.js', () => ({
    default: {
      sign: { up: true, in: true, ...signOverrides }, // open signup by default — branch 3/4's invite hook is skipped entirely
      jwt: { secret: 'test-secret', expiresIn: 3600 },
      cookie: { secure: false, sameSite: 'lax' },
      organizations: { enabled: false },
      app: { title: 'Test', contact: 'test@test.com' },
    },
  }));

  jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
    default: {
      // Pass the candidate straight through as "validated" — Zod itself is
      // not under test here, only that branch 4's create() failure is curated.
      getResultFromZod: jest.fn((body) => ({ value: { ...body } })),
      checkError: jest.fn(() => false),
    },
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

  jest.unstable_mockModule('../../../modules/users/models/users.schema.js', () => ({
    default: { User: {}, SignupUser: {} },
  }));

  jest.unstable_mockModule('../../../lib/middlewares/policy.js', () => ({
    default: { defineAbilityFor: jest.fn().mockResolvedValue({}) },
  }));

  jest.unstable_mockModule('../../../lib/helpers/abilities.js', () => ({
    default: jest.fn().mockReturnValue([]),
  }));

  jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
    default: jest.fn().mockReturnValue('http://localhost:3000'),
  }));

  jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
    default: { identify: jest.fn(), groupIdentify: jest.fn(), capture: jest.fn() },
  }));

  const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
  return { AuthController, mockPassport };
};

// An error message shaped like the internal text #4059 reports leaking:
// a driver-level connection failure naming an internal host, no user-facing
// framing at all — nothing a client should ever see.
const INTERNAL_TEXT = 'ECONNREFUSED 10.0.4.12:27017 - mongo replset primary unreachable';

/**
 * Builds a raw caught exception carrying `INTERNAL_TEXT` as `.message` plus
 * several OTHER fields a real driver/HTTP client error might attach (stack
 * string, an internal host, a library-specific code) — curation must forward
 * `message` alone and drop the rest.
 * @returns {Error}
 */
const buildRawInternalError = () => Object.assign(new Error(INTERNAL_TEXT), {
  stack: 'Error: internal\n    at Connection.connect (/app/node_modules/mongodb/lib/connect.js:42:11)',
  code: 'ECONNREFUSED',
  host: '10.0.4.12',
});

describe('checkOAuthUserProfile — details curation at the four raw-error catch sites (issue #4059):', () => {
  test('branch 1 (primary identity search failure) curates details to { message } only', async () => {
    const { AuthController } = await loadController({ search: jest.fn().mockRejectedValue(buildRawInternalError()) });

    let caught;
    try {
      await AuthController.checkOAuthUserProfile({ providerData: { id: 'p1' } }, 'id', 'google');
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ message: 'oAuth, find user failed', code: 'SERVICE_ERROR' });
    // `message` itself legitimately carries the internal text at THIS layer —
    // curation's job is dropping every OTHER field the raw error carried
    // (stack, code, host), not redacting `message`. The client-facing leak
    // this text would otherwise cause is closed downstream, at the
    // `getDescription`/`oauthErrorRedirect` production gate (decision 2,
    // covered in its own describe block below) — not here.
    expect(caught.details).toEqual({ message: INTERNAL_TEXT });
    expect(Object.keys(caught.details)).toEqual(['message']);
    expect(caught.details.stack).toBeUndefined();
    expect(caught.details.code).toBeUndefined();
    expect(caught.details.host).toBeUndefined();
  });

  test('branch 2 (linked identity search failure) curates details to { message } only', async () => {
    const search = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(buildRawInternalError());
    const { AuthController } = await loadController({ search });

    let caught;
    try {
      await AuthController.checkOAuthUserProfile({ providerData: { id: 'p1' } }, 'id', 'google');
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ message: 'oAuth, find linked user failed', code: 'SERVICE_ERROR' });
    expect(caught.details).toEqual({ message: INTERNAL_TEXT });
    expect(Object.keys(caught.details)).toEqual(['message']);
  });

  test('branch 3 (link-on-verified-email failure) curates details to { message } only', async () => {
    const { AuthController } = await loadController({
      search: jest.fn().mockResolvedValue([]),
      linkProviderByEmail: jest.fn().mockRejectedValue(buildRawInternalError()),
    });

    let caught;
    try {
      await AuthController.checkOAuthUserProfile(
        { providerData: { sub: 'p1' }, email: 'user@example.com', emailVerifiedByProvider: true },
        'sub',
        'google',
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ message: 'oAuth, link to existing user failed', code: 'SERVICE_ERROR' });
    expect(caught.details).toEqual({ message: INTERNAL_TEXT });
    expect(Object.keys(caught.details)).toEqual(['message']);
  });

  test('branch 4 (create-new-user failure, the catch-all) curates details to { message } only', async () => {
    const { AuthController } = await loadController({
      search: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockRejectedValue(buildRawInternalError()),
    });

    let caught;
    try {
      await AuthController.checkOAuthUserProfile({ providerData: { sub: 'p1' }, firstName: 'A', lastName: 'B' }, 'sub', 'google');
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ message: 'oAuth', code: 'CONTROLLER_ERROR' });
    expect(caught.details).toEqual({ message: INTERNAL_TEXT });
    expect(Object.keys(caught.details)).toEqual(['message']);
  });
});

describe('oauthCallback / oauthErrorRedirect — production gate on curated details.message (issue #4059):', () => {
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
   * Drives oauthCallback with `err` as the passport.authenticate() callback
   * error and returns the parsed `error` query-param payload from the 302
   * redirect it issues.
   * @param {Error} err
   * @returns {Promise<Object>} the parsed redirect payload
   */
  const runOauthCallbackError = async (err) => {
    mockPassport._strategy.mockReturnValue({});
    mockPassport.authenticate.mockImplementationOnce((strategy, callback) => () => callback(err, null));
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const redirectCalls = [];
    const req = { params: { strategy: 'google' }, body: {} };
    const res = { cookie() { return this; }, redirect(code, url) { redirectCalls.push({ code, url }); } };
    await AuthController.oauthCallback(req, res, () => {});

    const parsed = new URL(redirectCalls[0].url);
    return JSON.parse(parsed.searchParams.get('error'));
  };

  test('an AppError carrying obviously-internal text in details.message does NOT reach the redirect payload in production', async () => {
    const { default: AppError } = await import('../../../lib/helpers/AppError.js');
    const internalErr = new AppError('oAuth, find user failed', { code: 'SERVICE_ERROR', details: { message: INTERNAL_TEXT } });

    process.env.NODE_ENV = 'production';
    const payload = await runOauthCallbackError(internalErr);

    expect(payload.description).toBe('');
    // Legacy `details.message` field falls back to the safe outer AppError
    // message (never blank, never the internal text) once gated.
    expect(payload.details).toEqual({ message: 'oAuth, find user failed' });
    expect(JSON.stringify(payload)).not.toContain('10.0.4.12');
    expect(JSON.stringify(payload)).not.toContain('ECONNREFUSED');
  });

  test('the SAME error, outside production — full details.message text still reaches the redirect payload (unchanged, decision 2 scope)', async () => {
    const { default: AppError } = await import('../../../lib/helpers/AppError.js');
    const internalErr = new AppError('oAuth, find user failed', { code: 'SERVICE_ERROR', details: { message: INTERNAL_TEXT } });

    process.env.NODE_ENV = 'test';
    const payload = await runOauthCallbackError(internalErr);

    expect(payload.description).toBe(INTERNAL_TEXT);
    expect(payload.details).toEqual({ message: INTERNAL_TEXT });
  });

  /**
   * Review item 2 — `oauthErrorRedirect`'s `title` was NEVER gated (only
   * `details.message` was), so a non-AppError `err` reaching `oauthCallback`
   * put its raw `.message` into `payload.message`, `payload.details.message`
   * (both via the `title` fallback), AND the redirect URL's `message` query
   * param, unaffected by either gate. A plain `Error` — not an `AppError` — is
   * exactly that shape; deliberately using this suite's `setupAuthControllerMocks`
   * fixture (not `loadController`) since a non-AppError needs no real `AppError`
   * class at all.
   */
  test('a non-AppError (dynamic message, no `.details`) falls back to fallbackTitle everywhere in production — the ungated-title gap review item 2 closes', async () => {
    const dynamicErr = new Error('internal: mongo replset primary at 10.0.4.12 unreachable');

    process.env.NODE_ENV = 'production';
    mockPassport._strategy.mockReturnValue({});
    mockPassport.authenticate.mockImplementationOnce((strategy, callback) => () => callback(dynamicErr, null));
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const redirectCalls = [];
    const req = { params: { strategy: 'google' }, body: {} };
    const res = { cookie() { return this; }, redirect(code, url) { redirectCalls.push({ code, url }); } };
    await AuthController.oauthCallback(req, res, () => {});

    const parsed = new URL(redirectCalls[0].url);
    const payload = JSON.parse(parsed.searchParams.get('error'));

    expect(parsed.searchParams.get('message')).toBe('oAuth error');
    expect(payload.message).toBe('oAuth error');
    expect(payload.details).toEqual({ message: 'oAuth error' });
    expect(JSON.stringify(payload)).not.toContain('10.0.4.12');
    expect(parsed.toString()).not.toContain('10.0.4.12');
  });

  test('the SAME non-AppError, outside production — its raw `.message` still surfaces as the title (unchanged)', async () => {
    const dynamicErr = new Error('internal: mongo replset primary at 10.0.4.12 unreachable');

    process.env.NODE_ENV = 'test';
    mockPassport._strategy.mockReturnValue({});
    mockPassport.authenticate.mockImplementationOnce((strategy, callback) => () => callback(dynamicErr, null));
    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');

    const redirectCalls = [];
    const req = { params: { strategy: 'google' }, body: {} };
    const res = { cookie() { return this; }, redirect(code, url) { redirectCalls.push({ code, url }); } };
    await AuthController.oauthCallback(req, res, () => {});

    const parsed = new URL(redirectCalls[0].url);
    const payload = JSON.parse(parsed.searchParams.get('error'));

    expect(payload.message).toBe(dynamicErr.message);
  });
});

/**
 * Review item 1 — two deliberately-authored, user-facing OAuth messages
 * (previously smuggled through `details.message`, and therefore blanked by
 * the production gate above) must reach the client in EVERY environment,
 * production included. Driven end to end through the REAL throw sites (real
 * `checkOAuthUserProfile` branches) and the REAL `oauthCallback` →
 * `oauthErrorRedirect`, all in the SAME `loadController` module registry, so
 * `err instanceof AppError` inside `oauthErrorRedirect` sees the genuine class.
 */
describe('checkOAuthUserProfile → oauthCallback → oauthErrorRedirect — the two authored OAuth messages survive the production gate (issue #4059 review item 1):', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /**
   * Drives `checkOAuthUserProfile(...checkArgs)` to a genuine throw, then feeds
   * that REAL AppError through the REAL `oauthCallback` → `oauthErrorRedirect`.
   * @param {Object} AuthController
   * @param {Object} mockPassport
   * @param {Array} checkArgs - arguments forwarded to `checkOAuthUserProfile`
   * @returns {Promise<{messageParam: string, payload: Object}>}
   */
  const runRealOAuthError = async (AuthController, mockPassport, checkArgs) => {
    let caught;
    try {
      await AuthController.checkOAuthUserProfile(...checkArgs);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined(); // fail loudly here, not on a confusing downstream assertion, if the branch didn't throw

    mockPassport._strategy.mockReturnValue({});
    mockPassport.authenticate.mockImplementationOnce((strategy, callback) => () => callback(caught, null));
    const redirectCalls = [];
    const req = { params: { strategy: 'google' }, body: {} };
    const res = { cookie() { return this; }, redirect(code, url) { redirectCalls.push({ code, url }); } };
    await AuthController.oauthCallback(req, res, () => {});

    const parsed = new URL(redirectCalls[0].url);
    return { messageParam: parsed.searchParams.get('message'), payload: JSON.parse(parsed.searchParams.get('error')) };
  };

  test('branch 3 (unverified local account) — the authored notice reaches the client in production', async () => {
    const { AuthController, mockPassport } = await loadController({
      linkProviderByEmail: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue({ emailVerified: false }),
    });

    process.env.NODE_ENV = 'production';
    const { payload } = await runRealOAuthError(AuthController, mockPassport, [
      { providerData: { sub: 'p1' }, email: 'user@example.com', emailVerifiedByProvider: true },
      'sub',
      'google',
    ]);

    const AUTHORED_MESSAGE = 'A pending account with this email is not verified. Verify the original signup first or contact support.';
    expect(payload.description).toBe(AUTHORED_MESSAGE);
    expect(payload.details).toEqual({ message: AUTHORED_MESSAGE });
  });

  test('branch 4 (registration closed) — the authored notice reaches the client in production', async () => {
    const { AuthController, mockPassport } = await loadController({}, { up: false });

    process.env.NODE_ENV = 'production';
    const { messageParam, payload } = await runRealOAuthError(AuthController, mockPassport, [
      { providerData: { sub: 'p2' }, firstName: 'A', lastName: 'B' },
      'sub',
      'google',
    ]);

    expect(messageParam).toBe('Signup error');
    expect(payload.description).toBe('Registration is currently deactivated');
    expect(payload.details).toEqual({ message: 'Registration is currently deactivated' });
  });

  test('control — branch 1\'s raw internal DB text still does NOT reach the client in production, proving the description bypass is scoped to these two messages only', async () => {
    const rawInternal = Object.assign(new Error(INTERNAL_TEXT), { code: 'ECONNREFUSED', host: '10.0.4.12' });
    const { AuthController, mockPassport } = await loadController({
      search: jest.fn().mockRejectedValue(rawInternal),
    });

    process.env.NODE_ENV = 'production';
    const { payload } = await runRealOAuthError(AuthController, mockPassport, [
      { providerData: { id: 'p1' } },
      'id',
      'google',
    ]);

    expect(payload.description).toBe('');
    expect(JSON.stringify(payload)).not.toContain('10.0.4.12');
    expect(JSON.stringify(payload)).not.toContain('ECONNREFUSED');
  });
});
