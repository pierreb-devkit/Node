/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import mongoose from 'mongoose';
import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';
import { encodeReferralCode } from '../../users/utils/referralCode.js';

/**
 * Read an org's extras ledger straight from the model (null when the org has no doc yet).
 * @param {string} orgId - Organization id.
 * @returns {Promise<Object[]|null>} Ledger entries or null.
 */
const findLedger = async (orgId) => {
  const doc = await mongoose.model('BillingExtraBalance').findOne({ organization: orgId }, { ledger: 1 }).lean();
  return doc?.ledger ?? null;
};

/**
 * Billing referral LINK grant integration tests (#4214), through the real Express app +
 * Mongo: with `billing.referral.link` on, a signup carrying a referral code credits both
 * organizations once (via the `organization.provisioned` listener), the reconcile path
 * back-fills a missed grant, an accepted invitation wins, and the per-referrer cap
 * (`invitations.maxLifetime`) denies both sides. With the flag off nothing is granted.
 */
describe('Billing referral link grant (#4214):', () => {
  let app;
  let UserService;
  let BillingExtraBalanceRepository;
  let BillingReferralService;
  let referrerId;
  let referrerOrgId;
  let originalReferral;
  let originalInvitations;

  const PASSWORD = 'W@os.jsI$Aw3$0m3';
  const REFERRER_UNITS = 1000;
  const REFEREE_UNITS = 500;
  const emails = {
    referrer: 'ref-link-grant-referrer@test.com',
    a: 'ref-link-grant-a@test.com',
    b: 'ref-link-grant-b@test.com',
    off: 'ref-link-grant-off@test.com',
    invited: 'ref-link-grant-invited@test.com',
    late: 'ref-link-grant-late@test.com',
    switched: 'ref-link-grant-switched@test.com',
  };

  const signup = (email, extra = {}) => request(app).post('/api/auth/signup').send({
    firstName: 'Ref', lastName: 'Link', email, password: PASSWORD, provider: 'local', ...extra,
  });

  const orgOf = (user) => String(user.currentOrganization?._id || user.currentOrganization);

  /**
   * Poll the org ledger until an entry with `refId` appears (the listener is fire-and-forget).
   * @param {string} orgId - Organization id whose ledger to poll.
   * @param {string} refId - The grant idempotency key to wait for.
   * @returns {Promise<Object|null>} The ledger entry, or null on timeout.
   */
  const waitForEntry = async (orgId, refId) => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const ledger = await findLedger(orgId);
      const entry = (ledger ?? []).find((e) => e.refId === refId);
      if (entry) return entry;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    return null;
  };

  /**
   * Count the ledger entries carrying `refId` on an organization.
   * @param {string} orgId - Organization id.
   * @param {string} refId - Idempotency key.
   * @returns {Promise<number>} Number of matching entries.
   */
  const countEntries = async (orgId, refId) => {
    const ledger = await findLedger(orgId);
    return (ledger ?? []).filter((e) => e.refId === refId).length;
  };

  const cleanupUsers = async () => {
    for (const email of Object.values(emails)) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup – ignore errors */ }
    }
  };

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    BillingExtraBalanceRepository = (await import(path.resolve('./modules/billing/repositories/billing.extraBalance.repository.js'))).default;
    BillingReferralService = (await import(path.resolve('./modules/billing/services/billing.referral.service.js'))).default;
    originalReferral = config.billing.referral;
    originalInvitations = config.invitations;
    config.billing.referral = { enabled: true, link: false, referrerUnits: REFERRER_UNITS, refereeUnits: REFEREE_UNITS, expiryDays: 365 };
    await cleanupUsers();
    await signup(emails.referrer).expect(200);
    const referrer = await UserService.getBrut({ email: emails.referrer });
    referrerId = String(referrer.id);
    referrerOrgId = orgOf(referrer);
    await waitForEntry(referrerOrgId, `signup_grant-${referrerOrgId}`);
  });

  beforeEach(() => {
    config.billing.referral = { enabled: true, link: true, referrerUnits: REFERRER_UNITS, refereeUnits: REFEREE_UNITS, expiryDays: 365 };
    config.invitations = { ...originalInvitations, maxLifetime: 100 };
  });

  afterEach(() => {
    config.billing.referral = originalReferral;
    config.invitations = originalInvitations;
  });

  afterAll(async () => {
    await cleanupUsers();
  });

  test('flag off → a link signup credits nothing; flipping it on, the reconcile path back-fills both sides once', async () => {
    config.billing.referral.link = false;
    await signup(emails.off, { ref: encodeReferralCode(referrerId) }).expect(200);
    const user = await UserService.getBrut({ email: emails.off });
    const userId = String(user._id);
    const refereeOrgId = orgOf(user);
    await waitForEntry(refereeOrgId, `signup_grant-${refereeOrgId}`);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const keys = [`referral:link:${userId}:referrer:${referrerId}`, `referral:link:${userId}:referee`];
    expect(await BillingExtraBalanceRepository.findExistingRefIds(keys)).toEqual([]);

    // What the cron does for a missed link grant: flag on, then grantForLink.
    config.billing.referral.link = true;
    const first = await BillingReferralService.grantForLink({ userId, referredBy: referrerId });
    expect(first.referee).toMatchObject({ applied: true, organizationId: refereeOrgId });
    expect(first.referrer).toMatchObject({ applied: true, organizationId: referrerOrgId });
    const replay = await BillingReferralService.grantForLink({ userId, referredBy: referrerId });
    expect(replay.referee).toMatchObject({ applied: false, reason: 'duplicate_grant' });
    expect(replay.referrer).toMatchObject({ applied: false, reason: 'duplicate_grant' });
    expect(await countEntries(refereeOrgId, keys[1])).toBe(1);
    expect(await countEntries(referrerOrgId, keys[0])).toBe(1);
  }, 30000);

  test('flag on → the signup itself credits both organizations once; a replay is a no-op', async () => {
    await signup(emails.a, { ref: encodeReferralCode(referrerId) }).expect(200);
    const user = await UserService.getBrut({ email: emails.a });
    const userId = String(user._id);
    const refereeOrgId = orgOf(user);

    const refereeEntry = await waitForEntry(refereeOrgId, `referral:link:${userId}:referee`);
    expect(refereeEntry).toMatchObject({ kind: 'topup', source: 'referral', amount: REFEREE_UNITS });
    const referrerEntry = await waitForEntry(referrerOrgId, `referral:link:${userId}:referrer:${referrerId}`);
    expect(referrerEntry).toMatchObject({ kind: 'topup', source: 'referral', amount: REFERRER_UNITS });

    const replay = await BillingReferralService.grantForLink({ userId, referredBy: referrerId });
    expect(replay.referee).toMatchObject({ applied: false, reason: 'duplicate_grant' });
    expect(await countEntries(refereeOrgId, `referral:link:${userId}:referee`)).toBe(1);
    expect(await countEntries(referrerOrgId, `referral:link:${userId}:referrer:${referrerId}`)).toBe(1);
  }, 30000);

  test('cap reached → the later referred user gets no grant on either side', async () => {
    // emails.a's referrer grant is already on the referrer's ledger; with a cap of 1 the next user is capped.
    config.invitations = { ...originalInvitations, maxLifetime: 1 };
    await signup(emails.b, { ref: encodeReferralCode(referrerId) }).expect(200);
    const user = await UserService.getBrut({ email: emails.b });
    const userId = String(user._id);
    const refereeOrgId = orgOf(user);
    await waitForEntry(refereeOrgId, `signup_grant-${refereeOrgId}`);
    await new Promise((resolve) => { setTimeout(resolve, 300); });

    expect(await BillingReferralService.grantForLink({ userId, referredBy: referrerId })).toEqual({ skipped: 'cap_reached' });
    expect(await BillingExtraBalanceRepository.findExistingRefIds([
      `referral:link:${userId}:referrer:${referrerId}`,
      `referral:link:${userId}:referee`,
    ])).toEqual([]);
  }, 30000);

  test('deleting referred users never resets the cap (the ledger is the counter)', async () => {
    config.invitations = { ...originalInvitations, maxLifetime: 1 };
    const a = await UserService.getBrut({ email: emails.a });
    await UserService.remove(a);
    await signup(emails.late, { ref: encodeReferralCode(referrerId) }).expect(200);
    const user = await UserService.getBrut({ email: emails.late });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(await BillingReferralService.grantForLink({ userId: String(user._id), referredBy: referrerId })).toEqual({ skipped: 'cap_reached' });
  }, 30000);

  test('the referrer creating and switching to a NEW organization does not reset the cap', async () => {
    config.invitations = { ...originalInvitations, maxLifetime: 1 };
    const agent = request.agent(app);
    await agent.post('/api/auth/signin').send({ email: emails.referrer, password: PASSWORD }).expect(200);
    const created = await agent.post('/api/organizations').send({ name: 'Second workspace for the referrer' });
    expect(created.status).toBe(200);
    const referrer = await UserService.getBrut({ email: emails.referrer });
    expect(orgOf(referrer)).not.toBe(referrerOrgId); // currentOrganization really moved

    await signup(emails.switched, { ref: encodeReferralCode(referrerId) }).expect(200);
    const user = await UserService.getBrut({ email: emails.switched });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(await BillingReferralService.grantForLink({ userId: String(user._id), referredBy: referrerId })).toEqual({ skipped: 'cap_reached' });
    expect(await BillingExtraBalanceRepository.findExistingRefIds([`referral:link:${String(user._id)}:referee`])).toEqual([]);

    // A replay after the switch never credits a key already landed in the OLD organization.
    const off = await UserService.getBrut({ email: emails.off });
    const used = await BillingExtraBalanceRepository.countLinkReferrerGrants(referrerId);
    const replay = await BillingReferralService.grantForLink({ userId: String(off._id), referredBy: referrerId });
    expect(replay.referrer).toEqual({ applied: false, reason: 'duplicate_grant' });
    expect(replay.referee).toEqual({ applied: false, reason: 'duplicate_grant' });
    expect(await countEntries(orgOf(referrer), `referral:link:${String(off._id)}:referrer:${referrerId}`)).toBe(0);
    expect(await BillingExtraBalanceRepository.countLinkReferrerGrants(referrerId)).toBe(used);
  }, 30000);

  test('no usable invitations.maxLifetime → no link grant (fails closed)', async () => {
    config.invitations = { ...originalInvitations, maxLifetime: null };
    const user = await UserService.getBrut({ email: emails.late });
    expect(await BillingReferralService.grantForLink({ userId: String(user._id), referredBy: referrerId })).toEqual({ skipped: 'no_cap' });
  }, 30000);

  test('invite after link has no producer: inviting an already-registered (link) user is rejected 422', async () => {
    const { default: InvitationsService } = await import(path.resolve('./modules/invitations/services/invitations.service.js'));
    await expect(InvitationsService.create(emails.late, { id: referrerId, email: emails.referrer }))
      .rejects.toMatchObject({ status: 422 });
  }, 30000);

  test('an accepted invitation wins over the link: no link grant', async () => {
    config.billing.referral.link = false;
    await signup(emails.invited, { ref: encodeReferralCode(referrerId) }).expect(200);
    const user = await UserService.getBrut({ email: emails.invited });
    const userId = String(user._id);
    const Invitation = mongoose.model('Invitation');
    await Invitation.create({
      email: emails.invited,
      token: `link-wins-${userId}`,
      invitedBy: referrerId,
      status: 'accepted',
      acceptedUserId: userId,
      expiresAt: new Date(Date.now() + 86400000),
    });
    config.billing.referral.link = true;
    try {
      expect(await BillingReferralService.grantForLink({ userId, referredBy: referrerId })).toEqual({ skipped: 'invited' });
      expect(await BillingExtraBalanceRepository.findExistingRefIds([`referral:link:${userId}:referee`])).toEqual([]);
    } finally {
      await Invitation.deleteMany({ acceptedUserId: userId });
    }
  }, 30000);
});
