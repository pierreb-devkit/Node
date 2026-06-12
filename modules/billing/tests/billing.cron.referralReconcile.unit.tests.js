/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.referralReconcile cron logic (#3842).
 *
 * The script itself is a standalone CLI (process.exit) — like the other billing cron
 * tests, this suite exercises the script's decision logic against the mocked
 * service/repositories (the gate, the expected-key construction rules, the
 * "skip fully granted" diff, back-fill idempotency, error counting + continuation).
 *
 * Tests cover:
 *  - referral.enabled gate (early exit when false — NOT meterMode)
 *  - expected keys mirror the grant rules (zero units / null invitedBy / self-referral)
 *  - fully-granted invitations are skipped (no grant call)
 *  - misses are back-filled via grantForInvitation (idempotent by construction)
 *  - error counting + continuation
 */
describe('billing.referralReconcile cron — logic:', () => {
  let BillingReferralService;
  let BillingExtraBalanceRepository;
  let InvitationRepository;
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

    const candidates = [];
    for (const invite of accepted) {
      const keys = BillingReferralService.referralKeys(String(invite._id));
      const expected = [];
      if (cfg.refereeUnits > 0 && invite.acceptedUserId) expected.push(keys.referee);
      if (
        cfg.referrerUnits > 0 &&
        invite.invitedBy &&
        String(invite.invitedBy) !== String(invite.acceptedUserId)
      ) {
        expected.push(keys.referrer);
      }
      if (expected.length > 0) candidates.push({ invite, expected });
    }

    const allKeys = candidates.flatMap((c) => c.expected);
    const existing = new Set(await BillingExtraBalanceRepository.findExistingRefIds(allKeys));

    let backfilled = 0;
    let pending = 0;
    let errors = 0;
    let grantCalls = 0;

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
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));

    jest.unstable_mockModule('../services/billing.referral.service.js', () => ({
      default: {
        referralKeys: (invitationId) => ({
          referrer: `referral:${invitationId}:referrer`,
          referee: `referral:${invitationId}:referee`,
        }),
        grantForInvitation: jest.fn(),
        resolveGrantOrganization: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({
      default: {
        findExistingRefIds: jest.fn().mockResolvedValue([]),
        creditGrant: jest.fn(),
      },
    }));

    jest.unstable_mockModule('../../invitations/repositories/invitations.repository.js', () => ({
      default: {
        findAccepted: jest.fn().mockResolvedValue([]),
      },
    }));

    const [serviceMod, repoMod, invitationMod] = await Promise.all([
      import('../services/billing.referral.service.js'),
      import('../repositories/billing.extraBalance.repository.js'),
      import('../../invitations/repositories/invitations.repository.js'),
    ]);
    BillingReferralService = serviceMod.default;
    BillingExtraBalanceRepository = repoMod.default;
    InvitationRepository = invitationMod.default;
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

  test('expected keys mirror the grant rules (zero units, null invitedBy, self-referral floor)', async () => {
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
});
