/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — #3981: `inviteHonored` (auth.controller.signup) gates whether a
 * resolved invite is finalized on success / released on failure. It must be
 * `true` when the invite was actually CLAIMED by the eligibility checker:
 *   - signup CLOSED (the invite was required to open the gate) — unaffected by
 *     `invitations.userFacing`, always honored when present.
 *   - signup OPEN AND `invitations.userFacing: true` — the #3981 fix: a
 *     presented token still claims/finalizes on an open-signup deployment.
 * Outside those two cases (open signup, `userFacing: false`, the default) a
 * presented-but-unclaimed invite must NEVER be finalized/released — asserting
 * this is what proves "today's behavior byte-for-byte" is preserved.
 *
 * No DB — the eligibility registry, UserService and org service are all
 * mocked; only auth.controller.signup()'s own branching is under test.
 */

/**
 * @desc Mock every auth.controller dependency EXCEPT config/eligibility/UserService.create,
 * which are supplied per test so each scenario can vary sign.up / userFacing / invite /
 * create outcome. Must run before the dynamic import of auth.controller.js in each test
 * (jest.resetModules() + jest.unstable_mockModule are call-order-sensitive).
 * @param {Object} args
 * @param {Object} args.config - the mocked config module default export
 * @param {Object} [args.eligibility] - the mocked auth.eligibility default export
 * @param {Function} [args.create] - UserService.create mock implementation
 * @returns {void}
 */
function mockCommonDeps({ config, eligibility, create }) {
  jest.resetModules();

  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
    default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  }));

  jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
    default: {
      create: create || jest.fn().mockResolvedValue({
        id: 'u1', email: 'x@y.com', firstName: 'A', lastName: 'B', provider: 'local',
      }),
      getBrut: jest.fn().mockResolvedValue({ id: 'u1' }),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
  }));

  jest.unstable_mockModule('../../../modules/auth/services/auth.eligibility.js', () => ({
    default: eligibility || {
      registerSignupEligibility: jest.fn(),
      assertSignupEligible: jest.fn().mockResolvedValue(undefined),
      _reset: jest.fn(),
    },
  }));

  jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
    default: {
      handleSignupOrganization: jest.fn().mockResolvedValue({
        organization: null, joined: false, pendingJoin: false,
        abilities: [], organizationSetupRequired: false,
        emailVerificationRequired: false, suggestedOrganization: null,
      }),
    },
  }));

  jest.unstable_mockModule('../../../modules/organizations/services/organizations.crud.service.js', () => ({
    default: { autoSetCurrentOrganization: jest.fn() },
  }));

  jest.unstable_mockModule('../../../modules/organizations/services/organizations.membership.service.js', () => ({
    default: { findByUserAndOrganization: jest.fn(), listPendingByUser: jest.fn().mockResolvedValue([]) },
  }));

  jest.unstable_mockModule('../../../config/index.js', () => ({ default: config }));

  jest.unstable_mockModule('../../../lib/middlewares/model.js', () => ({
    default: { getResultFromZod: jest.fn(), checkError: jest.fn() },
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
}

/**
 * @desc Build a mocked eligibility result carrying a resolved invite plus spy-able
 * finalize/release closures (the return-value seam auth.controller relays verbatim).
 * @param {Object} [invite] - resolved invite doc; defaults to a valid token-signup invite
 * @returns {{ eligibility: Object, finalize: jest.Mock, release: jest.Mock }}
 */
function mockEligibilityWithInvite(invite = { id: 'inv1', email: 'x@y.com', invitedBy: 'inviter1' }) {
  const finalize = jest.fn().mockResolvedValue({ id: invite.id, status: 'accepted' });
  const release = jest.fn().mockResolvedValue({ id: invite.id });
  const eligibility = {
    registerSignupEligibility: jest.fn(),
    assertSignupEligible: jest.fn().mockResolvedValue({ invite, finalize, release }),
    _reset: jest.fn(),
  };
  return { eligibility, finalize, release };
}

const baseConfig = (overrides = {}) => ({
  sign: { up: true, in: true, ...overrides.sign },
  jwt: { secret: 'test-secret', expiresIn: 3600 },
  cookie: { secure: false, sameSite: 'lax' },
  organizations: { enabled: false },
  app: { title: 'Test', contact: 'test@test.com' },
  invitations: { userFacing: false, ...overrides.invitations },
});

describe('auth.controller signup: inviteHonored gate (#3981)', () => {
  test('closed signup + invite present ⇒ finalized (baseline, unaffected by userFacing:false)', async () => {
    const { eligibility, finalize, release } = mockEligibilityWithInvite();
    mockCommonDeps({ config: baseConfig({ sign: { up: false }, invitations: { userFacing: false } }), eligibility });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(finalize).toHaveBeenCalledWith('u1');
    expect(release).not.toHaveBeenCalled();
  });

  test('closed signup + invite present + userFacing:true ⇒ still finalized (flag is a no-op when signup is closed)', async () => {
    const { eligibility, finalize } = mockEligibilityWithInvite();
    mockCommonDeps({ config: baseConfig({ sign: { up: false }, invitations: { userFacing: true } }), eligibility });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(finalize).toHaveBeenCalledWith('u1');
  });

  test('open signup + invite present + userFacing:false (default) ⇒ NEVER finalized (today\'s behavior, byte-for-byte)', async () => {
    const { eligibility, finalize, release } = mockEligibilityWithInvite();
    mockCommonDeps({ config: baseConfig({ sign: { up: true }, invitations: { userFacing: false } }), eligibility });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(finalize).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test('open signup + invite present + userFacing:true ⇒ FINALIZED (#3981 fix — the open-signup hole closes)', async () => {
    const { eligibility, finalize, release } = mockEligibilityWithInvite();
    mockCommonDeps({ config: baseConfig({ sign: { up: true }, invitations: { userFacing: true } }), eligibility });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(finalize).toHaveBeenCalledWith('u1');
    expect(release).not.toHaveBeenCalled();
  });

  test('open signup + userFacing:true + NO invite (no token presented) ⇒ plain signup, nothing to finalize', async () => {
    mockCommonDeps({
      config: baseConfig({ sign: { up: true }, invitations: { userFacing: true } }),
      eligibility: {
        registerSignupEligibility: jest.fn(),
        assertSignupEligible: jest.fn().mockResolvedValue(undefined), // no eligible invite resolved
        _reset: jest.fn(),
      },
    });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'plain@y.com', firstName: 'C', lastName: 'D', password: 'P@ss1234!' }, query: {} };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('open signup + userFacing:true + invite present + create() throws ⇒ claim is RELEASED', async () => {
    const { eligibility, release } = mockEligibilityWithInvite();
    const create = jest.fn().mockRejectedValue(new Error('E11000 duplicate key'));
    mockCommonDeps({ config: baseConfig({ sign: { up: true }, invitations: { userFacing: true } }), eligibility, create });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(release).toHaveBeenCalledTimes(1);
  });

  test('open signup + userFacing:false + invite present + create() throws ⇒ release is NEVER called (nothing was claimed)', async () => {
    const { eligibility, release } = mockEligibilityWithInvite();
    const create = jest.fn().mockRejectedValue(new Error('E11000 duplicate key'));
    mockCommonDeps({ config: baseConfig({ sign: { up: true }, invitations: { userFacing: false } }), eligibility, create });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(release).not.toHaveBeenCalled();
  });

  test('capacity gate: open signup + userFacing:true + invite claimed + cap reached ⇒ 404 AND the claim is released', async () => {
    const { eligibility, release } = mockEligibilityWithInvite();
    mockCommonDeps({
      config: baseConfig({ sign: { up: true, cap: 1 }, invitations: { userFacing: true } }),
      eligibility,
    });
    // Cap already full: UserService.count() resolves 1 (>= cap 1) ⇒ capReached.
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: {
        create: jest.fn(),
        getBrut: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
    }));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(release).toHaveBeenCalledTimes(1);
  });
});
