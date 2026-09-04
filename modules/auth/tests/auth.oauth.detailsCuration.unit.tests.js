/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { setupAuthControllerMocks } from './fixtures/auth-controller.mock-setup.js';

/**
 * Unit tests — issue #4059. Two things proven here by EXECUTION, not by
 * reading the source:
 *  1. Each of the four `checkOAuthUserProfile` catch sites curates `details`
 *     to `{ message: err.message }` ONLY — never the raw caught exception,
 *     which may carry a stack, driver metadata, or other fields nobody chose
 *     to publish (`auth.controller.js` lines ~315/328/364/473).
 *  2. `oauthErrorRedirect` (which never goes through `responses.error`/
 *     `getDescription` — it builds its own envelope by hand) gates that
 *     curated `details.message` to non-production, mirroring
 *     `getDescription`'s own gate added by the same issue — confirmed by
 *     constructing an error carrying obviously-internal text and inspecting
 *     the actual redirect payload under `NODE_ENV=production`.
 */

/**
 * Loads a fresh auth.controller.js instance with UserService methods
 * stubbable per test (kept local rather than reusing
 * auth.oauth.signup.analytics.unit.tests.js's `loadController` — that file's
 * per-branch RESOLVE wiring and this suite's per-method REJECT wiring differ
 * enough that sharing would need as many options as duplicating).
 * @param {Object} [userServiceOverrides] - per-method jest.fn() overrides merged over safe defaults
 * @returns {Promise<{AuthController: Object}>}
 */
const loadController = async (userServiceOverrides = {}) => {
  jest.resetModules();

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
      sign: { up: true, in: true }, // open signup — branch 3/4's invite hook is skipped entirely
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
  return { AuthController };
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
});
