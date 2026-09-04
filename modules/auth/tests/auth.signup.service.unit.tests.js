/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

/**
 * Unit tests — auth.signup.service.js (issue #3995).
 *
 * Direct unit coverage for gates that, before the extraction, could only be
 * exercised through an HTTP round-trip via auth.controller.signup:
 *   - capacity rejection
 *   - invite release on the capacity gate
 *   - invite release on organization-provisioning failure
 *   - no auto-verify for an invited account when the mailer is off
 *   - finalize ordering (after organization provisioning, last pre-response step)
 *
 * No DB, no HTTP — every leaf dependency (UserService, the eligibility
 * registry, AuthOrganizationService, mailer, analytics, logger) is mocked.
 * computeSignupCapacity is left real (pure function, no external deps) so
 * only UserService.count needs to be controlled per scenario.
 */

/**
 * @desc Register every auth.signup.service dependency EXCEPT config/eligibility,
 * which are supplied per test so each scenario can vary sign.up/cap/invite
 * outcome. Must run before the dynamic import of auth.signup.service.js in
 * each test (jest.resetModules() + jest.unstable_mockModule are call-order
 * sensitive).
 * @param {Object} args
 * @param {Object} args.config - the mocked config module default export
 * @param {Object} [args.eligibility] - the mocked auth.eligibility default export
 * @param {Function} [args.create] - UserService.create mock implementation
 * @param {Function} [args.getBrut] - UserService.getBrut mock implementation
 * @param {Function} [args.update] - UserService.update mock implementation
 * @param {Function} [args.remove] - UserService.remove mock implementation
 * @param {Function} [args.count] - UserService.count mock implementation
 * @param {Function} [args.handleSignupOrganization] - AuthOrganizationService.handleSignupOrganization mock implementation
 * @param {boolean} [args.mailerConfigured=false] - mails.isConfigured() return value
 * @returns {void}
 */
function mockSignupServiceDeps({
  config,
  eligibility,
  create,
  getBrut,
  update,
  remove,
  count,
  handleSignupOrganization,
  mailerConfigured = false,
}) {
  jest.resetModules();

  jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
    default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  }));

  jest.unstable_mockModule('../../../config/index.js', () => ({ default: config }));

  jest.unstable_mockModule('../../users/services/users.service.js', () => ({
    default: {
      create: create || jest.fn().mockResolvedValue({
        id: 'u1', email: 'x@y.com', firstName: 'A', lastName: 'B', provider: 'local', emailVerified: false,
      }),
      getBrut: getBrut || jest.fn().mockResolvedValue({ id: 'u1' }),
      update: update || jest.fn().mockResolvedValue({}),
      remove: remove || jest.fn().mockResolvedValue({}),
      count: count || jest.fn().mockResolvedValue(0),
    },
  }));

  jest.unstable_mockModule('../services/auth.eligibility.js', () => ({
    default: eligibility || {
      assertSignupEligible: jest.fn().mockResolvedValue(undefined),
    },
  }));

  jest.unstable_mockModule('../../organizations/services/organizations.service.js', () => ({
    default: {
      handleSignupOrganization: handleSignupOrganization || jest.fn().mockResolvedValue({
        organization: null, abilities: [], emailVerificationRequired: false,
      }),
    },
  }));

  jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({
    default: {
      isConfigured: jest.fn().mockReturnValue(mailerConfigured),
      sendMail: jest.fn().mockResolvedValue({ accepted: ['x@y.com'] }),
    },
  }));

  jest.unstable_mockModule('../../../lib/services/analytics.js', () => ({
    default: {
      identify: jest.fn(),
      capture: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(false),
    },
  }));

  jest.unstable_mockModule('../../../lib/helpers/getBaseUrl.js', () => ({
    default: jest.fn().mockReturnValue('http://localhost:3000'),
  }));
}

const baseConfig = (overrides = {}) => ({
  sign: { up: true, ...overrides.sign },
  app: { title: 'Test', contact: 'test@test.com' },
});

/**
 * @desc Build a mocked eligibility default export carrying a resolved invite,
 * the `claimed` flag, and spy-able finalize/release closures — mirrors the
 * shape the invitations checker returns (see auth.signup.inviteHonored.unit.tests.js).
 * @param {Object} [invite] - resolved invite doc
 * @param {Boolean} [claimed] - whether the checker actually claimed this invite
 * @returns {{ eligibility: Object, finalize: jest.Mock, release: jest.Mock }}
 */
function mockEligibilityWithInvite(invite = { id: 'inv1', email: 'invitee@test.com', invitedBy: 'inviter1' }, claimed = true) {
  const finalize = jest.fn().mockResolvedValue({ id: invite.id, status: 'accepted' });
  const release = jest.fn().mockResolvedValue({ id: invite.id });
  const eligibility = {
    assertSignupEligible: jest.fn().mockResolvedValue({ invite, claimed, finalize, release }),
  };
  return { eligibility, finalize, release };
}

describe('auth.signup.service — capacity gate (#3995)', () => {
  test('rejects with SIGNUP_DISABLED when the cap is reached, and never calls UserService.create', async () => {
    const create = jest.fn();
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: true, cap: 1 } }),
      count: jest.fn().mockResolvedValue(1), // remaining = cap(1) - count(1) = 0 ⇒ capReached
      create,
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'new@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: {} };

    await expect(SignupService.signup(req)).rejects.toMatchObject({
      code: 'SIGNUP_DISABLED',
      status: 404,
      details: { message: 'Registration is currently deactivated' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('a claimed invite release on the capacity gate is AWAITED before the rejection is returned, and a release failure is swallowed', async () => {
    // A call-count assertion alone can't see a dropped `await` — the release()
    // call still happens, it's just not waited on. Make the mock settle on a
    // LATER tick (and reject) so a missing `await` shows up as a timing gap:
    // with the await in place, `releaseSettled` must already be true by the
    // time signup() rejects. Rejecting with `orgErr`'s sibling here — SIGNUP_
    // DISABLED, not the release() error — also proves the failure is swallowed
    // rather than escaping (mirrors billing's own `setImmediate` tick-flush
    // idiom, see modules/billing/tests/billing.init.ops-listeners.unit.tests.js).
    let releaseSettled = false;
    const release = jest.fn().mockImplementation(() => new Promise((_resolve, reject) => {
      setImmediate(() => {
        releaseSettled = true;
        reject(new Error('release failed'));
      });
    }));
    const finalize = jest.fn();
    const eligibility = {
      assertSignupEligible: jest.fn().mockResolvedValue({
        invite: { id: 'inv1', email: 'invitee@test.com', invitedBy: 'inviter1' },
        claimed: true,
        finalize,
        release,
      }),
    };
    const create = jest.fn();
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: true, cap: 1 } }),
      count: jest.fn().mockResolvedValue(1),
      eligibility,
      create,
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'invitee@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };

    await expect(SignupService.signup(req)).rejects.toMatchObject({ code: 'SIGNUP_DISABLED' });
    // Snapshot BEFORE flushing — a mutant's dangling (unawaited) release()
    // promise would otherwise settle during the flush below and paper over
    // the missing await.
    const releaseSettledAtThrow = releaseSettled;
    await new Promise((resolve) => setImmediate(resolve));

    expect(releaseSettledAtThrow).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test('an UNCLAIMED (presented-only) invite is NOT released when the capacity gate rejects the signup', async () => {
    const { eligibility, finalize, release } = mockEligibilityWithInvite(undefined, false);
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: true, cap: 1 } }),
      count: jest.fn().mockResolvedValue(1),
      eligibility,
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'invitee@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };

    await expect(SignupService.signup(req)).rejects.toMatchObject({ code: 'SIGNUP_DISABLED' });
    expect(release).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe('auth.signup.service — organization-provisioning failure (#3995)', () => {
  test('a NON-invited signup awaits UserService.remove() on rollback (no invite path to mask a missing await), and removes the exact created user', async () => {
    // Isolation matters here: with no invite in play there is nothing else to
    // await after remove() before the throw. In the invited scenario below,
    // the SUBSEQUENT `await release()` would pump the event loop long enough
    // for an earlier, unawaited remove() to also settle — masking a missing
    // `await` on remove() specifically. This scenario is the only one that
    // isolates it.
    const createdUser = {
      id: 'org-fail-user-42', email: 'self@test.com', firstName: 'A', lastName: 'B', provider: 'local', emailVerified: false,
    };
    const create = jest.fn().mockResolvedValue(createdUser);
    const orgErr = new Error('org provisioning DB error');
    let removeSettled = false;
    const remove = jest.fn().mockImplementation(() => new Promise((_resolve, reject) => {
      setImmediate(() => {
        removeSettled = true;
        reject(new Error('remove failed'));
      });
    }));
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: true } }), // public signup, no invite
      create,
      remove,
      handleSignupOrganization: jest.fn().mockRejectedValue(orgErr),
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'self@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: {} };

    // Rejecting with `orgErr` (not remove()'s own error) proves the rollback
    // failure is swallowed rather than escaping.
    await expect(SignupService.signup(req)).rejects.toBe(orgErr);
    const removeSettledAtThrow = removeSettled;
    await new Promise((resolve) => setImmediate(resolve));

    expect(removeSettledAtThrow).toBe(true);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-fail-user-42' }));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('an invited signup rolls back in order — remove() strictly BEFORE release(), both awaited — and targets the created user', async () => {
    const createdUser = {
      id: 'org-fail-invited-user-7', email: 'invitee@test.com', firstName: 'A', lastName: 'B', provider: 'local', emailVerified: false,
    };
    const create = jest.fn().mockResolvedValue(createdUser);
    const orgErr = new Error('org provisioning DB error');
    const order = [];
    const remove = jest.fn().mockImplementation(() => new Promise((resolve) => {
      setImmediate(() => { order.push('remove'); resolve({}); });
    }));
    let releaseSettled = false;
    const release = jest.fn().mockImplementation(() => new Promise((_resolve, reject) => {
      setImmediate(() => {
        order.push('release');
        releaseSettled = true;
        reject(new Error('release failed'));
      });
    }));
    const finalize = jest.fn();
    const eligibility = {
      assertSignupEligible: jest.fn().mockResolvedValue({
        invite: { id: 'inv1', email: 'invitee@test.com', invitedBy: 'inviter1' },
        claimed: true,
        finalize,
        release,
      }),
    };
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: false } }),
      eligibility,
      create,
      remove,
      handleSignupOrganization: jest.fn().mockRejectedValue(orgErr),
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'invitee@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };

    await expect(SignupService.signup(req)).rejects.toBe(orgErr);
    // Snapshot BEFORE flushing (see the capacity-gate test above for why).
    const orderAtThrow = [...order];
    const releaseSettledAtThrow = releaseSettled;
    await new Promise((resolve) => setImmediate(resolve));

    expect(orderAtThrow).toEqual(['remove', 'release']);
    expect(releaseSettledAtThrow).toBe(true);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-fail-invited-user-7' }));
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe('auth.signup.service — invited signup + mailer off does NOT auto-verify (#3995)', () => {
  test('an invited account is NOT auto-verified when the mailer is unconfigured (unlike a plain signup)', async () => {
    const createdUser = {
      id: 'u1', email: 'invitee@test.com', firstName: 'A', lastName: 'B', provider: 'local', emailVerified: false,
    };
    const update = jest.fn().mockResolvedValue({});
    const { eligibility } = mockEligibilityWithInvite();
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: false } }),
      eligibility,
      create: jest.fn().mockResolvedValue(createdUser),
      update,
      mailerConfigured: false,
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'invitee@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };

    const { user } = await SignupService.signup(req);

    // No emailVerified:true persist for an invited account — the token proves the
    // INVITER knew the address, not that the SIGNER controls it (E6).
    expect(update).not.toHaveBeenCalled();
    expect(user.emailVerified).toBe(false);
  });

  test('control: a NON-invited (plain) signup DOES auto-verify when the mailer is unconfigured, looking up the ACTUAL created user', async () => {
    const createdUser = {
      id: 'u2', email: 'self@test.com', firstName: 'C', lastName: 'D', provider: 'local', emailVerified: false,
    };
    // A getBrut mock that returns a fixed value for ANY argument hides a
    // lookup of the wrong user — assert on the call ARGUMENT instead, which
    // is what actually identifies which account gets auto-verified.
    const brutUser = { id: 'u2', _brut: true };
    const getBrut = jest.fn().mockResolvedValue(brutUser);
    const update = jest.fn().mockResolvedValue({});
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: true } }),
      create: jest.fn().mockResolvedValue(createdUser),
      getBrut,
      update,
      mailerConfigured: false,
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'self@test.com', firstName: 'C', lastName: 'D', password: 'P@ss1234!' }, query: {} };

    const { user } = await SignupService.signup(req);

    expect(getBrut).toHaveBeenCalledWith({ id: 'u2' });
    expect(update).toHaveBeenCalledWith(brutUser, { emailVerified: true }, 'recover');
    expect(user.emailVerified).toBe(true);
  });
});

describe('auth.signup.service — invite finalize ordering (#3995)', () => {
  test('finalize runs strictly AFTER organization provisioning and is the last pre-response step', async () => {
    const order = [];
    const { eligibility, finalize } = mockEligibilityWithInvite();
    finalize.mockImplementation(async () => {
      order.push('finalize');
      return { id: 'inv1', status: 'accepted' };
    });
    const handleSignupOrganization = jest.fn().mockImplementation(async () => {
      order.push('organization');
      return { organization: { id: 'org1' }, abilities: [], emailVerificationRequired: false };
    });
    mockSignupServiceDeps({
      config: baseConfig({ sign: { up: false } }),
      eligibility,
      handleSignupOrganization,
    });

    const { default: SignupService } = await import('../services/auth.signup.service.js');
    const req = { body: { email: 'invitee@test.com', firstName: 'A', lastName: 'B', password: 'P@ss1234!' }, query: { inviteToken: 'tok' } };

    const { orgResult } = await SignupService.signup(req);

    expect(order).toEqual(['organization', 'finalize']);
    // The response block reads the organization result — not just {user, invite}.
    expect(orgResult.organization).toEqual({ id: 'org1' });
  });
});
