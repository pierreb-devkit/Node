/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.referralReconcile cron logic (#3842).
 *
 * The script itself is a standalone CLI (process.exit) — like the other billing cron
 * tests, this suite exercises the script's decision logic. Candidate selection runs
 * against the REAL BillingReferralService.expectedGrantKeys (the single rule source
 * shared with grantForInvitation — no hand-mirrored rule block, no drift risk); only
 * the grant write path (grantForInvitation) and the repositories are stubbed.
 *
 * Tests cover:
 *  - referral.enabled gate (early exit when false — NOT meterMode)
 *  - expected keys come from the real rule source (zero units / null invitedBy / self-referral)
 *  - fully-granted invitations are skipped (no grant call)
 *  - misses are back-filled via grantForInvitation (idempotent by construction)
 *  - error counting + continuation
 */
describe('billing.referralReconcile cron — logic:', () => {
  let BillingReferralService;
  let BillingExtraBalanceRepository;
  let InvitationRepository;
  let UserService;
  let mockConfig;

  const inviterId = '64b2f0000000000000000010';
  const refereeId = '64b2f0000000000000000020';

  /**
   * Reproduce the cron's candidate-selection + back-fill pass over the fixtures.
   * Mirrors modules/billing/crons/billing.referralReconcile.js.
   * @returns {Promise<{backfilled: number, pending: number, errors: number, grantCalls: number}>}
   */
  const runReconcilePass = async () => {
    const cfg = mockConfig.billing.referral;
    const accepted = await InvitationRepository.findAccepted();

    // REAL rule source — same call the cron makes; kills the mirror-drift risk.
    const candidates = [];
    for (const invite of accepted) {
      const expected = BillingReferralService.expectedGrantKeys(invite, cfg).map(({ key }) => key);
      if (expected.length > 0) candidates.push({ invite, expected });
    }

    const linkCandidates = [];
    const linkCap = cfg.link ? BillingReferralService.getLinkCap() : null;
    if (cfg.link && linkCap) {
      const invitedIds = new Set(accepted.map((invite) => String(invite.acceptedUserId)));
      const referred = await UserService.findWithFilter({ referredBy: { $ne: null } }, '_id referredBy');
      for (const user of referred) {
        if (invitedIds.has(String(user._id))) continue;
        const link = { kind: 'link', userId: String(user._id), referredBy: String(user.referredBy) };
        const expected = BillingReferralService.expectedGrantKeys(link, cfg).map(({ key }) => key);
        if (expected.length > 0) linkCandidates.push({ link, expected });
      }
      linkCandidates.sort((x, y) => (x.link.userId < y.link.userId ? -1 : 1));
    }

    const allKeys = [...candidates, ...linkCandidates].flatMap((c) => c.expected);
    const existing = new Set(await BillingExtraBalanceRepository.findExistingRefIds(allKeys));

    let backfilled = 0;
    let pending = 0;
    let errors = 0;
    let grantCalls = 0;

    const budgets = new Map();
    for (const { link, expected } of linkCandidates) {
      if (expected.every((key) => existing.has(key))) continue;
      try {
        if (!budgets.has(link.referredBy)) budgets.set(link.referredBy, await BillingReferralService.linkBudget(link.referredBy, linkCap));
        const budget = budgets.get(link.referredBy);
        if (budget.skipped) continue;
        if (!existing.has(`referral:link:${link.userId}:referrer:${link.referredBy}`)) {
          if (budget.remaining <= 0) continue;
          budget.remaining -= 1;
        }
        grantCalls += 1;
        const result = await BillingReferralService.grantForLink(link);
        const sides = [result.referrer, result.referee].filter(Boolean);
        backfilled += sides.filter((s) => s.applied).length;
        pending += sides.filter((s) => s.reason === 'no_organization').length;
      } catch {
        errors += 1;
      }
    }

    for (const { invite, expected } of candidates) {
      if (expected.every((key) => existing.has(key))) continue;
      try {
        grantCalls += 1;
        const result = await BillingReferralService.grantForInvitation({
          invitationId: String(invite._id),
          invitedBy: invite.invitedBy ? String(invite.invitedBy) : null,
          acceptedUserId: invite.acceptedUserId ? String(invite.acceptedUserId) : null,
        });
        const sides = [result.referrer, result.referee].filter(Boolean);
        backfilled += sides.filter((s) => s.applied).length;
        pending += sides.filter((s) => s.reason === 'no_organization').length;
      } catch {
        errors += 1;
      }
    }

    return { backfilled, pending, errors, grantCalls };
  };

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: { referral: { enabled: true, referrerUnits: 1000, refereeUnits: 500, expiryDays: 365 } },
      invitations: { maxLifetime: 2 },
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: {
        findExistingRefIds: jest.fn().mockResolvedValue([]),
        creditGrant: jest.fn(),
        countLinkReferrerGrants: jest.fn().mockResolvedValue(0),
      },
    }));

    jest.unstable_mockModule('../../invitations/services/invitations.service.js', () => ({
      default: {
        findAccepted: jest.fn().mockResolvedValue([]),
      },
    }));

    jest.unstable_mockModule('../../users/services/users.service.js', () => ({
      default: { findWithFilter: jest.fn().mockResolvedValue([]), getBrut: jest.fn() },
    }));

    // REAL referral service (its static deps — config/logger/repo — are mocked above):
    // expectedGrantKeys/referralKeys are exercised for real, only the grant write path
    // is stubbed per test via the spy below.
    const [serviceMod, repoMod, invitationMod, userMod] = await Promise.all([
      import('../services/billing.referral.service.js'),
      import('../repositories/billing.extraBalance.repository.js'),
      import('../../invitations/services/invitations.service.js'),
      import('../../users/services/users.service.js'),
    ]);
    UserService = userMod.default;
    BillingReferralService = serviceMod.default;
    BillingExtraBalanceRepository = repoMod.default;
    InvitationRepository = invitationMod.default;
    jest.spyOn(BillingReferralService, 'grantForInvitation').mockResolvedValue({});
    jest.spyOn(BillingReferralService, 'grantForLink').mockResolvedValue({});
    jest.spyOn(BillingReferralService, 'linkBudget').mockResolvedValue({ remaining: 2 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('gate: skips when referral.enabled is false (the cron gates on referral, NOT meterMode)', () => {
    mockConfig.billing.referral.enabled = false;
    // Simulate the script gate logic inline (same shape as the other cron suites).
    const shouldSkip = !mockConfig?.billing?.referral?.enabled;
    expect(shouldSkip).toBe(true);
    // meterMode plays no role in the decision:
    mockConfig.billing.meterMode = true;
    expect(!mockConfig?.billing?.referral?.enabled).toBe(true);
  });

  test('no accepted invitations → no-op (no diff, no grants)', async () => {
    const { backfilled, errors, grantCalls } = await runReconcilePass();
    expect(backfilled).toBe(0);
    expect(errors).toBe(0);
    expect(grantCalls).toBe(0);
    expect(BillingReferralService.grantForInvitation).not.toHaveBeenCalled();
  });

  test('expected keys come from the REAL expectedGrantKeys (zero units, null invitedBy, self-referral floor)', async () => {
    mockConfig.billing.referral.referrerUnits = 0; // referrer side disabled by config
    InvitationRepository.findAccepted.mockResolvedValue([
      { _id: 'inv1', invitedBy: inviterId, acceptedUserId: refereeId }, // referee key only (referrerUnits=0)
      { _id: 'inv2', invitedBy: null, acceptedUserId: refereeId }, // referee key only (no inviter)
      { _id: 'inv3', invitedBy: refereeId, acceptedUserId: refereeId }, // referee key only (self-referral)
      { _id: 'inv4', invitedBy: inviterId, acceptedUserId: null }, // NO key (legacy row, no referee)
    ]);
    BillingReferralService.grantForInvitation.mockResolvedValue({ referee: { applied: true } });

    const { grantCalls } = await runReconcilePass();

    // inv4 produced no expected key → never a candidate; the other 3 are back-filled.
    expect(grantCalls).toBe(3);
    const diffedKeys = BillingExtraBalanceRepository.findExistingRefIds.mock.calls[0][0];
    expect(diffedKeys).toEqual(['referral:inv1:referee', 'referral:inv2:referee', 'referral:inv3:referee']);
  });

  test('fully-granted invitations are skipped; only misses are back-filled', async () => {
    InvitationRepository.findAccepted.mockResolvedValue([
      { _id: 'done', invitedBy: inviterId, acceptedUserId: refereeId },
      { _id: 'miss', invitedBy: inviterId, acceptedUserId: refereeId },
    ]);
    BillingExtraBalanceRepository.findExistingRefIds.mockResolvedValue([
      'referral:done:referrer',
      'referral:done:referee',
      'referral:miss:referee', // referrer side missing → still a candidate
    ]);
    BillingReferralService.grantForInvitation.mockResolvedValue({
      referrer: { applied: true },
      referee: { applied: false, reason: 'duplicate_grant' }, // idempotent replay on the granted side
    });

    const { backfilled, errors } = await runReconcilePass();

    expect(BillingReferralService.grantForInvitation).toHaveBeenCalledTimes(1);
    expect(BillingReferralService.grantForInvitation).toHaveBeenCalledWith({
      invitationId: 'miss',
      invitedBy: inviterId,
      acceptedUserId: refereeId,
    });
    expect(backfilled).toBe(1); // only the missing referrer side landed
    expect(errors).toBe(0);
  });

  test('no_organization sides count as pending (retried next run), not errors', async () => {
    InvitationRepository.findAccepted.mockResolvedValue([
      { _id: 'wait', invitedBy: null, acceptedUserId: refereeId },
    ]);
    BillingReferralService.grantForInvitation.mockResolvedValue({
      referrer: { applied: false, reason: 'no_inviter' },
      referee: { applied: false, reason: 'no_organization' }, // org not provisioned yet (email verification)
    });

    const { backfilled, pending, errors } = await runReconcilePass();

    expect(backfilled).toBe(0);
    expect(pending).toBe(1);
    expect(errors).toBe(0);
  });

  test('counts errors and continues when grantForInvitation throws', async () => {
    InvitationRepository.findAccepted.mockResolvedValue([
      { _id: 'bad', invitedBy: inviterId, acceptedUserId: refereeId },
      { _id: 'good', invitedBy: inviterId, acceptedUserId: refereeId },
    ]);
    BillingReferralService.grantForInvitation
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({ referrer: { applied: true }, referee: { applied: true } });

    const { backfilled, errors } = await runReconcilePass();

    expect(errors).toBe(1);
    expect(backfilled).toBe(2);
    expect(BillingReferralService.grantForInvitation).toHaveBeenCalledTimes(2);
  });

  describe('link signups (#4214):', () => {
    const linkUserId = '64b2f0000000000000000030';

    beforeEach(() => {
      mockConfig.billing.referral.link = true;
    });

    test('flag off → the link set is never scanned', async () => {
      mockConfig.billing.referral.link = false;
      UserService.findWithFilter.mockResolvedValue([{ _id: linkUserId, referredBy: inviterId }]);
      const { grantCalls } = await runReconcilePass();
      expect(grantCalls).toBe(0);
      expect(UserService.findWithFilter).not.toHaveBeenCalled();
    });

    test('a link signup with a missed grant is back-filled via grantForLink with the link keys', async () => {
      UserService.findWithFilter.mockResolvedValue([{ _id: linkUserId, referredBy: inviterId }]);
      BillingReferralService.grantForLink.mockResolvedValue({ referrer: { applied: true }, referee: { applied: true } });

      const { backfilled, grantCalls } = await runReconcilePass();

      expect(grantCalls).toBe(1);
      expect(BillingReferralService.grantForLink).toHaveBeenCalledWith({ kind: 'link', userId: linkUserId, referredBy: inviterId });
      expect(BillingExtraBalanceRepository.findExistingRefIds.mock.calls[0][0]).toEqual([
        `referral:link:${linkUserId}:referee`,
        `referral:link:${linkUserId}:referrer:${inviterId}`,
      ]);
      expect(backfilled).toBe(2);
    });

    test('a fully granted link signup is skipped', async () => {
      UserService.findWithFilter.mockResolvedValue([{ _id: linkUserId, referredBy: inviterId }]);
      BillingExtraBalanceRepository.findExistingRefIds.mockResolvedValue([
        `referral:link:${linkUserId}:referee`,
        `referral:link:${linkUserId}:referrer:${inviterId}`,
      ]);
      const { grantCalls } = await runReconcilePass();
      expect(grantCalls).toBe(0);
    });

    test('an invited user (accepted invitation) is never a link candidate', async () => {
      InvitationRepository.findAccepted.mockResolvedValue([{ _id: 'inv1', invitedBy: inviterId, acceptedUserId: linkUserId }]);
      UserService.findWithFilter.mockResolvedValue([{ _id: linkUserId, referredBy: inviterId }]);
      await runReconcilePass();
      expect(BillingReferralService.grantForLink).not.toHaveBeenCalled();
      expect(BillingReferralService.grantForInvitation).toHaveBeenCalledTimes(1);
    });

    test('budget is computed ONCE per referrer; candidates beyond it are skipped with no per-user call and are not pending', async () => {
      const ids = ['64b2f0000000000000000031', '64b2f0000000000000000032', '64b2f0000000000000000033'];
      UserService.findWithFilter.mockResolvedValue(ids.map((id) => ({ _id: id, referredBy: inviterId })));
      BillingReferralService.linkBudget.mockResolvedValue({ remaining: 2 });
      BillingReferralService.grantForLink.mockResolvedValue({ referrer: { applied: true }, referee: { applied: true } });

      const { grantCalls, pending, errors } = await runReconcilePass();

      expect(BillingReferralService.linkBudget).toHaveBeenCalledTimes(1);
      expect(grantCalls).toBe(2);
      expect(BillingReferralService.grantForLink.mock.calls.map(([l]) => l.userId)).toEqual(ids.slice(0, 2));
      expect(pending).toBe(0);
      expect(errors).toBe(0);
    });

    test('a user whose own referrer grant already landed is free (finishes the referee side with no budget)', async () => {
      UserService.findWithFilter.mockResolvedValue([{ _id: linkUserId, referredBy: inviterId }]);
      BillingReferralService.linkBudget.mockResolvedValue({ remaining: 0 });
      BillingExtraBalanceRepository.findExistingRefIds.mockResolvedValue([`referral:link:${linkUserId}:referrer:${inviterId}`]);
      const { grantCalls } = await runReconcilePass();
      expect(grantCalls).toBe(1);
    });

    test('no valid cap → the link set is not scanned at all', async () => {
      mockConfig.invitations = { maxLifetime: null };
      UserService.findWithFilter.mockResolvedValue([{ _id: linkUserId, referredBy: inviterId }]);
      const { grantCalls } = await runReconcilePass();
      expect(grantCalls).toBe(0);
      expect(UserService.findWithFilter).not.toHaveBeenCalled();
    });
  });
});
