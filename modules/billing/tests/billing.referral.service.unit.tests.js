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
  let mockMembershipService;
  let mockInvitationsService;
  let mockLogger;
  let mockMailer;

  const invitationId = '64b2f0000000000000000001';
  const inviterId = '64b2f0000000000000000010';
  const refereeId = '64b2f0000000000000000020';
  const inviterOrgId = '507f1f77bcf86cd799439011';
  const refereeOrgId = '507f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockConfig = {
      app: { title: 'Test App' },
      billing: {
        referral: { enabled: true, referrerUnits: 1000, refereeUnits: 500, expiryDays: 365 },
      },
    };

    mockRepository = {
      creditGrant: jest.fn().mockResolvedValue({ doc: {}, applied: true }),
      findExistingRefIds: jest.fn().mockResolvedValue([]),
      countLinkReferrerGrants: jest.fn().mockResolvedValue(0),
    };

    // Users keyed by id — getBrut({ id }) resolves from this map.
    const users = {
      [inviterId]: { _id: inviterId, currentOrganization: inviterOrgId, email: 'inviter@example.com', firstName: 'In', lastName: 'Viter' },
      [refereeId]: { _id: refereeId, currentOrganization: refereeOrgId },
    };
    mockUserService = {
      getBrut: jest.fn(({ id }) => Promise.resolve(users[id] ?? null)),
      count: jest.fn().mockResolvedValue(0),
      _users: users,
    };

    mockInvitationsService = { findByAcceptedUserId: jest.fn().mockResolvedValue(null) };
    mockMembershipService = { findFirstActiveByUser: jest.fn().mockResolvedValue(null) };
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    // Mailer OFF by default (matches the mailer.isConfigured() gate default in most
    // deployments) — tests that need to assert notifyReferrer's email flip it ON.
    mockMailer = {
      isConfigured: jest.fn().mockReturnValue(false),
      sendMail: jest.fn().mockResolvedValue({}),
      getBrand: jest.fn().mockReturnValue({ name: 'Test App' }),
    };

    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    jest.unstable_mockModule('../../../lib/services/logger.js', () => ({ default: mockLogger }));
    jest.unstable_mockModule('../../../lib/helpers/mailer/index.js', () => ({ default: mockMailer }));
    jest.unstable_mockModule('../repositories/billing.extraBalance.repository.js', () => ({ default: mockRepository }));
    jest.unstable_mockModule('../../users/services/users.service.js', () => ({ default: mockUserService }));
    jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
      default: mockMembershipService,
    }));
    jest.unstable_mockModule('../../invitations/services/invitations.service.js', () => ({
      default: mockInvitationsService,
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

  describe('expectedGrantKeys — the single rule source shared with the reconcile cron:', () => {
    test('standard invite → both sides as [{ side, key }] (referee first, like the grant order)', () => {
      const cfg = mockConfig.billing.referral;
      // Accepts an invitation doc (_id) AND the accepted-event payload (invitationId) — same result.
      const expected = [
        { side: 'referee', key: `referral:${invitationId}:referee` },
        { side: 'referrer', key: `referral:${invitationId}:referrer` },
      ];
      expect(BillingReferralService.expectedGrantKeys({ _id: invitationId, invitedBy: inviterId, acceptedUserId: refereeId }, cfg)).toEqual(expected);
      expect(BillingReferralService.expectedGrantKeys({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId }, cfg)).toEqual(expected);
    });

    test('side rules: zero units / null invitedBy / self-referral / disabled / no id drop entries', () => {
      const cfg = mockConfig.billing.referral;
      const invite = { _id: invitationId, invitedBy: inviterId, acceptedUserId: refereeId };

      // referrerUnits 0 → referee side only.
      expect(BillingReferralService.expectedGrantKeys(invite, { ...cfg, referrerUnits: 0 }))
        .toEqual([{ side: 'referee', key: `referral:${invitationId}:referee` }]);
      // Actor-less invite → no referrer key.
      expect(BillingReferralService.expectedGrantKeys({ ...invite, invitedBy: null }, cfg))
        .toEqual([{ side: 'referee', key: `referral:${invitationId}:referee` }]);
      // Self-referral floor → no referrer key.
      expect(BillingReferralService.expectedGrantKeys({ ...invite, invitedBy: refereeId }, cfg))
        .toEqual([{ side: 'referee', key: `referral:${invitationId}:referee` }]);
      // Legacy row without a referee → no referee key.
      expect(BillingReferralService.expectedGrantKeys({ ...invite, acceptedUserId: null }, cfg))
        .toEqual([{ side: 'referrer', key: `referral:${invitationId}:referrer` }]);
      // Disabled config / missing id → no keys at all.
      expect(BillingReferralService.expectedGrantKeys(invite, { ...cfg, enabled: false })).toEqual([]);
      expect(BillingReferralService.expectedGrantKeys({ invitedBy: inviterId, acceptedUserId: refereeId }, cfg)).toEqual([]);
    });

    test('#3833 belt: a SAME-account self-referral pair implies NO referrer key (listener AND cron derive from this one rule; alias multi-account self-invites are NOT covered by this floor)', () => {
      const cfg = mockConfig.billing.referral;
      const keys = BillingReferralService.expectedGrantKeys(
        { _id: invitationId, invitedBy: refereeId, acceptedUserId: refereeId },
        cfg,
      );
      expect(keys).toEqual([{ side: 'referee', key: `referral:${invitationId}:referee` }]);
      expect(keys.some((k) => k.side === 'referrer')).toBe(false);
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

  test('expiryDays 0 → throws (0 is not a valid expiry; use null for no-expiry)', async () => {
    mockConfig.billing.referral.expiryDays = 0;

    await expect(
      BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId }),
    ).rejects.toThrow('billing.referral.expiryDays must be > 0 or null');
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
    mockMembershipService.findFirstActiveByUser.mockResolvedValue(null);

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

    expect(result.referee).toEqual({ applied: false, reason: 'no_organization' });
    // The referrer side is unaffected.
    expect(result.referrer).toMatchObject({ applied: true, organizationId: inviterOrgId });
    expect(mockRepository.creditGrant).toHaveBeenCalledTimes(1);
  });

  test('currentOrganization unset → falls back to the user active membership', async () => {
    mockUserService._users[refereeId] = { _id: refereeId, currentOrganization: null };
    mockMembershipService.findFirstActiveByUser.mockResolvedValue({ organizationId: { _id: refereeOrgId, name: 'Org' } });

    const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: null, acceptedUserId: refereeId });

    // Deterministic fallback: oldest active membership wins (createdAt asc).
    expect(mockMembershipService.findFirstActiveByUser).toHaveBeenCalledWith(refereeId);
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

  describe('notifyReferrer (#3945 referrer email on a freshly applied grant)', () => {
    test('mailer OFF (default in this suite) → no email lookup, no send', async () => {
      await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });
      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('mailer ON + referrer grant freshly applied → sends the referral-reward-earned email to the referrer', async () => {
      mockMailer.isConfigured.mockReturnValue(true);

      await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

      expect(mockMailer.sendMail).toHaveBeenCalledTimes(1);
      const mail = mockMailer.sendMail.mock.calls[0][0];
      expect(mail.to).toBe('inviter@example.com');
      expect(mail.template).toBe('referral-reward-earned');
      expect(mail.subject).toContain('Test App');
      expect(mail.params).toMatchObject({ units: 1000, displayName: 'In Viter' });
    });

    test('mailer ON but referrer side not applied (e.g. self-referral) → no email', async () => {
      mockMailer.isConfigured.mockReturnValue(true);

      await BillingReferralService.grantForInvitation({ invitationId, invitedBy: refereeId, acceptedUserId: refereeId });

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('mailer ON but referrer grant is a duplicate replay (applied:false) → no email (never double-notifies)', async () => {
      mockMailer.isConfigured.mockReturnValue(true);
      mockRepository.creditGrant.mockResolvedValue({ doc: null, applied: false, reason: 'duplicate_grant' });

      await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
    });

    test('mailer ON but the referrer user has no email → no send, no throw', async () => {
      mockMailer.isConfigured.mockReturnValue(true);
      mockUserService._users[inviterId] = { _id: inviterId, currentOrganization: inviterOrgId }; // no email

      const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

      expect(mockMailer.sendMail).not.toHaveBeenCalled();
      expect(result.referrer).toMatchObject({ applied: true });
    });

    test('a mailer send failure is swallowed — the grant result is unaffected, error is logged', async () => {
      mockMailer.isConfigured.mockReturnValue(true);
      mockMailer.sendMail.mockRejectedValue(new Error('SMTP down'));

      const result = await BillingReferralService.grantForInvitation({ invitationId, invitedBy: inviterId, acceptedUserId: refereeId });

      expect(result.referrer).toMatchObject({ applied: true, organizationId: inviterOrgId });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[billing.referral] referrer notification failed (non-fatal)',
        expect.objectContaining({ userId: inviterId, message: 'SMTP down' }),
      );
    });
  });

  describe('link signups (#4214 — billing.referral.link):', () => {
    const linkRecord = { kind: 'link', userId: refereeId, referredBy: inviterId };
    const refereeKey = `referral:link:${refereeId}:referee`;
    const referrerKey = `referral:link:${refereeId}:referrer:${inviterId}`;

    beforeEach(() => {
      mockConfig.billing.referral.link = true;
      mockConfig.invitations = { maxLifetime: 2 };
    });

    test('expectedGrantKeys: a link record yields the link-rooted keys with the same side rules', () => {
      const cfg = mockConfig.billing.referral;
      expect(BillingReferralService.expectedGrantKeys(linkRecord, cfg)).toEqual([
        { side: 'referee', key: refereeKey },
        { side: 'referrer', key: referrerKey },
      ]);
      expect(BillingReferralService.expectedGrantKeys(linkRecord, { ...cfg, referrerUnits: 0 }))
        .toEqual([{ side: 'referee', key: refereeKey }]);
      expect(BillingReferralService.expectedGrantKeys(linkRecord, { ...cfg, refereeUnits: 0 }))
        .toEqual([{ side: 'referrer', key: referrerKey }]);
      // self-referral floor and missing referrer drop the referrer side
      expect(BillingReferralService.expectedGrantKeys({ kind: 'link', userId: refereeId, referredBy: refereeId }, cfg))
        .toEqual([{ side: 'referee', key: refereeKey }]);
      expect(BillingReferralService.expectedGrantKeys({ kind: 'link', userId: refereeId }, cfg))
        .toEqual([{ side: 'referee', key: refereeKey }]);
    });

    test('expectedGrantKeys: the link flag off (or referral disabled) yields no link keys', () => {
      const cfg = mockConfig.billing.referral;
      expect(BillingReferralService.expectedGrantKeys(linkRecord, { ...cfg, link: false })).toEqual([]);
      expect(BillingReferralService.expectedGrantKeys(linkRecord, { ...cfg, enabled: false })).toEqual([]);
    });

    test('flag off → skipped disabled, no ledger write', async () => {
      mockConfig.billing.referral.link = false;
      expect(await BillingReferralService.grantForLink(linkRecord)).toEqual({ skipped: 'disabled' });
      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
    });

    test('flag on → both sides granted to the right organizations with the link keys', async () => {
      const result = await BillingReferralService.grantForLink(linkRecord);

      expect(result.referee).toMatchObject({ applied: true, organizationId: refereeOrgId });
      expect(result.referrer).toMatchObject({ applied: true, organizationId: inviterOrgId });
      const calls = mockRepository.creditGrant.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls.find(([, , , o]) => o.refId === refereeKey)).toEqual([refereeOrgId, 500, 'referral', expect.any(Object)]);
      expect(calls.find(([, , , o]) => o.refId === referrerKey)).toEqual([inviterOrgId, 1000, 'referral', expect.any(Object)]);
    });

    test('an accepted invitation wins: no link grant', async () => {
      mockInvitationsService.findByAcceptedUserId.mockResolvedValue({ _id: invitationId });
      expect(await BillingReferralService.grantForLink(linkRecord)).toEqual({ skipped: 'invited' });
      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
    });

    test('a record without kind link is never read as a link (identity, not shape)', () => {
      expect(BillingReferralService.expectedGrantKeys({ userId: refereeId, referredBy: inviterId }, mockConfig.billing.referral)).toEqual([]);
    });

    test('cap: link grants already on the referrer ledger >= maxLifetime → cap_reached, no grant on either side', async () => {
      mockRepository.countLinkReferrerGrants.mockResolvedValue(2);
      expect(await BillingReferralService.grantForLink(linkRecord)).toEqual({ skipped: 'cap_reached' });
      expect(mockRepository.countLinkReferrerGrants).toHaveBeenCalledWith(inviterId); // by referrer id, not by organization
      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
    });

    test('cap: below the cap is granted', async () => {
      mockRepository.countLinkReferrerGrants.mockResolvedValue(1);
      expect((await BillingReferralService.grantForLink(linkRecord)).referee).toMatchObject({ applied: true });
    });

    test('cap reached but this user\'s own referrer grant already landed → still finishes the referee side', async () => {
      mockRepository.countLinkReferrerGrants.mockResolvedValue(2);
      mockRepository.findExistingRefIds.mockResolvedValue([referrerKey]);
      const result = await BillingReferralService.grantForLink(linkRecord);
      expect(result.referee).toMatchObject({ applied: true });
    });

    test('fail closed without a cap: null / undefined / 0 / non-integer maxLifetime → no_cap, warn, no grant', async () => {
      for (const value of [null, undefined, 0, 1.5, '3']) {
        mockConfig.invitations = { maxLifetime: value };
        mockLogger.warn.mockClear();
        expect(await BillingReferralService.grantForLink(linkRecord)).toEqual({ skipped: 'no_cap' });
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      }
      delete mockConfig.invitations;
      expect(await BillingReferralService.grantForLink(linkRecord)).toEqual({ skipped: 'no_cap' });
      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
    });

    test('referrer without a workspace yet → skipped referrer_no_organization (fail closed, cron retries)', async () => {
      mockUserService._users[inviterId] = { _id: inviterId };
      expect(await BillingReferralService.grantForLink(linkRecord)).toEqual({ skipped: 'referrer_no_organization' });
      expect(mockRepository.creditGrant).not.toHaveBeenCalled();
    });

    test('referrerUnits 0 → the cap cannot bind (no referrer entries): no ledger count', async () => {
      mockConfig.billing.referral.referrerUnits = 0;
      mockRepository.countLinkReferrerGrants.mockResolvedValue(99);
      const result = await BillingReferralService.grantForLink(linkRecord);
      expect(result.referee).toMatchObject({ applied: true });
      expect(mockRepository.countLinkReferrerGrants).not.toHaveBeenCalled();
    });

    test('an invitation passed by the caller skips the lookup (null = looked up, none)', async () => {
      await BillingReferralService.grantForLink({ ...linkRecord, invitation: null });
      expect(mockInvitationsService.findByAcceptedUserId).not.toHaveBeenCalled();
      expect(await BillingReferralService.grantForLink({ ...linkRecord, invitation: { _id: invitationId } })).toEqual({ skipped: 'invited' });
    });

    test('link-path skip labels are their own (no_referrer / no_referee)', async () => {
      const noReferrer = await BillingReferralService.grantForLink({ kind: 'link', userId: refereeId, referredBy: refereeId });
      expect(noReferrer.referrer).toEqual({ applied: false, reason: 'self_referral' });
      mockConfig.billing.referral.refereeUnits = 0;
      const zero = await BillingReferralService.grantForLink(linkRecord);
      expect(zero.referee).toEqual({ applied: false, reason: 'zero_units' });
    });

    test('replay → duplicate_grant on both sides, never a second referrer email', async () => {
      mockMailer.isConfigured.mockReturnValue(true);
      await BillingReferralService.grantForLink(linkRecord);
      expect(mockMailer.sendMail).toHaveBeenCalledTimes(1);

      mockRepository.creditGrant.mockResolvedValue({ doc: null, applied: false, reason: 'duplicate_grant' });
      const replay = await BillingReferralService.grantForLink(linkRecord);
      expect(replay.referee).toMatchObject({ applied: false, reason: 'duplicate_grant' });
      expect(replay.referrer).toMatchObject({ applied: false, reason: 'duplicate_grant' });
      expect(mockMailer.sendMail).toHaveBeenCalledTimes(1);
      expect(mockMailer.sendMail.mock.calls[0][0].to).toBe('inviter@example.com');
    });

    test('zero referee units → only the referrer side is credited', async () => {
      mockConfig.billing.referral.refereeUnits = 0;
      const result = await BillingReferralService.grantForLink(linkRecord);
      expect(result.referee).toEqual({ applied: false, reason: 'zero_units' });
      expect(result.referrer).toMatchObject({ applied: true });
      expect(mockRepository.creditGrant).toHaveBeenCalledTimes(1);
    });
  });
});
