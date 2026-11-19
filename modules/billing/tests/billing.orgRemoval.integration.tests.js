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
 * the account deletion cascade (DELETE /api/users) — and nothing is deleted. Once the
 * subscription is canceled, the removal goes through.
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

  const email = 'billing-org-removal-guard@test.com';

  const cleanup = async () => {
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
    const created = await agent.post('/api/organizations').send({ name: 'Paid workspace' }).expect(200);
    paidOrgId = String(created.body.data._id || created.body.data.id);
    await Subscription.create({
      organization: paidOrgId,
      stripeCustomerId: 'cus_org_removal_guard',
      stripeSubscriptionId: 'sub_org_removal_guard',
      plan: config.billing.plans.find((p) => p !== 'free') ?? 'free',
      status: 'active',
    });
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
      expect(res.body.description).toBe("Cancel the organization's subscription before removing it.");
      expect(await Organization.exists({ _id: paidOrgId })).toBeTruthy();
      expect(await Membership.countDocuments({ organizationId: paidOrgId })).toBe(1);
    }
  });

  test('DELETE /api/users answers 409 when a solely-owned organization has a live paid subscription, and deletes nothing', async () => {
    await Subscription.updateOne({ organization: paidOrgId }, { $set: { status: 'active' } });

    const res = await agent.delete('/api/users').expect(409);

    expect(res.body.errorCode).toBe('ORGANIZATION_HAS_LIVE_SUBSCRIPTION');
    expect(await UserService.getBrut({ email })).toBeTruthy();
    expect(await Organization.exists({ _id: personalOrgId })).toBeTruthy();
    expect(await Organization.exists({ _id: paidOrgId })).toBeTruthy();
    expect(await Membership.countDocuments({ userId: user._id || user.id })).toBe(2);
  });

  test('once the subscription is canceled, DELETE /api/organizations/:id removes the organization', async () => {
    await Subscription.updateOne({ organization: paidOrgId }, { $set: { status: 'canceled' } });

    await agent.delete(`/api/organizations/${paidOrgId}`).expect(200);

    expect(await Organization.exists({ _id: paidOrgId })).toBeFalsy();
  });
});
