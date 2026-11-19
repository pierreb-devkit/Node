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
 * org-removal handler (registered by billing.init at boot) deletes its subscription,
 * usage and extras balance, and leaves another organization's rows intact.
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

  /**
   * Seed an organization with one row in every org-scoped billing collection.
   * @param {import('mongoose').Types.ObjectId} orgId - the organization id
   * @param {string} slug - unique slug
   * @returns {Promise<void>}
   */
  const seed = async (orgId, slug) => {
    await Organization.create({ _id: orgId, name: slug, slug, plan: 'free' });
    await Subscription.create({ organization: orgId, plan: 'pro', status: 'active' });
    await BillingUsage.create({ organizationId: orgId, month: '2026-11', legacyPeriod: true });
    await BillingExtraBalance.create({
      organization: orgId,
      ledger: [{ kind: 'topup', source: 'referral', amount: 100, refId: `referral:${slug}:referrer`, at: new Date() }],
      cachedBalance: 100,
    });
  };

  const counts = async (orgId) => ({
    subscriptions: await Subscription.countDocuments({ organization: orgId }),
    usage: await BillingUsage.countDocuments({ organizationId: orgId }),
    extraBalances: await BillingExtraBalance.countDocuments({ organization: orgId }),
  });

  const cleanup = async () => {
    await Promise.all([
      Organization.deleteMany({ _id: { $in: orgIds } }),
      Subscription.deleteMany({ organization: { $in: orgIds } }),
      BillingUsage.deleteMany({ organizationId: { $in: orgIds } }),
      BillingExtraBalance.deleteMany({ organization: { $in: orgIds } }),
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

  test('removing an organization deletes only its billing data', async () => {
    const organization = await Organization.findById(removedId);
    await OrganizationsService.remove(organization);

    expect(await counts(removedId)).toEqual({ subscriptions: 0, usage: 0, extraBalances: 0 });
    expect(await counts(keptId)).toEqual({ subscriptions: 1, usage: 1, extraBalances: 1 });
  });
});
