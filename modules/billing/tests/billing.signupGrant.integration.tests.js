/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, afterEach, afterAll, test, expect } from '@jest/globals';

import config from '../../../config/index.js';
import mongooseService from '../../../lib/services/mongoose.js';

/**
 * Integration tests for the signup grant, given once per user (#4351):
 * the first organization a user creates gets it, their next ones start at 0.
 * Runs the real service against the real Organization + BillingExtraBalance collections.
 */
describe('BillingSignupGrantService once-per-creator integration tests:', () => {
  let Organization;
  let BillingExtraBalance;
  let BillingSignupGrantService;
  let originalPlanDefinitions;
  let createdOrgIds = [];
  const grant = 500;

  /**
   * Create an organization, optionally with a creator, and track it for cleanup.
   * @param {import('mongoose').Types.ObjectId} [createdBy] - The creator user id.
   * @returns {Promise<string>} The new organization id.
   */
  const createOrg = async (createdBy) => {
    const _id = new mongoose.Types.ObjectId();
    await Organization.create({ _id, name: `Grant ${_id}`, slug: `grant-${_id}`, plan: 'free', ...(createdBy ? { createdBy } : {}) });
    createdOrgIds.push(_id);
    return String(_id);
  };

  /**
   * Read an organization's extras balance doc.
   * @param {string} orgId - The organization id.
   * @returns {Promise<Object|null>} The lean balance doc.
   */
  const balanceOf = (orgId) => BillingExtraBalance.findOne({ organization: orgId }).lean();

  beforeAll(async () => {
    originalPlanDefinitions = config.billing.planDefinitions;
    config.billing.planDefinitions = [{ planId: 'free', meterQuota: 0, signupGrant: grant, oneShot: true, ratios: { document: 1 } }];
    await mongooseService.loadModels();
    await mongooseService.connect();
    Organization = mongoose.model('Organization');
    BillingExtraBalance = mongoose.model('BillingExtraBalance');
    BillingSignupGrantService = (await import('../services/billing.signupGrant.service.js')).default;
  });

  afterEach(async () => {
    await BillingExtraBalance.deleteMany({ organization: { $in: createdOrgIds } });
    await Organization.deleteMany({ _id: { $in: createdOrgIds } });
    createdOrgIds = [];
  });

  afterAll(async () => {
    config.billing.planDefinitions = originalPlanDefinitions;
    await mongooseService.disconnect();
  });

  test('the first org of a user gets the grant, the second org of the same user starts at 0', async () => {
    const userId = new mongoose.Types.ObjectId();
    const firstOrg = await createOrg(userId);
    const secondOrg = await createOrg(userId);

    const first = await BillingSignupGrantService.grantOnSignup({ orgId: firstOrg });
    expect(first.applied).toBe(true);
    expect((await balanceOf(firstOrg)).cachedBalance).toBe(grant);

    const second = await BillingSignupGrantService.grantOnSignup({ orgId: secondOrg });
    expect(second).toEqual({ doc: null, applied: false, reason: 'creator_already_granted' });
    expect(await balanceOf(secondOrg)).toBeNull();
  });

  test('another user\'s org still gets its own grant', async () => {
    const firstOrg = await createOrg(new mongoose.Types.ObjectId());
    const otherUserOrg = await createOrg(new mongoose.Types.ObjectId());

    await BillingSignupGrantService.grantOnSignup({ orgId: firstOrg });
    const result = await BillingSignupGrantService.grantOnSignup({ orgId: otherUserOrg });

    expect(result.applied).toBe(true);
    expect((await balanceOf(otherUserOrg)).cachedBalance).toBe(grant);
  });

  test('orgs granted before the change keep their grant, ledger untouched', async () => {
    const userId = new mongoose.Types.ObjectId();
    const oldA = await createOrg(userId);
    const oldB = await createOrg(userId);
    // Both credited under the old rule (one grant per org).
    const repo = (await import('../repositories/billing.extraBalance.repository.js')).default;
    await repo.creditGrant(oldA, grant, 'signup_grant');
    await repo.creditGrant(oldB, grant, 'signup_grant');
    const before = await balanceOf(oldB);

    // A replay on the old org is a no-op either way: no clawback, no second entry.
    const replay = await BillingSignupGrantService.grantOnSignup({ orgId: oldB });
    expect(replay.applied).toBe(false);

    const after = await balanceOf(oldB);
    expect(after.cachedBalance).toBe(grant);
    expect(after.ledger).toHaveLength(before.ledger.length);
    expect((await balanceOf(oldA)).cachedBalance).toBe(grant);
  });

  test('an org without createdBy (legacy) still gets the grant', async () => {
    // A legacy org already granted must not make a creator-less org look "already granted".
    const legacyGranted = await createOrg();
    await BillingSignupGrantService.grantOnSignup({ orgId: legacyGranted });
    const legacyOrg = await createOrg();

    const result = await BillingSignupGrantService.grantOnSignup({ orgId: legacyOrg });

    expect(result.applied).toBe(true);
    expect((await balanceOf(legacyOrg)).cachedBalance).toBe(grant);
  });
});
