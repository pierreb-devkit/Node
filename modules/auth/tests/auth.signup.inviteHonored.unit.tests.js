/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — #3981: `inviteHonored` (auth.controller.signup) gates whether a
 * resolved invite is finalized on success / released on failure. auth.controller.js
 * trusts `eligibility.claimed` verbatim — a boolean the eligibility checker
 * (invitations.init.js, exercised separately in
 * invitations/tests/invitations.init.userFacing.unit.tests.js) sets to `true` only
 * when it actually atomically CLAIMED the invite:
 *   - signup CLOSED (the invite was required to open the gate) — always claimed.
 *   - signup OPEN AND `invitations.userFacing: true` — the #3981 fix: a presented
 *     token still claims/finalizes on an open-signup deployment.
 * Outside those two cases (open signup, `userFacing: false`, the default) the
 * checker never claims, so `claimed` is false and a presented-but-unclaimed invite
 * must NEVER be finalized/released — asserting this is what proves "today's
 * behavior byte-for-byte" is preserved. This file only exercises auth.controller's
 * side of that contract (it trusts `claimed`, not a re-derived config condition) —
 * no DB, eligibility/UserService/org service all mocked.
 */

/**
 * @desc Mock every auth.controller dependency EXCEPT config/eligibility/UserService.create,
 * which are supplied per test so each scenario can vary sign.up / invite / create outcome.
 * Must run before the dynamic import of auth.controller.js in each test (jest.resetModules()
 * + jest.unstable_mockModule are call-order-sensitive).
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
 * @desc Build a mocked eligibility result carrying a resolved invite, the `claimed`
 * flag (#3981 — the single source of truth auth.controller trusts verbatim, set by
 * the real checker in invitations.init.js), plus spy-able finalize/release closures.
 * @param {Object} [invite] - resolved invite doc; defaults to a valid token-signup invite
 * @param {Boolean} [claimed] - whether the checker actually claimed this invite
 * @returns {{ eligibility: Object, finalize: jest.Mock, release: jest.Mock }}
 */
function mockEligibilityWithInvite(invite = { id: 'inv1', email: 'x@y.com', invitedBy: 'inviter1' }, claimed = true) {
  const finalize = jest.fn().mockResolvedValue({ id: invite.id, status: 'accepted' });
  const release = jest.fn().mockResolvedValue({ id: invite.id });
  const eligibility = {
    registerSignupEligibility: jest.fn(),
    assertSignupEligible: jest.fn().mockResolvedValue({ invite, claimed, finalize, release }),
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
  // Unused by auth.controller's signup() flow (it trusts eligibility.claimed, not this
  // flag — see invitations.init.js for where userFacing actually gets consulted); kept
  // here only because getConfig() reads it for the exposed `invitations.userFacing`
  // boolean, unrelated to the scenarios below.
  invitations: { userFacing: false },
});

describe('auth.controller signup: inviteHonored gate (#3981)', () => {
  test('closed signup + invite present, claimed:true (checker required it) ⇒ finalized', async () => {
    const { eligibility, finalize, release } = mockEligibilityWithInvite(undefined, true);
    mockCommonDeps({ config: baseConfig({ sign: { up: false } }), eligibility });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(finalize).toHaveBeenCalledWith('u1');
    expect(release).not.toHaveBeenCalled();
  });

  test('open signup + invite present, claimed:false (userFacing off — the checker never claimed) ⇒ NEVER finalized (today\'s behavior, byte-for-byte)', async () => {
    const { eligibility, finalize, release } = mockEligibilityWithInvite(undefined, false);
    mockCommonDeps({ config: baseConfig({ sign: { up: true } }), eligibility });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(finalize).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test('open signup + invite present, claimed:true (userFacing on — the checker DID claim) ⇒ FINALIZED (#3981 fix — the open-signup hole closes)', async () => {
    const { eligibility, finalize, release } = mockEligibilityWithInvite(undefined, true);
    mockCommonDeps({ config: baseConfig({ sign: { up: true } }), eligibility });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(finalize).toHaveBeenCalledWith('u1');
    expect(release).not.toHaveBeenCalled();
  });

  test('open signup + NO invite (no token presented, or checker resolved nothing) ⇒ plain signup, nothing to finalize', async () => {
    mockCommonDeps({
      config: baseConfig({ sign: { up: true } }),
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

  test('open signup + invite present, claimed:true + create() throws ⇒ claim is RELEASED', async () => {
    const { eligibility, release } = mockEligibilityWithInvite(undefined, true);
    const create = jest.fn().mockRejectedValue(new Error('E11000 duplicate key'));
    mockCommonDeps({ config: baseConfig({ sign: { up: true } }), eligibility, create });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(release).toHaveBeenCalledTimes(1);
  });

  test('open signup + invite present, claimed:false + create() throws ⇒ release is NEVER called (nothing was claimed)', async () => {
    const { eligibility, release } = mockEligibilityWithInvite(undefined, false);
    const create = jest.fn().mockRejectedValue(new Error('E11000 duplicate key'));
    mockCommonDeps({ config: baseConfig({ sign: { up: true } }), eligibility, create });

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(release).not.toHaveBeenCalled();
  });

  test('open signup + invite present, claimed:true + email-verification step throws ⇒ claim is RELEASED', async () => {
    const { eligibility, release } = mockEligibilityWithInvite(undefined, true);
    mockCommonDeps({ config: baseConfig({ sign: { up: true } }), eligibility });
    // Mailer configured ⇒ the verification-token branch runs; make the persist step
    // (UserService.update) throw so the outer try/catch's `verifyErr` path fires.
    jest.unstable_mockModule('../../../modules/users/services/users.service.js', () => ({
      default: {
        create: jest.fn().mockResolvedValue({ id: 'u1', email: 'x@y.com', firstName: 'A', lastName: 'B', provider: 'local' }),
        getBrut: jest.fn().mockResolvedValue({ id: 'u1' }),
        update: jest.fn().mockRejectedValue(new Error('DB write failed persisting verification token')),
        remove: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
    }));
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
      default: { isConfigured: jest.fn().mockReturnValue(true), sendMail: jest.fn() },
    }));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(release).toHaveBeenCalledTimes(1);
  });

  test('open signup + invite present, claimed:true + org-provisioning throws ⇒ claim is RELEASED', async () => {
    const { eligibility, release } = mockEligibilityWithInvite(undefined, true);
    mockCommonDeps({ config: baseConfig({ sign: { up: true } }), eligibility });
    jest.unstable_mockModule('../../../modules/organizations/services/organizations.service.js', () => ({
      default: {
        handleSignupOrganization: jest.fn().mockRejectedValue(new Error('org provisioning DB error')),
      },
    }));

    const { default: AuthController } = await import('../../../modules/auth/controllers/auth.controller.js');
    const req = { body: { email: 'x@y.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };
    const res = { status: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await AuthController.signup(req, res);

    expect(release).toHaveBeenCalledTimes(1);
  });

  test('capacity gate: open signup + invite claimed:true + cap reached ⇒ 404 AND the claim is released', async () => {
    const { eligibility, release } = mockEligibilityWithInvite(undefined, true);
    mockCommonDeps({
      config: baseConfig({ sign: { up: true, cap: 1 } }),
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
