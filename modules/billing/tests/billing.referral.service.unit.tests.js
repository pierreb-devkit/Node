/**
 * Module dependencies.
 */
import { jest, describe, test, beforeEach, afterEach, expect } from '@jest/globals';

/**
 * Unit tests for billing.referral.service (#3842) — the standard referral grant.
 *
 * Covers:
 *  - config gate (disabled → no-op, no repository calls)
 *  - both grants with the correct units / idempotency keys / source / expiry
 *  - invitedBy null → referee only
 *  - invitedBy === acceptedUserId → referrer skipped (self-referral floor)
 *  - zero configured units → side skipped
 *  - no organization resolvable → side left to the reconcile cron
 *  - membership fallback when currentOrganization is unset
 *  - idempotent replay (duplicate_grant surfaces, never double-credits)
 */
describe('billing.referral.service unit tests:', () => {
  let BillingReferralService;
  let mockConfig;
  let mockRepository;
  let mockUserService;
  let mockMembershipRepository;
  let mockLogger;

  const invitationId = '64b2f0000000000000000001';
  const inviterId = '64b2f0000000000000000010';
  const refereeId = '64b2f0000000000000000020';
  const inviterOrgId = '507f1f77bcf86cd799439011';
  const refereeOrgId = '507f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      billing: {
        referral: { enabled: true, referrerUnits: 1000, refereeUnits: 500, expiryDays: 365 },
      },
    };

    mockRepository = {
      creditGrant: jest.fn().mockResolvedValue({ doc: {}, applied: true }),
      findExistingRefIds: jest.fn().mockResolvedValue([]),
    };

    // Users keyed by id — getBrut({ id }) resolves from this map.
    const users = {
      [inviterId]: { _id: inviterId, currentOrganization: inviterOrgId },
      [refereeId]: { _id: refereeId, currentOrganization: refereeOrgId },
    };
    mockUserService = {
      getBrut: jest.fn(({ id }) => Promise.resolve(users[id] ?? null)),
      _users: users,
    };

    mockMembershipRepository = { findOne: jest.fn().mockResolvedValue(null) };
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({ default: mockRepository }));
    jest.unstable_mockModule('../../users/services/users.service.js', () => ({ default: mockUserService }));
    jest.unstable_mockModule('../../organizations/repositories/organizations.membership.repository.js', () => ({
      default: mockMembershipRepository,
    }));
    jest.unstable_mockModule('../../organizations/lib/constants.js', () => ({
      MEMBERSHIP_STATUSES: { ACTIVE: 'active', PENDING: 'pending' },
    }));

    const mod = await import('../services/billing.referral.service.js');
    BillingReferralService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('referralKeys builds the referrer/referee idempotency keys from the invitationId', () => {
    expect(BillingReferralService.referralKeys(invitationId)).toEqual({
      referrer: `referral:${invitationId}:referrer`,
      referee: `referral:${invitationId}:referee`,
    });
  });

  test('disabled → no-op: returns skipped and never touches the ledger or users', async () => {
    mockConfig.billing.referral.enabled = false;

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result).toEqual({ skipped: 'disabled' });
    expect(mockRepository.creditGrant).not.toHaveBeenCalled();
    expect(mockUserService.getBrut).not.toHaveBeenCalled();
  });

  test('missing referral config block behaves as disabled (existing deployments unaffected)', async () => {
    delete mockConfig.billing.referral;

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result).toEqual({ skipped: 'disabled' });
    expect(mockRepository.creditGrant).not.toHaveBeenCalled();
  });

  test('enabled → grants BOTH sides with the correct org / units / keys / source / expiry', async () => {
    const before = Date.now();
    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result.referee).toMatchObject({ applied: true, organizationId: refereeOrgId });
    expect(result.referrer).toMatchObject({ applied: true, organizationId: inviterOrgId });
    expect(mockRepository.creditGrant).toHaveBeenCalledTimes(2);

    const calls = mockRepository.creditGrant.mock.calls;
    const refereeCall = calls.find(([, , , opts]) => opts.refId === `referral:${invitationId}:referee`);
    const referrerCall = calls.find(([, , , opts]) => opts.refId === `referral:${invitationId}:referrer`);
    expect(refereeCall).toEqual([refereeOrgId, 500, 'referral', expect.objectContaining({ refId: `referral:${invitationId}:referee` })]);
    expect(referrerCall).toEqual([inviterOrgId, 1000, 'referral', expect.objectContaining({ refId: `referral:${invitationId}:referrer` })]);

    // Expiry mirrors the pack expiryDays mechanism: now + 365d (small clock tolerance).
    const expected = 365 * 24 * 60 * 60 * 1000;
    for (const [, , , opts] of calls) {
      expect(opts.expiresAt).toBeInstanceOf(Date);
      const delta = opts.expiresAt.getTime() - before;
      expect(delta).toBeGreaterThanOrEqual(expected - 5000);
      expect(delta).toBeLessThanOrEqual(expected + 5000);
    }
  });

  test('expiryDays null → grants never expire (expiresAt null)', async () => {
    mockConfig.billing.referral.expiryDays = null;

    await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    for (const [, , , opts] of mockRepository.creditGrant.mock.calls) {
      expect(opts.expiresAt).toBeNull();
    }
  });

  test('invitedBy null → referee grant only, referrer skipped with no_inviter', async () => {
    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: null, acceptedUserId: refereeId });

    expect(result.referrer).toEqual({ applied: false, reason: 'no_inviter' });
    expect(result.referee).toMatchObject({ applied: true, organizationId: refereeOrgId });
    expect(mockRepository.creditGrant).toHaveBeenCalledTimes(1);
    expect(mockRepository.creditGrant.mock.calls[0][3].refId).toBe(`referral:${invitationId}:referee`);
  });

  test('invitedBy === acceptedUserId → referrer skipped (self-referral floor), referee still granted', async () => {
    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: refereeId, acceptedUserId: refereeId });

    expect(result.referrer).toEqual({ applied: false, reason: 'self_referral' });
    expect(result.referee).toMatchObject({ applied: true });
    expect(mockRepository.creditGrant).toHaveBeenCalledTimes(1);
  });

  test('zero configured units skip the side without resolving the user', async () => {
    mockConfig.billing.referral.refereeUnits = 0;
    mockConfig.billing.referral.referrerUnits = 0;

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result.referee).toEqual({ applied: false, reason: 'zero_units' });
    expect(result.referrer).toEqual({ applied: false, reason: 'zero_units' });
    expect(mockRepository.creditGrant).not.toHaveBeenCalled();
  });

  test('actor without any organization → side skipped with no_organization (left to the cron)', async () => {
    mockUserService._users[refereeId] = { _id: refereeId, currentOrganization: null };
    mockMembershipRepository.findOne.mockResolvedValue(null);

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result.referee).toEqual({ applied: false, reason: 'no_organization' });
    // The referrer side is unaffected.
    expect(result.referrer).toMatchObject({ applied: true, organizationId: inviterOrgId });
    expect(mockRepository.creditGrant).toHaveBeenCalledTimes(1);
  });

  test('currentOrganization unset → falls back to the user active membership', async () => {
    mockUserService._users[refereeId] = { _id: refereeId, currentOrganization: null };
    mockMembershipRepository.findOne.mockResolvedValue({ organizationId: { _id: refereeOrgId, name: 'Org' } });

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: null, acceptedUserId: refereeId });

    expect(mockMembershipRepository.findOne).toHaveBeenCalledWith({ userId: refereeId, status: 'active' });
    expect(result.referee).toMatchObject({ applied: true, organizationId: refereeOrgId });
  });

  test('idempotent replay: duplicate_grant from the repository surfaces as applied:false (no double-credit, no throw)', async () => {
    mockRepository.creditGrant.mockResolvedValue({ doc: null, applied: false, reason: 'duplicate_grant' });

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result.referee).toMatchObject({ applied: false, reason: 'duplicate_grant' });
    expect(result.referrer).toMatchObject({ applied: false, reason: 'duplicate_grant' });
    // Two guarded calls happened, both no-ops — the atomic refId guard did the dedup.
    expect(mockRepository.creditGrant).toHaveBeenCalledTimes(2);
  });

  test('missing invitationId → skipped (no idempotency root, never grant unkeyed)', async () => {
    const result = await BillingReferralService.grantForInvitation({ invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result).toEqual({ skipped: 'no_invitation_id' });
    expect(mockRepository.creditGrant).not.toHaveBeenCalled();
  });
});
