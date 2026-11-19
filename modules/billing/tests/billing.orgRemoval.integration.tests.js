/**
 * Module dependencies.
 */
import path from 'path';
import mongoose from 'mongoose';
import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';

import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Org removal cleans the removed organization's billing data (#4306): the billing
 * org-removal handler (registered by billing.init at boot) keeps its subscription and
 * extras balance, anonymized under one tombstone id (ledger unchanged), deletes its usage,
 * and leaves another organization's rows intact.
 */
describe('Billing org-removal cleanup integration tests:', () => {
  let OrganizationsService;
  let Organization;
  let Subscription;
  let BillingUsage;
  let BillingExtraBalance;

  const removedId = new mongoose.Types.ObjectId();
  const keptId = new mongoose.Types.ObjectId();
  const orgIds = [removedId, keptId];
  const seeded = { subscriptions: [], balances: [] };

  /**
   * Seed an organization with one row in every org-scoped billing collection.
   * @param {import('mongoose').Types.ObjectId} orgId - the organization id
   * @param {string} slug - unique slug
   * @returns {Promise<void>}
   */
  const seed = async (orgId, slug) => {
    await Organization.create({ _id: orgId, name: slug, slug, plan: 'free' });
    const sub = await Subscription.create({ organization: orgId, plan: 'pro', status: 'active', stripeCustomerId: `cus_${slug}` });
    await BillingUsage.create({ organizationId: orgId, month: '2026-11', legacyPeriod: true });
    const balance = await BillingExtraBalance.create({
      organization: orgId,
      ledger: [{ kind: 'topup', source: 'referral', amount: 100, refId: `referral:${slug}:referrer`, at: new Date() }],
      cachedBalance: 100,
    });
    seeded.subscriptions.push(sub._id);
    seeded.balances.push(balance._id);
  };

  const counts = async (orgId) => ({
    subscriptions: await Subscription.countDocuments({ organization: orgId }),
    usage: await BillingUsage.countDocuments({ organizationId: orgId }),
    extraBalances: await BillingExtraBalance.countDocuments({ organization: orgId }),
  });

  const cleanup = async () => {
    await Promise.all([
      Organization.deleteMany({ _id: { $in: orgIds } }),
      Subscription.deleteMany({ $or: [{ organization: { $in: orgIds } }, { _id: { $in: seeded.subscriptions } }] }),
      BillingUsage.deleteMany({ organizationId: { $in: orgIds } }),
      BillingExtraBalance.deleteMany({ $or: [{ organization: { $in: orgIds } }, { _id: { $in: seeded.balances } }] }),
    ]);
  };

  beforeAll(async () => {
    await bootstrap();
    OrganizationsService = (await import(path.resolve('./modules/organizations/services/organizations.crud.service.js'))).default;
    Organization = mongoose.model('Organization');
    Subscription = mongoose.model('Subscription');
    BillingUsage = mongoose.model('BillingUsage');
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    await cleanup();
    await seed(removedId, 'billing-org-removal-gone');
    await seed(keptId, 'billing-org-removal-kept');
  });

  afterAll(async () => {
    await cleanup();
    await mongooseService.disconnect();
  });

  test('removing an organization anonymizes its billing records, deletes its usage, leaves others intact', async () => {
    const organization = await Organization.findById(removedId);
    await OrganizationsService.remove(organization);

    // Nothing is left under the removed organization id.
    expect(await counts(removedId)).toEqual({ subscriptions: 0, usage: 0, extraBalances: 0 });

    // Subscription and extras balance are kept under one shared tombstone id.
    const sub = await Subscription.findById(seeded.subscriptions[0]).lean();
    const balance = await BillingExtraBalance.findById(seeded.balances[0]).lean();
    expect(sub).not.toBeNull();
    expect(balance).not.toBeNull();
    expect(String(sub.organization)).not.toBe(String(removedId));
    expect(String(balance.organization)).toBe(String(sub.organization));
    expect(await Organization.exists({ _id: sub.organization })).toBeNull();

    // Nothing else of the financial record changed.
    expect(sub).toMatchObject({ plan: 'pro', status: 'active', stripeCustomerId: 'cus_billing-org-removal-gone' });
    expect(balance.cachedBalance).toBe(100);
    expect(balance.ledger).toHaveLength(1);
    expect(balance.ledger[0]).toMatchObject({ kind: 'topup', source: 'referral', amount: 100, refId: 'referral:billing-org-removal-gone:referrer' });

    // The other organization is untouched.
    expect(await counts(keptId)).toEqual({ subscriptions: 1, usage: 1, extraBalances: 1 });
  });
});
