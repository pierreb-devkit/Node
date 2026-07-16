/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';

/**
 * Billing referral grant integration tests (#3842).
 *
 * Drives a REAL invited signup (admin creates invite → closed-signup token path) with
 * `config.billing.referral` enabled and asserts both organizations are credited on the
 * BillingExtraBalance ledger with the `referral:<invitationId>:referrer|referee` keys,
 * then proves a replayed `invitation.accepted` event / grant call cannot double-credit.
 */
describe('Billing referral grant (#3842):', () => {
  let app;
  let UserService;
  let BillingExtraBalanceRepository;
  let BillingReferralService;
  let invitationEvents;
  let OrganizationsService;

  let originalUp;
  let originalCap;
  let originalReferral;

  const ADMIN_EMAIL = 'ref-admin@test.com';
  const GUEST_EMAIL = 'ref-guest@example.com';
  const GUEST_OFF_EMAIL = 'ref-guest-off@example.com';
  const GUEST_RACE_EMAIL = 'ref-guest-race@example.com';
  const GUEST_VERIFY_EMAIL = 'ref-guest-verify@example.com';
  const PASSWORD = 'W@os.jsI$Aw3$0m3';
  const REFERRER_UNITS = 1000;
  const REFEREE_UNITS = 500;

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    BillingExtraBalanceRepository = (await import(path.resolve('./modules/billing/repositories/billing.extraBalance.repository.js'))).default;
    BillingReferralService = (await import(path.resolve('./modules/billing/services/billing.referral.service.js'))).default;
    invitationEvents = (await import(path.resolve('./modules/invitations/lib/events.js'))).default;
    OrganizationsService = (await import(path.resolve('./modules/organizations/services/organizations.service.js'))).default;
  });

  afterAll(async () => {
    for (const email of [ADMIN_EMAIL, GUEST_EMAIL, GUEST_OFF_EMAIL, GUEST_RACE_EMAIL, GUEST_VERIFY_EMAIL]) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    }
  });

  beforeEach(() => {
    originalUp = config.sign.up;
    originalCap = config.sign.cap;
    originalReferral = config.billing?.referral;
    config.billing = config.billing || {};
    config.billing.referral = {
      enabled: true,
      referrerUnits: REFERRER_UNITS,
      refereeUnits: REFEREE_UNITS,
      expiryDays: 365,
    };
  });

  afterEach(() => {
    config.sign.up = originalUp;
    config.sign.cap = originalCap;
    config.billing.referral = originalReferral;
  });

  /**
   * Create an admin user and return a bound supertest agent with the auth cookie.
   * Pattern mirrors invitations.integration.tests.js.
   * @returns {Promise<import('supertest').SuperAgentTest>} Supertest agent with admin JWT cookie
   */
  async function createAdminAndSignin() {
    try {
      const existing = await UserService.getBrut({ email: ADMIN_EMAIL });
      if (existing) await UserService.remove(existing);
    } catch (_) { /* ignore */ }

    const savedUp = config.sign.up;
    config.sign.up = true;
    const adminAgent = request.agent(app);
    const signupRes = await adminAgent
      .post('/api/auth/signup')
      .send({ firstName: 'Ref', lastName: 'Admin', email: ADMIN_EMAIL, password: PASSWORD, provider: 'local' })
      .expect(200);
    config.sign.up = savedUp;

    const brut = await UserService.getBrut({ id: signupRes.body.user.id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');

    await adminAgent
      .post('/api/auth/signin')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);

    // #3952: the admin's own org creation also fires `organization.created` → billing's
    // fire-and-forget signupGrant listener. Wait for it to settle here so every downstream
    // balance-delta assertion (referral credits) starts from a stable, fully-settled baseline.
    const adminOrgId = String(brut.currentOrganization?._id || brut.currentOrganization);
    const adminGrant = await waitForLedgerEntry(adminOrgId, `signup_grant-${adminOrgId}`);
    expect(adminGrant).not.toBeNull();

    return adminAgent;
  }

  /**
   * Poll the org ledger until an entry with `refId` appears (the grant listener is
   * fire-and-forget — the signup response does not await it).
   * @param {string} orgId - Organization id whose ledger to poll.
   * @param {string} refId - The grant idempotency key to wait for.
   * @param {number} [timeoutMs=5000] - Give-up timeout.
   * @returns {Promise<Object|null>} The ledger entry, or null on timeout.
   */
  async function waitForLedgerEntry(orgId, refId, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ledger = await BillingExtraBalanceRepository.findLedgerByOrg(orgId);
      const entry = (ledger ?? []).find((e) => e.refId === refId);
      if (entry) return entry;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    return null;
  }

  test('invited signup with referral enabled credits BOTH organizations; replays cannot double-credit', async () => {
    // 1. Admin (the inviter) + invite, while signup is still open.
    const adminAgent = await createAdminAndSignin();
    const created = await adminAgent.post('/api/invitations').send({ email: GUEST_EMAIL });
    expect(created.status).toBe(200);
    const { token } = created.body.data;
    const invitationId = created.body.data.id;

    const admin = await UserService.getBrut({ email: ADMIN_EMAIL });
    const inviterOrgId = String(admin.currentOrganization._id || admin.currentOrganization);
    const inviterBalanceBefore = await BillingExtraBalanceRepository.getBalance(inviterOrgId);

    // 2. Close public signup — the invite opens the gate, accept() emits the event.
    config.sign.up = false;
    config.sign.cap = null;

    const res = await request(app)
      .post(`/api/auth/signup?inviteToken=${token}`)
      .send({ email: GUEST_EMAIL, password: 'Sup3rStr0ng!' });
    expect(res.status).toBe(200);

    const guest = await UserService.getBrut({ email: GUEST_EMAIL });
    const refereeOrgId = String(guest.currentOrganization._id || guest.currentOrganization);
    expect(refereeOrgId).not.toBe(inviterOrgId);

    // 3. Both sides credited (the listener is async — poll until it settles).
    const refereeKey = `referral:${invitationId}:referee`;
    const referrerKey = `referral:${invitationId}:referrer`;

    const refereeEntry = await waitForLedgerEntry(refereeOrgId, refereeKey);
    expect(refereeEntry).not.toBeNull();
    expect(refereeEntry).toMatchObject({ kind: 'topup', source: 'referral', amount: REFEREE_UNITS });
    expect(refereeEntry.expiresAt).toBeDefined();

    const referrerEntry = await waitForLedgerEntry(inviterOrgId, referrerKey);
    expect(referrerEntry).not.toBeNull();
    expect(referrerEntry).toMatchObject({ kind: 'topup', source: 'referral', amount: REFERRER_UNITS });

    const inviterBalanceAfter = await BillingExtraBalanceRepository.getBalance(inviterOrgId);
    expect(inviterBalanceAfter - inviterBalanceBefore).toBe(REFERRER_UNITS);
    // #3952: the referee's own org creation also fires `organization.created` → signupGrant.
    // Wait for it to settle so the "unchanged after replay" check below (step 5) has a stable
    // snapshot — otherwise a late-landing signup grant could be mistaken for a replay double-credit.
    const refereeGrant = await waitForLedgerEntry(refereeOrgId, `signup_grant-${refereeOrgId}`);
    expect(refereeGrant).not.toBeNull();
    const refereeBalanceAfter = await BillingExtraBalanceRepository.getBalance(refereeOrgId);

    // 4. Replay safety (deterministic): a direct service replay is the exact grant path
    //    the listener/cron re-run — both sides must come back duplicate_grant.
    const replay = await BillingReferralService.grantForInvitation({
      invitationId,
      invitedBy: String(admin._id),
      acceptedUserId: String(guest._id),
    });
    expect(replay.referee).toMatchObject({ applied: false, reason: 'duplicate_grant' });
    expect(replay.referrer).toMatchObject({ applied: false, reason: 'duplicate_grant' });

    // 5. Replay safety (event path): re-emitting invitation.accepted must not credit either org.
    invitationEvents.emit('invitation.accepted', {
      invitationId,
      email: GUEST_EMAIL,
      invitedBy: String(admin._id),
      acceptedUserId: String(guest._id),
    });
    // Give the async listener time to settle, then assert balances are unchanged.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(await BillingExtraBalanceRepository.getBalance(inviterOrgId)).toBe(inviterBalanceAfter);
    expect(await BillingExtraBalanceRepository.getBalance(refereeOrgId)).toBe(refereeBalanceAfter);

    // 6. Exactly ONE entry per key on each ledger (no duplicates slipped through).
    const inviterLedger = await BillingExtraBalanceRepository.findLedgerByOrg(inviterOrgId);
    expect(inviterLedger.filter((e) => e.refId === referrerKey)).toHaveLength(1);
    const refereeLedger = await BillingExtraBalanceRepository.findLedgerByOrg(refereeOrgId);
    expect(refereeLedger.filter((e) => e.refId === refereeKey)).toHaveLength(1);

    // 7. The reconcile diff helper sees both keys as granted (cron would skip this invite).
    const existing = await BillingExtraBalanceRepository.findExistingRefIds([referrerKey, refereeKey]);
    expect(new Set(existing)).toEqual(new Set([referrerKey, refereeKey]));
  }, 30000);

  test('#3844 org provisioned AFTER acceptance (mailer-on timing) → organization.provisioned credits the referee instantly; replay → duplicate_grant', async () => {
    // 1. Admin (the inviter) + invite, while signup is still open.
    const adminAgent = await createAdminAndSignin();
    const created = await adminAgent.post('/api/invitations').send({ email: GUEST_VERIFY_EMAIL });
    expect(created.status).toBe(200);
    const { token } = created.body.data;
    const invitationId = created.body.data.id;

    // 2. Sign the guest up with referral DISABLED so the #3842 invitation.accepted
    //    listener does NOT credit — reproducing the mailer-on gap: accepted invite +
    //    referredBy stamped, org existing, but ZERO referral keys on the ledger yet.
    config.billing.referral.enabled = false;
    config.sign.up = false;
    config.sign.cap = null;
    const res = await request(app)
      .post(`/api/auth/signup?inviteToken=${token}`)
      .send({ email: GUEST_VERIFY_EMAIL, password: 'Sup3rStr0ng!' });
    expect(res.status).toBe(200);
    await new Promise((resolve) => { setImmediate(resolve); }); // let the (disabled) listeners settle
    config.billing.referral.enabled = true;

    const guest = await UserService.getBrut({ email: GUEST_VERIFY_EMAIL });
    expect(guest.referredBy).toBeTruthy(); // stamped by the accept seam
    const refereeOrgId = String(guest.currentOrganization._id || guest.currentOrganization);
    const refereeKey = `referral:${invitationId}:referee`;
    const referrerKey = `referral:${invitationId}:referrer`;
    expect(await BillingExtraBalanceRepository.findExistingRefIds([refereeKey, referrerKey])).toEqual([]);

    // 3. Re-run handleSignupOrganization exactly as verifyEmail does (A4 convergence —
    //    the org already exists) → emits organization.provisioned → instant grant.
    guest.emailVerified = true; // verifyEmail mutates the local object the same way
    await OrganizationsService.handleSignupOrganization(guest);

    // 4. The referee is credited instantly (the listener is async — poll until it settles)…
    const refereeEntry = await waitForLedgerEntry(refereeOrgId, refereeKey);
    expect(refereeEntry).not.toBeNull();
    expect(refereeEntry).toMatchObject({ kind: 'topup', source: 'referral', amount: REFEREE_UNITS });

    // …and grantForInvitation back-fills the referrer side too (idempotent both ways).
    const admin = await UserService.getBrut({ email: ADMIN_EMAIL });
    const inviterOrgId = String(admin.currentOrganization._id || admin.currentOrganization);
    const referrerEntry = await waitForLedgerEntry(inviterOrgId, referrerKey);
    expect(referrerEntry).not.toBeNull();

    // 5. Replay (cron-overlap): the same grant path must come back duplicate_grant.
    const replay = await BillingReferralService.grantForInvitation({
      invitationId,
      invitedBy: String(admin._id),
      acceptedUserId: String(guest._id),
    });
    expect(replay.referee).toMatchObject({ applied: false, reason: 'duplicate_grant' });
    expect(replay.referrer).toMatchObject({ applied: false, reason: 'duplicate_grant' });

    // 6. Exactly ONE referee entry — listener + replay never double-credited.
    const refereeLedger = await BillingExtraBalanceRepository.findLedgerByOrg(refereeOrgId);
    expect(refereeLedger.filter((e) => e.refId === refereeKey)).toHaveLength(1);
  }, 30000);

  test('concurrent grantForInvitation calls (Promise.all) → exactly ONE applied:true and ONE ledger entry per side-key', async () => {
    // Pins the document-locking atomicity claim: two racers against REAL Mongo, the
    // atomic `'ledger.refId': { $ne: key }` guard must serialize to a single credit.
    const email = GUEST_RACE_EMAIL;
    const adminAgent = await createAdminAndSignin();
    const created = await adminAgent.post('/api/invitations').send({ email });
    expect(created.status).toBe(200);
    const { token } = created.body.data;
    const invitationId = created.body.data.id;

    // Disable referral during signup so the accept listener does NOT grant —
    // the two racers below must be the FIRST writers on both keys.
    config.billing.referral.enabled = false;
    config.sign.up = false;
    config.sign.cap = null;
    const res = await request(app)
      .post(`/api/auth/signup?inviteToken=${token}`)
      .send({ email, password: 'Sup3rStr0ng!' });
    expect(res.status).toBe(200);
    await new Promise((resolve) => { setImmediate(resolve); }); // let the (disabled) listener settle
    config.billing.referral.enabled = true;

    const admin = await UserService.getBrut({ email: ADMIN_EMAIL });
    const guest = await UserService.getBrut({ email });
    const payload = {
      invitationId,
      invitedBy: String(admin._id),
      acceptedUserId: String(guest._id),
    };

    const [first, second] = await Promise.all([
      BillingReferralService.grantForInvitation(payload),
      BillingReferralService.grantForInvitation(payload),
    ]);

    // Exactly one racer wins each side; the loser surfaces the idempotent no-op.
    for (const side of ['referrer', 'referee']) {
      const applied = [first[side], second[side]].filter((s) => s?.applied === true);
      expect(applied).toHaveLength(1);
    }

    // Exactly one ledger entry per key — the race never double-credited.
    const inviterOrgId = String(admin.currentOrganization._id || admin.currentOrganization);
    const refereeOrgId = String(guest.currentOrganization._id || guest.currentOrganization);
    const inviterLedger = await BillingExtraBalanceRepository.findLedgerByOrg(inviterOrgId);
    expect(inviterLedger.filter((e) => e.refId === `referral:${invitationId}:referrer`)).toHaveLength(1);
    const refereeLedger = await BillingExtraBalanceRepository.findLedgerByOrg(refereeOrgId);
    expect(refereeLedger.filter((e) => e.refId === `referral:${invitationId}:referee`)).toHaveLength(1);
  }, 30000);

  test('referral disabled → an invited signup credits NOTHING (zero behavior when off)', async () => {
    config.billing.referral = { enabled: false, referrerUnits: REFERRER_UNITS, refereeUnits: REFEREE_UNITS, expiryDays: 365 };

    // Fresh guest for this test (the previous one is cleaned in afterAll but emails must differ).
    const email = GUEST_OFF_EMAIL;
    const adminAgent = await createAdminAndSignin();
    const created = await adminAgent.post('/api/invitations').send({ email });
    const { token } = created.body.data;
    const invitationId = created.body.data.id;

    config.sign.up = false;
    config.sign.cap = null;
    const res = await request(app)
      .post(`/api/auth/signup?inviteToken=${token}`)
      .send({ email, password: 'Sup3rStr0ng!' });
    expect(res.status).toBe(200);

    // The listener returns immediately — no referral key may ever appear.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    const existing = await BillingExtraBalanceRepository.findExistingRefIds([
      `referral:${invitationId}:referrer`,
      `referral:${invitationId}:referee`,
    ]);
    expect(existing).toEqual([]);

    try {
      const guest = await UserService.getBrut({ email });
      if (guest) await UserService.remove(guest);
    } catch (_) { /* cleanup */ }
  }, 30000);
});
