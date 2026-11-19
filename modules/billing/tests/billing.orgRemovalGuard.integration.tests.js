/**
 * Module dependencies.
 */
import request from 'supertest';
import path from 'path';
import mongoose from 'mongoose';
import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import config from '../../../config/index.js';

/**
 * Organization removal with a live paid subscription (#4321), through the real Express
 * app + Mongo: billing's before-removal guard refuses with 409 while the subscription is
 * active, trialing or past_due — for the owner's DELETE /api/organizations/:id and for
 * the account deletion cascade (DELETE /api/users, DELETE /api/admin/users/:userId) — and
 * nothing is deleted. Once the subscription is canceled, or set to end at period end, the
 * removal goes through.
 */
describe('Billing org-removal guard (#4321):', () => {
  let agent;
  let UserService;
  let Subscription;
  let Organization;
  let Membership;
  let user;
  let personalOrgId;
  let paidOrgId;
  let originalOrganizations;
  let adminAgent;

  const email = 'billing-org-removal-guard@test.com';
  const adminEmail = 'billing-org-removal-guard-admin@test.com';
  const refusal = 'Cancel the subscription of "Paid workspace" before removing it.';

  /**
   * Create one more organization owned by the test user, with a paid subscription.
   * @param {string} name - Organization name.
   * @param {Object} fields - Extra subscription fields.
   * @returns {Promise<string>} The organization id.
   */
  const createPaidOrg = async (name, fields = {}) => {
    const res = await agent.post('/api/organizations').send({ name }).expect(200);
    const orgId = String(res.body.data._id || res.body.data.id);
    await Subscription.create({
      organization: orgId,
      stripeCustomerId: `cus_${orgId}`,
      stripeSubscriptionId: `sub_${orgId}`,
      plan: config.billing.plans.find((p) => p !== 'free') ?? 'free',
      status: 'active',
      ...fields,
    });
    return orgId;
  };

  const cleanup = async () => {
    try {
      const admin = await UserService.getBrut({ email: adminEmail });
      if (admin) {
        const memberships = await Membership.find({ userId: admin._id }).lean();
        const orgIds = memberships.map((m) => m.organizationId);
        await Membership.deleteMany({ organizationId: { $in: orgIds } });
        await Organization.deleteMany({ _id: { $in: orgIds } });
        await UserService.remove(admin);
      }
    } catch (_) { /* cleanup — ignore errors */ }
    try {
      const existing = await UserService.getBrut({ email });
      if (existing) {
        const memberships = await Membership.find({ userId: existing._id }).lean();
        const orgIds = memberships.map((m) => m.organizationId);
        await Subscription.deleteMany({ organization: { $in: orgIds } });
        await Membership.deleteMany({ organizationId: { $in: orgIds } });
        await Organization.deleteMany({ _id: { $in: orgIds } });
        await UserService.remove(existing);
      }
    } catch (_) { /* cleanup — ignore errors */ }
  };

  beforeAll(async () => {
    const init = await bootstrap();
    agent = request.agent(init.app);
    UserService = (await import(path.resolve('./modules/users/services/users.service.js'))).default;
    Subscription = mongoose.model('Subscription');
    Organization = mongoose.model('Organization');
    Membership = mongoose.model('Membership');
    originalOrganizations = config.organizations;
    config.organizations = { ...originalOrganizations, enabled: true, domainMatching: false };
    await cleanup();

    const signup = await agent.post('/api/auth/signup').send({
      firstName: 'Guard', lastName: 'Owner', email, password: 'W@os.jsI$Aw3$0m3', provider: 'local',
    }).expect(200);
    user = signup.body.user;
    const brut = await UserService.getBrut({ email });
    personalOrgId = String(brut.currentOrganization?._id || brut.currentOrganization);

    // A second organization, so the "last organization" protection does not answer first.
    paidOrgId = await createPaidOrg('Paid workspace');

    // A platform admin, for DELETE /api/admin/users/:userId.
    adminAgent = request.agent(init.app);
    await adminAgent.post('/api/auth/signup').send({
      firstName: 'Guard', lastName: 'Admin', email: adminEmail, password: 'W@os.jsI$Aw3$0m3', provider: 'local',
    }).expect(200);
    const adminBrut = await UserService.getBrut({ email: adminEmail });
    await UserService.update(adminBrut, { roles: ['user', 'admin'] }, 'admin');
  });

  afterAll(async () => {
    await cleanup();
    config.organizations = originalOrganizations;
  });

  test('DELETE /api/organizations/:id answers 409 while the paid subscription is live, and deletes nothing', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      await Subscription.updateOne({ organization: paidOrgId }, { $set: { status } });

      const res = await agent.delete(`/api/organizations/${paidOrgId}`).expect(409);

      expect(res.body.errorCode).toBe('ORGANIZATION_HAS_LIVE_SUBSCRIPTION');
      expect(res.body.description).toBe(refusal);
      expect(await Organization.exists({ _id: paidOrgId })).toBeTruthy();
      expect(await Membership.countDocuments({ organizationId: paidOrgId })).toBe(1);
    }
  });

  test('DELETE /api/users answers 409 when a solely-owned organization has a live paid subscription, and deletes nothing', async () => {
    await Subscription.updateOne({ organization: paidOrgId }, { $set: { status: 'active' } });

    const res = await agent.delete('/api/users').expect(409);

    expect(res.body.errorCode).toBe('ORGANIZATION_HAS_LIVE_SUBSCRIPTION');
    expect(res.body.description).toBe(refusal);
    expect(await UserService.getBrut({ email })).toBeTruthy();
    expect(await Organization.exists({ _id: personalOrgId })).toBeTruthy();
    expect(await Organization.exists({ _id: paidOrgId })).toBeTruthy();
    expect(await Membership.countDocuments({ userId: user._id || user.id })).toBe(2);
  });

  test('DELETE /api/admin/users/:userId answers 409 when a solely-owned organization has a live paid subscription, and deletes nothing', async () => {
    await Subscription.updateOne({ organization: paidOrgId }, { $set: { status: 'active' } });

    const res = await adminAgent.delete(`/api/admin/users/${user._id || user.id}`).expect(409);

    expect(res.body.errorCode).toBe('ORGANIZATION_HAS_LIVE_SUBSCRIPTION');
    expect(res.body.description).toBe(refusal);
    expect(await UserService.getBrut({ email })).toBeTruthy();
    expect(await Organization.exists({ _id: personalOrgId })).toBeTruthy();
    expect(await Organization.exists({ _id: paidOrgId })).toBeTruthy();
    expect(await Membership.countDocuments({ userId: user._id || user.id })).toBe(2);
  });

  test('a subscription already set to end (cancelAtPeriodEnd) counts as cancelled: DELETE /api/organizations/:id removes the organization', async () => {
    const endingOrgId = await createPaidOrg('Ending workspace', { cancelAtPeriodEnd: true });

    await agent.delete(`/api/organizations/${endingOrgId}`).expect(200);

    expect(await Organization.exists({ _id: endingOrgId })).toBeFalsy();
  });

  test('a subscription cancelled at a set date (cancelAt, portal cancel, cancelAtPeriodEnd false) counts as cancelled: DELETE /api/organizations/:id removes the organization', async () => {
    const portalOrgId = await createPaidOrg('Portal cancel workspace', {
      cancelAtPeriodEnd: false,
      cancelAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });

    await agent.delete(`/api/organizations/${portalOrgId}`).expect(200);

    expect(await Organization.exists({ _id: portalOrgId })).toBeFalsy();
  });

  test('once the subscription is canceled, DELETE /api/organizations/:id removes the organization', async () => {
    await Subscription.updateOne({ organization: paidOrgId }, { $set: { status: 'canceled' } });

    await agent.delete(`/api/organizations/${paidOrgId}`).expect(200);

    expect(await Organization.exists({ _id: paidOrgId })).toBeFalsy();
  });
});
