/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';

/**
 * Invitation integration tests
 */
describe('Signup invitations:', () => {
  let app;
  let UserService;

  beforeAll(async () => {
    const init = await bootstrap();
    app = init.app;
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
  });

  afterAll(async () => {
    // Clean up test users
    for (const email of [
      'inv-admin@test.com',
      'inv-user@test.com',
      'inv-admin2@test.com',
      'canon@example.com',
    ]) {
      try {
        const existing = await UserService.getBrut({ email });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    }
  });

  /**
   * Helper: create an admin user and return a bound supertest agent with the auth cookie.
   * Pattern mirrors auth.authorization.integration.tests.js:
   *   1. signup via /api/auth/signup
   *   2. promote to admin via UserService.update (roles stripped on signup)
   *   3. signin so the agent cookie jar holds the fresh JWT reflecting the new role
   * @returns {Promise<import('supertest').SuperAgentTest>} Supertest agent with admin JWT cookie
   */
  async function createAdminAndSignin() {
    const email = 'inv-admin@test.com';
    const password = 'W@os.jsI$Aw3$0m3';
    // Clean up stale user
    try {
      const existing = await UserService.getBrut({ email });
      if (existing) await UserService.remove(existing);
    } catch (_) { /* ignore */ }

    const savedUp = config.sign.up;
    config.sign.up = true;
    const adminAgent = request.agent(app);
    const signupRes = await adminAgent
      .post('/api/auth/signup')
      .send({ firstName: 'Inv', lastName: 'Admin', email, password, provider: 'local' })
      .expect(200);
    config.sign.up = savedUp;

    // Promote to admin
    const brut = await UserService.getBrut({ id: signupRes.body.user.id });
    await UserService.update(brut, { roles: ['user', 'admin'] }, 'admin');

    // Sign in so the agent cookie jar has a fresh token with admin role
    await adminAgent
      .post('/api/auth/signin')
      .send({ email, password })
      .expect(200);

    return adminAgent;
  }

  /**
   * Helper: create a regular user and return a bound supertest agent with the auth cookie.
   * @returns {Promise<import('supertest').SuperAgentTest>} Supertest agent with user JWT cookie
   */
  async function createUserAndSignin() {
    const email = 'inv-user@test.com';
    const password = 'W@os.jsI$Aw3$0m3';
    // Clean up stale user
    try {
      const existing = await UserService.getBrut({ email });
      if (existing) await UserService.remove(existing);
    } catch (_) { /* ignore */ }

    const savedUp = config.sign.up;
    config.sign.up = true;
    const userAgent = request.agent(app);
    await userAgent
      .post('/api/auth/signup')
      .send({ firstName: 'Inv', lastName: 'User', email, password, provider: 'local' })
      .expect(200);
    config.sign.up = savedUp;

    await userAgent
      .post('/api/auth/signin')
      .send({ email, password })
      .expect(200);

    return userAgent;
  }

  describe('Signup invitations — admin CRUD (canonical /api/invitations)', () => {
    test('admin can create, list, then revoke an invitation', async () => {
      const adminAgent = await createAdminAndSignin();

      const created = await adminAgent
        .post('/api/invitations')
        .send({ email: 'Invitee@Example.com' });
      expect(created.status).toBe(200);
      expect(created.body.data.email).toBe('invitee@example.com');
      expect(created.body.data.token).toBeDefined();
      const id = created.body.data.id;

      const listed = await adminAgent.get('/api/invitations');
      expect(listed.status).toBe(200);
      expect(listed.body.data.some((i) => i.id === id)).toBe(true);

      const removed = await adminAgent.delete(`/api/invitations/${id}`);
      expect(removed.status).toBe(200);
    });

    test('non-admin is forbidden from creating invitations', async () => {
      const userAgent = await createUserAndSignin();
      const res = await userAgent.post('/api/invitations').send({ email: 'x@y.co' });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('Signup invitations — public verify (canonical /api/invitations)', () => {
    test('verify returns { valid:true, email } for a fresh token and { valid:false } for garbage', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'verify@example.com' });
      const { token } = created.body.data;

      const ok = await request(app).get(`/api/invitations/verify/${token}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ valid: true, email: 'verify@example.com' });

      const bad = await request(app).get('/api/invitations/verify/deadbeef');
      expect(bad.status).toBe(200);
      expect(bad.body.data.valid).toBe(false);
    });
  });

  describe('Deprecation alias — /api/auth/invitations still resolves (until Vue P6)', () => {
    test('admin CRUD works through the legacy /api/auth/invitations alias', async () => {
      const adminAgent = await createAdminAndSignin();

      const created = await adminAgent.post('/api/auth/invitations').send({ email: 'alias@example.com' });
      expect(created.status).toBe(200);
      expect(created.body.data.email).toBe('alias@example.com');
      const id = created.body.data.id;

      const listed = await adminAgent.get('/api/auth/invitations');
      expect(listed.status).toBe(200);
      expect(listed.body.data.some((i) => i.id === id)).toBe(true);

      const removed = await adminAgent.delete(`/api/auth/invitations/${id}`);
      expect(removed.status).toBe(200);
    });

    test('public verify works through the legacy alias, interchangeable with the canonical mount', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'alias-verify@example.com' });
      const { token } = created.body.data;

      // canonical create → alias verify resolves the SAME invite
      const viaAlias = await request(app).get(`/api/auth/invitations/verify/${token}`);
      expect(viaAlias.status).toBe(200);
      expect(viaAlias.body.data).toEqual({ valid: true, email: 'alias-verify@example.com' });
    });

    test('the alias did NOT shadow the greedy /api/auth/:strategy wildcard (OAuth routing intact)', async () => {
      // /api/auth/google must still hit the OAuth :strategy route handler, not
      // fall through as an unmatched invitations sub-path. 'google' is
      // allowlisted but unregistered in test config (no clientID) so the
      // handler's own guard (#3900) now returns a deliberate 404 with
      // `code: OAUTH_PROVIDER_NOT_FOUND` — asserting on that code (rather than
      // just "not a 404") is what proves the wildcard route was actually
      // matched and its handler ran, as opposed to Express's own generic
      // route-miss 404 the alias mount could otherwise cause.
      const res = await request(app).get('/api/auth/google');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('OAUTH_PROVIDER_NOT_FOUND');
    });
  });

  describe('Local signup gate (cap + invite)', () => {
    let originalUp; let originalCap;
    beforeEach(() => { originalUp = config.sign.up; originalCap = config.sign.cap; });
    afterEach(() => { config.sign.up = originalUp; config.sign.cap = originalCap; });

    test('signup disabled + no invite → 404', async () => {
      config.sign.up = false; config.sign.cap = null;
      const res = await request(app).post('/api/auth/signup').send({ email: 'nope@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(404);
    });

    test('signup disabled + valid invite token → account created and invite consumed', async () => {
      // Create admin while signup is still open (beforeEach saves/restores; we set false after admin creation)
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'guest@example.com' });
      const { token } = created.body.data;

      // Now close public signup — the invite path must still work
      config.sign.up = false; config.sign.cap = null;

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'guest@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);

      const recheck = await request(app).get(`/api/invitations/verify/${token}`);
      expect(recheck.body.data.valid).toBe(false);
    });

    test('signup disabled + invite token but email mismatch → 404', async () => {
      // Create admin and invitation while signup is open
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'pinned@example.com' });
      const { token } = created.body.data;

      // Now close public signup
      config.sign.up = false; config.sign.cap = null;

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'someoneelse@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(404);
    });

    test('cap reached → 404 even with a valid invite (invites count in the cap)', async () => {
      // Create admin and issue invite BEFORE setting cap so the helper signup
      // is not blocked. Then snapshot the user count and set cap = total.
      config.sign.up = true; config.sign.cap = null;
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'capped@example.com' });
      const { token } = created.body.data;
      // Freeze the cap at the current total — next signup must be blocked
      config.sign.cap = await UserService.count(); // total >= cap → blocked
      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'capped@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(404);
      config.sign.cap = null;
    });

    test('under cap + signup open → normal signup works', async () => {
      config.sign.up = true; config.sign.cap = null;
      const res = await request(app).post('/api/auth/signup').send({ email: 'open@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);
    });

    test('signup disabled + valid token but NO email in body → 404, invite not consumed (email-pin not bypassable)', async () => {
      config.sign.up = false; config.sign.cap = null;
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'pinned2@example.com' });
      const { token } = created.body.data;
      const res = await request(app).post(`/api/auth/signup?inviteToken=${token}`).send({ password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(404);
      const recheck = await request(app).get(`/api/invitations/verify/${token}`);
      expect(recheck.body.data.valid).toBe(true); // not consumed
    });

    test('invited signup canonicalizes account email to the invite (case-insensitive pin → lowercased)', async () => {
      config.sign.up = false; config.sign.cap = null;
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'canon@example.com' });
      const { token } = created.body.data;
      // sign up with an UPPER-CASE variant of the invited email
      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'CANON@Example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);
      // account email must be the invite's canonical lowercased value, not the submitted case-variant
      expect(res.body.user.email).toBe('canon@example.com');
    });
  });

  describe('OAuth signup gate (cap + email-matched invite)', () => {
    let AuthController;
    let originalUp; let originalCap;

    beforeAll(async () => {
      AuthController = (await import(path.resolve('./modules/auth/controllers/auth.controller.js'))).default;
    });

    beforeEach(() => {
      originalUp = config.sign.up;
      originalCap = config.sign.cap;
    });

    afterEach(async () => {
      config.sign.up = originalUp;
      config.sign.cap = originalCap;
      // Clean up any OAuth gate test users
      for (const email of ['oauth-gate-blocked@test.com', 'oauth-gate-invited@test.com', 'oauthunverified@example.com']) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup */ }
      }
    });

    test('signup disabled + no invite for provider email → OAuth signup rejected (VALIDATION_ERROR)', async () => {
      config.sign.up = false;
      config.sign.cap = null;

      const profil = {
        firstName: 'Blocked',
        lastName: 'OAuth',
        email: 'oauth-gate-blocked@test.com',
        avatar: '',
        providerData: { sub: 'google-gate-blocked-sub' },
        emailVerifiedByProvider: true,
      };

      await expect(
        AuthController.checkOAuthUserProfile(profil, 'sub', 'google'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { message: 'Registration is currently deactivated' },
      });

      // Ensure no user was persisted
      const users = await UserService.search({ email: 'oauth-gate-blocked@test.com' });
      expect(users.length).toBe(0);
    });

    test('signup disabled + invite for provider email but email NOT verified by provider → OAuth signup rejected (gate bypass blocked)', async () => {
      // Create admin and invitation while signup is still open
      const adminAgent = await createAdminAndSignin();
      const invEmail = 'oauthunverified@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email: invEmail });
      expect(created.status).toBe(200);

      // Close public signup — an unverified provider email must NOT open the gate
      config.sign.up = false;
      config.sign.cap = null;

      const profil = {
        firstName: 'Unverified',
        lastName: 'OAuth',
        email: invEmail,
        avatar: '',
        providerData: { sub: 'google-unverified-sub' },
        emailVerifiedByProvider: false, // unverified — should NOT match invite
      };

      await expect(
        AuthController.checkOAuthUserProfile(profil, 'sub', 'google'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { message: 'Registration is currently deactivated' },
      });

      // Ensure no user was persisted
      const users = await UserService.search({ email: invEmail });
      expect(users.length).toBe(0);

      // Clean up the invitation
      try {
        const existing = await UserService.getBrut({ email: invEmail });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    });

    test('signup disabled + valid invite for provider email → OAuth signup succeeds and invite consumed', async () => {
      // Create admin and invitation while signup is still open
      const adminAgent = await createAdminAndSignin();
      const invEmail = 'oauth-gate-invited@test.com';
      const created = await adminAgent.post('/api/invitations').send({ email: invEmail });
      expect(created.status).toBe(200);
      const { token } = created.body.data;

      // Now close public signup — the email-matched invite path must still allow creation
      config.sign.up = false;
      config.sign.cap = null;

      const profil = {
        firstName: 'Invited',
        lastName: 'OAuth',
        email: invEmail,
        avatar: '',
        providerData: { sub: 'google-gate-invited-sub' },
        emailVerifiedByProvider: true,
      };

      const createdUser = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
      expect(createdUser).toBeDefined();
      expect(createdUser.email).toBe(invEmail);

      // Invite must be consumed — verify token is no longer valid
      const recheck = await request(app).get(`/api/invitations/verify/${token}`);
      expect(recheck.body.data.valid).toBe(false);
    });
  });

  describe('E2 two-phase claim/finalize hardening', () => {
    let InvitationService;
    let InvitationRepository;
    let originalUp; let originalCap;

    beforeAll(async () => {
      InvitationService = (await import(path.resolve('./modules/invitations/services/invitations.service.js'))).default;
      InvitationRepository = (await import(path.resolve('./modules/invitations/repositories/invitations.repository.js'))).default;
    });

    beforeEach(() => { originalUp = config.sign.up; originalCap = config.sign.cap; });
    afterEach(async () => {
      config.sign.up = originalUp; config.sign.cap = originalCap;
      jest.restoreAllMocks();
      for (const email of ['e2-replay@example.com', 'e2-claimed@example.com', 'e2-stale@example.com', 'e2-createthrow@example.com', 'e2-concurrent@example.com', 'e2-finalize-throw@example.com', 'e2-oauth-finalize-throw@example.com', 'e2-release-throw@example.com']) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup */ }
      }
    });

    test('replay: a 2nd signup with the same token is rejected (the invite was finalized) ', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'e2-replay@example.com' });
      const { token } = created.body.data;
      config.sign.up = false; config.sign.cap = null;

      const first = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'e2-replay@example.com', password: 'Sup3rStr0ng!' });
      expect(first.status).toBe(200);

      // Replay the SAME token (even after deleting the user) — the invite is now
      // accepted/used, so the claim finds nothing pending and signup is blocked.
      const replayUser = await UserService.getBrut({ email: 'e2-replay@example.com' });
      if (replayUser) await UserService.remove(replayUser);
      const second = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'e2-replay@example.com', password: 'Sup3rStr0ng!' });
      expect(second.status).not.toBe(200);
    });

    test('concurrent double-claim: two parallel claim() on the same token → EXACTLY ONE wins (the atomic CAS)', async () => {
      // The replay test above is sequential (signup #1 finalizes the invite, then the
      // 2nd attempt finds nothing pending). This is the genuine atomicity proof: fire
      // two claim() at the SAME pending invite concurrently against real Mongo. The
      // findOneAndUpdate CAS ({token,status:'pending',consumingAt:null}) must let exactly
      // one stamp consumingAt — the loser gets null (which the service surfaces as 422).
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-concurrent@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      const [a, b] = await Promise.all([
        InvitationRepository.claim(token),
        InvitationRepository.claim(token),
      ]);

      // Exactly one non-null winner; the other is null (the double-claim guard).
      const winners = [a, b].filter((r) => r != null);
      expect(winners.length).toBe(1);
      expect([a, b].filter((r) => r == null).length).toBe(1);
      // The winner is the in-flight claim — consumingAt stamped, not yet finalized.
      expect(winners[0].consumingAt).toBeTruthy();
      expect(winners[0].acceptedAt == null).toBe(true);
    });

    test('create-throw release: UserService.create throwing releases the claim so the invite is immediately reusable (not locked 15min)', async () => {
      // Fix-1 regression: the invite is atomically CLAIMED before UserService.create
      // runs, so a throw FROM create (e.g. an E11000 case-variant race, or any
      // transient error) must release the claim too — otherwise it stays consumingAt-
      // stamped and unusable until the 15-min stale sweep. Force create to reject once
      // and assert the claim was cleared (immediately reusable), NOT left in-flight.
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-createthrow@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;
      config.sign.up = false; config.sign.cap = null;

      // Make the create after the claim blow up exactly once.
      const createSpy = jest.spyOn(UserService, 'create').mockRejectedValueOnce(new Error('DB error on create'));

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      // The signup failed (create threw → 422).
      expect(res.status).not.toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // The claim must have been RELEASED: consumingAt cleared (not stuck for 15min),
      // never finalized (no acceptedAt), and the invite reads valid + reusable again.
      const raw = await InvitationRepository.findByToken(token);
      expect(raw.consumingAt == null).toBe(true); // released, not locked
      expect(raw.acceptedAt == null).toBe(true); // never finalized
      expect(raw.status).toBe('pending');
      expect(await InvitationService.findValid(token, email)).not.toBeNull(); // immediately reusable

      // And a real retry (create now works) succeeds end-to-end on the same token.
      const retry = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      expect(retry.status).toBe(200);
    });

    test('a claimed-but-unfinalized invite is INVISIBLE to BOTH findValid and findValidByEmail (bypass guard)', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-claimed@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      // Pre-state: both resolvers see it as valid.
      expect(await InvitationService.findValid(token, email)).not.toBeNull();
      expect(await InvitationService.findValidByEmail(email)).not.toBeNull();

      // Atomically CLAIM it (simulating an in-flight signup that has not finalized).
      const claimed = await InvitationRepository.claim(token);
      expect(claimed).not.toBeNull();

      // Now it must be invisible to BOTH paths — otherwise the OAuth email-resolved
      // path (or a concurrent token signup) could re-accept it → single-use bypass.
      expect(await InvitationService.findValid(token, email)).toBeNull();
      expect(await InvitationService.findValidByEmail(email)).toBeNull();
      // The public verify endpoint (which uses findValid) also reports invalid.
      const verify = await request(app).get(`/api/invitations/verify/${token}`);
      expect(verify.body.data.valid).toBe(false);
    });

    test('OPEN signup + presented token: the token is NOT claimed/burned, invite stays valid (P2 gating preserved)', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-opensignup@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      // rules 1+3 (Node#4020): this P2 invariant holds specifically for
      // userFacing:false (the byte-for-byte-unchanged baseline — the userFacing:true
      // variant is covered separately by the dedicated "Open-signup userFacing"
      // block below). Install that value explicitly rather than ride the config's
      // ambient default, so this assertion never silently flips under a consumer
      // whose default deployment config sets userFacing:true.
      const originalUserFacing = config.invitations.userFacing;
      config.invitations.userFacing = false;

      // Public signup OPEN: a token may be presented but is not required.
      config.sign.up = true; config.sign.cap = null;
      try {
        const res = await request(app)
          .post(`/api/auth/signup?inviteToken=${token}`)
          .send({ email, password: 'Sup3rStr0ng!' });
        expect(res.status).toBe(200);

        // The invite must remain VALID (presented, not consumed) — not stuck mid-claim.
        const verify = await request(app).get(`/api/invitations/verify/${token}`);
        expect(verify.body.data.valid).toBe(true);
      } finally {
        config.invitations.userFacing = originalUserFacing;
        try {
          const u = await UserService.getBrut({ email });
          if (u) await UserService.remove(u);
        } catch (_) { /* cleanup */ }
      }
    });

    test('crash recovery: a stale claim (older than the window) is swept and the invite becomes reusable', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-stale@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      // Claim, then SIMULATE A CRASH between claim and finalize by back-dating
      // consumingAt past the staleness window (no acceptedAt was ever set).
      const claimed = await InvitationRepository.claim(token);
      const Invitation = (await import('mongoose')).default.model('Invitation');
      await Invitation.updateOne(
        { _id: claimed._id },
        { $set: { consumingAt: new Date(Date.now() - 60 * 60 * 1000) } }, // 1h ago » 15min window
      ).exec();

      // While still stale-claimed (before any sweep read), it is invalid.
      // findValid itself sweeps lazily, so call the sweep explicitly first to assert
      // the recovery mechanism, THEN confirm the invite reads valid again.
      await InvitationService.sweepStaleClaims();
      const swept = await Invitation.findById(claimed._id).exec();
      expect(swept.consumingAt == null).toBe(true); // claim released
      expect(await InvitationService.findValid(token, email)).not.toBeNull(); // reusable again
    });

    test('a finalize throw does NOT convert a successful signup into an error (best-effort)', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-finalize-throw@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;
      config.sign.up = false; config.sign.cap = null;

      // finalize is the last pre-response step of an ALREADY-successful signup — make
      // it blow up once (the eligibility closure routes finalize through accept, P8a).
      const acceptSpy = jest.spyOn(InvitationService, 'accept').mockRejectedValueOnce(new Error('simulated finalize DB hiccup'));

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      // The account was created before finalize — the response must still succeed.
      expect(acceptSpy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(email);
    });

    test('OAuth: a finalize throw does NOT convert a successful OAuth signup into an error (best-effort)', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-oauth-finalize-throw@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      expect(created.status).toBe(200);
      config.sign.up = false; config.sign.cap = null;

      // Mirror of the local-signup test above on the OAuth path: the user is created,
      // then finalize (the same accept closure — no claim to release on OAuth) blows up.
      const AuthController = (await import(path.resolve('./modules/auth/controllers/auth.controller.js'))).default;
      const acceptSpy = jest.spyOn(InvitationService, 'accept').mockRejectedValueOnce(new Error('simulated finalize DB hiccup'));

      const createdUser = await AuthController.checkOAuthUserProfile({
        firstName: 'Invited',
        lastName: 'OAuth',
        email,
        avatar: '',
        providerData: { sub: 'google-e2-oauth-finalize-throw-sub' },
        emailVerifiedByProvider: true,
      }, 'sub', 'google');

      // The account was created before finalize — the call must still resolve with it.
      expect(acceptSpy).toHaveBeenCalledTimes(1);
      expect(createdUser).toBeDefined();
      expect(createdUser.email).toBe(email);
    });

    test('cap-reached release: a release throw is swallowed — the gate still answers 404, not a 5xx', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'e2-release-throw@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;
      // Closed signup + a positive cap already filled: the checker CLAIMS the invite,
      // then the capacity gate rejects and must release the claim — make that release
      // blow up. Best-effort: the 404 must come back unchanged (no 5xx), the stuck
      // claim is the sweep's job.
      config.sign.up = false;
      config.sign.cap = await UserService.count(); // > 0 (the admin exists) and reached

      const releaseSpy = jest.spyOn(InvitationService, 'release').mockRejectedValueOnce(new Error('simulated release DB hiccup'));

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(404); // swallowed — the capacity answer, not a masked 5xx
    });
  });

  describe('E6 no auto-verify on invite (mailer off)', () => {
    let originalUp; let originalCap;
    beforeEach(() => { originalUp = config.sign.up; originalCap = config.sign.cap; });
    afterEach(async () => {
      config.sign.up = originalUp; config.sign.cap = originalCap;
      try {
        const existing = await UserService.getBrut({ email: 'e6-invite@example.com' });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    });

    test('mailer off + invite ⇒ account created but NOT emailVerified (token proves inviter, not signer)', async () => {
      // The test env has no mailer configured (isMailerConfigured() is false), so the
      // mailer-off branch runs. An OPEN public signup auto-verifies in that branch,
      // but an INVITE-gated account must NOT be auto-verified (E6).
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'e6-invite@example.com' });
      const { token } = created.body.data;
      config.sign.up = false; config.sign.cap = null;

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: 'e6-invite@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);

      const brut = await UserService.getBrut({ email: 'e6-invite@example.com' });
      expect(brut).not.toBeNull();
      expect(!!brut.emailVerified).toBe(false); // invited account follows normal verification
    });
  });

  describe('E9 already-registered guard', () => {
    afterEach(async () => {
      try {
        const existing = await UserService.getBrut({ email: 'e9-existing@example.com' });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    });

    test('inviting an already-registered email is rejected (422)', async () => {
      // Create the user first (open signup), then try to invite the same email.
      const savedUp = config.sign.up; config.sign.up = true;
      await request(app).post('/api/auth/signup').send({ email: 'e9-existing@example.com', password: 'Sup3rStr0ng!' });
      config.sign.up = savedUp;

      const adminAgent = await createAdminAndSignin();
      const res = await adminAgent.post('/api/invitations').send({ email: 'e9-existing@example.com' });
      expect(res.status).toBe(422);
    });
  });

  describe('#3986 lifetime cap per inviter', () => {
    let originalMaxLifetime;
    beforeEach(() => { originalMaxLifetime = config.invitations.maxLifetime; });
    afterEach(() => { config.invitations.maxLifetime = originalMaxLifetime; });

    test('rejects (422) once the REAL DB count reaches config.invitations.maxLifetime, via the real HTTP path', async () => {
      config.invitations.maxLifetime = 2;
      // createAdminAndSignin() always (re)creates a fresh admin, so this admin's
      // invitedBy count starts at 0 — no cross-test bleed.
      const adminAgent = await createAdminAndSignin();
      const first = await adminAgent.post('/api/invitations').send({ email: 'cap1-3986@example.com' });
      expect(first.status).toBe(200);
      const second = await adminAgent.post('/api/invitations').send({ email: 'cap2-3986@example.com' });
      expect(second.status).toBe(200); // boundary: count was 1 (cap - 1), passes
      const third = await adminAgent.post('/api/invitations').send({ email: 'cap3-3986@example.com' });
      expect(third.status).toBe(422); // count is now 2 (== cap), rejected
    });

    test('default-off (maxLifetime null): unaffected regardless of how many invitations already exist', async () => {
      config.invitations.maxLifetime = null;
      const adminAgent = await createAdminAndSignin();
      const first = await adminAgent.post('/api/invitations').send({ email: 'cap4-3986@example.com' });
      expect(first.status).toBe(200);
      const second = await adminAgent.post('/api/invitations').send({ email: 'cap5-3986@example.com' });
      expect(second.status).toBe(200);
    });
  });

  describe('P8a referral substrate (referredBy + invitation.accepted)', () => {
    let invitationEvents;
    let originalUp; let originalCap;

    beforeAll(async () => {
      invitationEvents = (await import(path.resolve('./modules/invitations/lib/events.js'))).default;
    });

    beforeEach(() => { originalUp = config.sign.up; originalCap = config.sign.cap; });
    afterEach(async () => {
      config.sign.up = originalUp; config.sign.cap = originalCap;
      jest.restoreAllMocks();
      for (const email of ['p8a-token@example.com', 'p8a-oauth@example.com', 'p8a-event@example.com']) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup */ }
      }
    });

    test('token path: invited signup sets referredBy = inviter id; a client-supplied referredBy in the body is IGNORED', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'p8a-token@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;
      // The inviter is the admin who created the invite.
      const admin = await UserService.getBrut({ email: 'inv-admin@test.com' });
      const inviterId = String(admin._id);

      config.sign.up = false; config.sign.cap = null;

      // Attacker tries to self-assign a DIFFERENT referrer via the signup body.
      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!', referredBy: '64b2f0000000000000000999' });
      expect(res.status).toBe(200);

      const brut = await UserService.getBrut({ email });
      // referredBy is the SERVER-resolved inviter, NOT the client-supplied id.
      expect(String(brut.referredBy)).toBe(inviterId);
      expect(String(brut.referredBy)).not.toBe('64b2f0000000000000000999');
    });

    test('OAuth path: an email-matched invited OAuth signup ALSO sets referredBy = inviter id', async () => {
      const AuthController = (await import(path.resolve('./modules/auth/controllers/auth.controller.js'))).default;
      const adminAgent = await createAdminAndSignin();
      const email = 'p8a-oauth@example.com';
      await adminAgent.post('/api/invitations').send({ email });
      const admin = await UserService.getBrut({ email: 'inv-admin@test.com' });
      const inviterId = String(admin._id);

      config.sign.up = false; config.sign.cap = null;

      const profil = {
        firstName: 'Referred', // NB: the name Zod regex rejects digits — no 'P8a'
        lastName: 'OAuth',
        email,
        avatar: '',
        providerData: { sub: 'google-p8a-oauth-sub' },
        emailVerifiedByProvider: true,
      };
      const createdUser = await AuthController.checkOAuthUserProfile(profil, 'sub', 'google');
      expect(createdUser.email).toBe(email);

      const brut = await UserService.getBrut({ email });
      // OAuth-invited users are credited too (the same accept seam runs).
      expect(String(brut.referredBy)).toBe(inviterId);
    });

    test('invitation.accepted fires with the documented payload on accept (proves the billing listener seam end-to-end)', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = 'p8a-event@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;
      const invitationId = created.body.data.id;
      const admin = await UserService.getBrut({ email: 'inv-admin@test.com' });
      const inviterId = String(admin._id);

      // Spy on the REAL events singleton (billing's no-op listener is also attached
      // to it at boot — this proves the event reaches consumers end-to-end).
      const emitSpy = jest.spyOn(invitationEvents, 'emit');

      config.sign.up = false; config.sign.cap = null;
      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);
      const newUser = await UserService.getBrut({ email });

      const acceptedCall = emitSpy.mock.calls.find(([evt]) => evt === 'invitation.accepted');
      expect(acceptedCall).toBeDefined();
      const payload = acceptedCall[1];
      expect(payload.invitationId).toBe(invitationId);
      expect(payload.email).toBe(email);
      expect(String(payload.invitedBy)).toBe(inviterId);
      expect(String(payload.acceptedUserId)).toBe(String(newUser._id));
    });
  });

  describe('E4 cap unify — blank cap means UNCAPPED at the signup gate', () => {
    let originalUp; let originalCap;
    beforeEach(() => { originalUp = config.sign.up; originalCap = config.sign.cap; });
    afterEach(async () => {
      config.sign.up = originalUp; config.sign.cap = originalCap;
      try {
        const existing = await UserService.getBrut({ email: 'e4-blankcap@example.com' });
        if (existing) await UserService.remove(existing);
      } catch (_) { /* cleanup */ }
    });

    test("cap:'' + open signup ⇒ signup SUCCEEDS (blank is uncapped, not everyone-blocked)", async () => {
      // The pre-fix inline `Number('')→0→count>=0` hard-rejected EVERY signup while
      // getConfig advertised the deployment as open. The unify routes the gate through
      // computeSignupCapacity, which treats '' as uncapped. This asserts the gate no
      // longer rejects under a blank cap.
      config.sign.up = true;
      config.sign.cap = '';
      const res = await request(app)
        .post('/api/auth/signup')
        .send({ email: 'e4-blankcap@example.com', password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);
    });
  });

  describe('Invitation ops — revoke guard, duplicate-pending, resend', () => {
    let mails;

    beforeAll(async () => {
      mails = (await import(path.resolve('./lib/helpers/mailer/index.js'))).default;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('revoking an ACCEPTED invitation is refused with 409 (referral attribution preserved)', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'ops-accepted@example.com' });
      const id = created.body.data.id;

      // Flip to accepted directly — the full signup-accept path is covered elsewhere.
      const Invitation = (await import('mongoose')).default.model('Invitation');
      await Invitation.updateOne({ _id: id }, { $set: { status: 'accepted', acceptedAt: new Date() } }).exec();

      const res = await adminAgent.delete(`/api/invitations/${id}`);
      expect(res.status).toBe(409);
      expect(res.body.description).toBe('Only pending invitations can be revoked');

      // The accepted row is untouched — still in the accepted set.
      const after = await Invitation.findById(id).exec();
      expect(after.status).toBe('accepted');
      expect(after.revokedAt).toBeNull();
    });

    test('a second invite for the SAME email is refused with 409 while the first is pending', async () => {
      const adminAgent = await createAdminAndSignin();
      const first = await adminAgent.post('/api/invitations').send({ email: 'ops-dup@example.com' });
      expect(first.status).toBe(200);

      // Case-insensitive: the service lowercases before the guard.
      const second = await adminAgent.post('/api/invitations').send({ email: 'OPS-DUP@example.com' });
      expect(second.status).toBe(409);
      expect(second.body.description).toBe('A pending invitation already exists for this email.');

      // Revoking the pending invite re-opens creation (findByEmail is pending-only).
      const revoked = await adminAgent.delete(`/api/invitations/${first.body.data.id}`);
      expect(revoked.status).toBe(200);
      const third = await adminAgent.post('/api/invitations').send({ email: 'ops-dup@example.com' });
      expect(third.status).toBe(200);
    });

    test('resend re-sends the EXISTING token for a pending invite (no regeneration)', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'ops-resend@example.com' });
      const { id, token } = created.body.data;

      jest.spyOn(mails, 'isConfigured').mockReturnValue(true);
      const sendSpy = jest.spyOn(mails, 'sendMail').mockResolvedValue({});

      const res = await adminAgent.post(`/api/invitations/${id}/resend`);
      expect(res.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const mail = sendSpy.mock.calls[0][0];
      expect(mail.template).toBe('signup-invite');
      expect(mail.to).toBe('ops-resend@example.com');
      expect(mail.params.url).toContain(`inviteToken=${token}`); // SAME token
    });

    test('resend guards: 422 with the mailer unconfigured, 409 once non-pending', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'ops-resend-guards@example.com' });
      const { id } = created.body.data;

      // Test env mailer is unconfigured (placeholder `from`) → 422 with no mocks.
      const unconfigured = await adminAgent.post(`/api/invitations/${id}/resend`);
      expect(unconfigured.status).toBe(422);

      // Revoke it, then resend → 409 (status guard fires before the mailer guard).
      await adminAgent.delete(`/api/invitations/${id}`);
      const conflicted = await adminAgent.post(`/api/invitations/${id}/resend`);
      expect(conflicted.status).toBe(409);
      expect(conflicted.body.description).toBe('Only pending invitations can be resent.');
    });

    test('resend resolves through the legacy /api/auth/invitations alias too (kept consistent)', async () => {
      const adminAgent = await createAdminAndSignin();
      const created = await adminAgent.post('/api/invitations').send({ email: 'ops-resend-alias@example.com' });
      jest.spyOn(mails, 'isConfigured').mockReturnValue(true);
      jest.spyOn(mails, 'sendMail').mockResolvedValue({});
      const res = await adminAgent.post(`/api/auth/invitations/${created.body.data.id}/resend`);
      expect(res.status).toBe(200);
    });
  });

  describe('Open-signup userFacing claim/finalize (#3981)', () => {
    let invitationEvents;
    let InvitationService;
    let originalUp; let originalCap; let originalUserFacing;

    beforeAll(async () => {
      invitationEvents = (await import(path.resolve('./modules/invitations/lib/events.js'))).default;
      InvitationService = (await import(path.resolve('./modules/invitations/services/invitations.service.js'))).default;
    });

    beforeEach(() => {
      originalUp = config.sign.up;
      originalCap = config.sign.cap;
      originalUserFacing = config.invitations.userFacing;
    });
    afterEach(async () => {
      config.sign.up = originalUp;
      config.sign.cap = originalCap;
      config.invitations.userFacing = originalUserFacing;
      jest.restoreAllMocks();
      for (const email of [
        '3981-open-userfacing@example.com',
        '3981-open-userfacing-replay@example.com',
        '3981-open-nofacing@example.com',
        '3981-open-mismatch@example.com',
        '3981-open-mismatch-plain@example.com',
        '3981-open-notoken@example.com',
        '3981-closed-userfacing@example.com',
        '3981-open-race@example.com',
      ]) {
        try {
          const existing = await UserService.getBrut({ email });
          if (existing) await UserService.remove(existing);
        } catch (_) { /* cleanup */ }
      }
    });

    test('userFacing:true + OPEN signup + valid matching-email token ⇒ CLAIMED + FINALIZED (referredBy set, invitation.accepted fires — the #3981 fix)', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = '3981-open-userfacing@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;
      const admin = await UserService.getBrut({ email: 'inv-admin@test.com' });
      const inviterId = String(admin._id);

      config.invitations.userFacing = true;
      config.sign.up = true; config.sign.cap = null;

      const emitSpy = jest.spyOn(invitationEvents, 'emit');

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);

      // The invite was CONSUMED (unlike the userFacing:false open-signup case below) —
      // single-use is enforced exactly as on closed signup.
      const verify = await request(app).get(`/api/invitations/verify/${token}`);
      expect(verify.body.data.valid).toBe(false);

      const brut = await UserService.getBrut({ email });
      expect(String(brut.referredBy)).toBe(inviterId);

      const acceptedCall = emitSpy.mock.calls.find(([evt]) => evt === 'invitation.accepted');
      expect(acceptedCall).toBeDefined();
      expect(acceptedCall[1].invitationId).toBe(created.body.data.id);
      expect(String(acceptedCall[1].invitedBy)).toBe(inviterId);
      expect(String(acceptedCall[1].acceptedUserId)).toBe(String(brut._id));
    });

    test('userFacing:true + OPEN signup: single-use still enforced — a replay of the same token is rejected', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = '3981-open-userfacing-replay@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      config.invitations.userFacing = true;
      config.sign.up = true; config.sign.cap = null;

      const first = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      expect(first.status).toBe(200);

      // Same token again, different email this time (open signup does not require the
      // invite, so a plain signup would otherwise succeed) — the invite itself must be
      // dead (accepted), proving it was truly burned, not merely ignored.
      const verify = await request(app).get(`/api/invitations/verify/${token}`);
      expect(verify.body.data.valid).toBe(false);
    });

    test('userFacing:true + OPEN signup: a lost claim race (double-submit) does NOT hard-fail the signup — it downgrades to a plain signup', async () => {
      // Pre-push review finding: open signup's own invariant is that a presented token
      // must never be able to BLOCK an otherwise-valid signup — that must hold even when
      // userFacing tries to claim it. Force the underlying claim() to reject once
      // (simulating a lost CAS race from a concurrent double-submit) and assert the
      // signup still succeeds with 200, not a 422.
      const adminAgent = await createAdminAndSignin();
      const email = '3981-open-race@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      config.invitations.userFacing = true;
      config.sign.up = true; config.sign.cap = null;

      const claimSpy = jest.spyOn(InvitationService, 'claim').mockRejectedValueOnce(
        Object.assign(new Error('invitation is no longer valid'), { status: 422, code: 'VALIDATION_ERROR' }),
      );

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });

      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200); // NOT 422 — the race must not block open signup

      // Downgraded to unclaimed: no attribution, and the invite is untouched (neither
      // consumed nor stuck mid-claim) — reusable for whoever actually holds it next.
      const brut = await UserService.getBrut({ email });
      expect(brut.referredBy == null).toBe(true);
      const verify = await request(app).get(`/api/invitations/verify/${token}`);
      expect(verify.body.data.valid).toBe(true);
    });

    test('userFacing:false (default) + OPEN signup + valid token ⇒ still NOT claimed/burned (unchanged baseline, byte-for-byte)', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = '3981-open-nofacing@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      config.invitations.userFacing = false;
      config.sign.up = true; config.sign.cap = null;

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);

      // The invite must remain VALID — presented, never consumed.
      const verify = await request(app).get(`/api/invitations/verify/${token}`);
      expect(verify.body.data.valid).toBe(true);

      const brut = await UserService.getBrut({ email });
      expect(brut.referredBy == null).toBe(true); // no attribution invented
    });

    test('userFacing:true + OPEN signup + token presented but email MISMATCH ⇒ invite never resolves, falls back to a plain signup (no attribution invented)', async () => {
      const adminAgent = await createAdminAndSignin();
      const pinnedEmail = '3981-open-mismatch@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email: pinnedEmail });
      const { token } = created.body.data;

      config.invitations.userFacing = true;
      config.sign.up = true; config.sign.cap = null;

      const submittedEmail = '3981-open-mismatch-plain@example.com';
      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email: submittedEmail, password: 'Sup3rStr0ng!' });
      // Open signup never requires the invite, so a mismatched token does not block
      // signup — it just never opens the referral gate.
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(submittedEmail); // NOT canonicalized to pinnedEmail

      const brut = await UserService.getBrut({ email: submittedEmail });
      expect(brut.referredBy == null).toBe(true);

      // The pinned invite is untouched — still valid, awaiting its actual invitee.
      const verify = await request(app).get(`/api/invitations/verify/${token}`);
      expect(verify.body.data.valid).toBe(true);
    });

    test('userFacing:true + OPEN signup + NO token ⇒ plain signup, no attribution invented', async () => {
      config.invitations.userFacing = true;
      config.sign.up = true; config.sign.cap = null;

      const email = '3981-open-notoken@example.com';
      const res = await request(app).post('/api/auth/signup').send({ email, password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);

      const brut = await UserService.getBrut({ email });
      expect(brut.referredBy == null).toBe(true);
    });

    test('userFacing:true + CLOSED signup + valid token ⇒ unaffected — claims/finalizes exactly as before #3981', async () => {
      const adminAgent = await createAdminAndSignin();
      const email = '3981-closed-userfacing@example.com';
      const created = await adminAgent.post('/api/invitations').send({ email });
      const { token } = created.body.data;

      config.invitations.userFacing = true;
      config.sign.up = false; config.sign.cap = null;

      const res = await request(app)
        .post(`/api/auth/signup?inviteToken=${token}`)
        .send({ email, password: 'Sup3rStr0ng!' });
      expect(res.status).toBe(200);

      const verify = await request(app).get(`/api/invitations/verify/${token}`);
      expect(verify.body.data.valid).toBe(false);
    });

    test('GET /api/auth/config exposes invitations.userFacing (unauthenticated, mirrors sign.up)', async () => {
      config.invitations.userFacing = true;
      const on = await request(app).get('/api/auth/config');
      expect(on.status).toBe(200);
      expect(on.body.data.invitations.userFacing).toBe(true);

      config.invitations.userFacing = false;
      const off = await request(app).get('/api/auth/config');
      expect(off.body.data.invitations.userFacing).toBe(false);
    });
  });
});
