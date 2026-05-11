/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';

/**
 * Integration tests for organization routes.
 * Verifies that authenticated users can access organization endpoints
 * without receiving 403 errors.
 */
describe('Organizations integration tests:', () => {
  let UserService;
  let OrganizationsRepository;
  let MembershipRepository;
  let agent;

  // Store original config
  const originalOrganizations = { ...config.organizations };

  /**
   * @description Clean up a user and their associated organizations/memberships.
   * @param {Object} user - The user object to clean up.
   * @returns {Promise<void>}
   */
  const cleanupUser = async (user) => {
    if (!user) return;
    try {
      const memberships = await MembershipRepository.list({ userId: user.id || user._id });
      for (const m of memberships) {
        const orgId = m.organizationId._id || m.organizationId;
        await MembershipRepository.deleteMany({ organizationId: orgId });
        await OrganizationsRepository.deleteMany({ _id: orgId });
      }
      await UserService.remove(user);
    } catch (_) { /* cleanup — ignore errors */ }
  };

  // init
  beforeAll(async () => {
    try {
      const init = await bootstrap();
      UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
      OrganizationsRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.repository.js'))).default;
      MembershipRepository = (await import(path.resolve('./modules/organizations/repositories/organizations.membership.repository.js'))).default;
      agent = request.agent(init.app);
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('GET /api/organizations', () => {
    let user;

    beforeAll(async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
      try {
        const result = await agent
          .post('/api/auth/signup')
          .send({
            firstName: 'OrgList',
            lastName: 'User',
            email: 'orglist@test.com',
            password: 'W@os.jsI$Aw3$0m3',
            provider: 'local',
          })
          .expect(200);
        user = result.body.user;
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    test('should return 200 and an array for an authenticated user', async () => {
      try {
        const result = await agent.get('/api/organizations').expect(200);

        expect(result.body.type).toBe('success');
        expect(result.body.message).toBe('organization list');
        expect(result.body.data).toBeInstanceOf(Array);
      } catch (err) {
        console.log(err);
        expect(err).toBeFalsy();
      }
    });

    afterAll(async () => {
      await cleanupUser(user);
    });
  });

  describe('GET /api/organizations/:id/requests (pending requests permissions)', () => {
    let owner;
    let member;
    let ownerAgent;
    let memberAgent;
    let org;

    beforeAll(async () => {
      config.organizations = { enabled: true, autoCreate: true, domainMatching: false };
      ownerAgent = request.agent((await bootstrap()).app);
      memberAgent = request.agent((await bootstrap()).app);

      // Create owner with auto-created org
      const ownerRes = await ownerAgent
        .post('/api/auth/signup')
        .send({ firstName: 'Owner', lastName: 'Test', email: 'owner-req@test.com', password: 'W@os.jsI$Aw3$0m3', provider: 'local' })
        .expect(200);
      owner = ownerRes.body.user;

      const orgsRes = await ownerAgent.get('/api/organizations').expect(200);
      org = orgsRes.body.data[0];

      // Create member and add to same org
      const memberRes = await memberAgent
        .post('/api/auth/signup')
        .send({ firstName: 'Member', lastName: 'Test', email: 'member-req@test.com', password: 'W@os.jsI$Aw3$0m3', provider: 'local' })
        .expect(200);
      member = memberRes.body.user;

      // Add member to owner's org as 'member'
      const MembershipService = (await import(path.resolve('./modules/organizations/services/organizations.membership.service.js'))).default;
      await MembershipService.create({ userId: member._id || member.id, organizationId: org._id || org.id, role: 'member' });
    });

    test('owner should see pending requests — 200 with array', async () => {
      const result = await ownerAgent.get(`/api/organizations/${org._id || org.id}/requests`).expect(200);
      expect(result.body.data).toBeInstanceOf(Array);
    });

    test('member should get empty array for pending requests — 200', async () => {
      const result = await memberAgent.get(`/api/organizations/${org._id || org.id}/requests`).expect(200);
      expect(result.body.data).toEqual([]);
    });

    afterAll(async () => {
      await cleanupUser(owner);
      await cleanupUser(member);
    });
  });

  describe('N2 — signup grant credited on org creation', () => {
    let grantUser;
    let BillingExtraBalanceRepository;

    beforeAll(async () => {
      config.organizations = { enabled: false };
      BillingExtraBalanceRepository = (await import(path.resolve('./modules/billing/repositories/billing.extraBalance.repository.js'))).default;

      // Reuse the top-level agent (same bootstrap instance) — no duplicate Express app.
      const res = await agent
        .post('/api/auth/signup')
        .send({
          firstName: 'Grant',
          lastName: 'Test',
          email: 'signup-grant-test@test.com',
          password: 'W@os.jsI$Aw3$0m3',
          provider: 'local',
        })
        .expect(200);
      grantUser = res.body.user;
    });

    test('credits 500 compute to the org ExtraBalance ledger at signup', async () => {
      // Resolve the org created for this user
      const memberships = await MembershipRepository.list({ userId: grantUser._id || grantUser.id });
      expect(memberships.length).toBeGreaterThan(0);
      const orgId = (memberships[0].organizationId._id || memberships[0].organizationId).toString();

      const balance = await BillingExtraBalanceRepository.getBalance(orgId);
      expect(balance).toBe(500);

      const ledger = await BillingExtraBalanceRepository.findLedgerByOrg(orgId);
      expect(ledger).not.toBeNull();
      const grantEntry = ledger.find((e) => e.source === 'signup_grant');
      expect(grantEntry).toBeDefined();
      expect(grantEntry.amount).toBe(500);
    });

    afterAll(async () => {
      await cleanupUser(grantUser);
    });
  });

  // Mongoose disconnect
  afterAll(async () => {
    config.organizations = { ...originalOrganizations };
    try {
      await mongooseService.disconnect();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });
});
