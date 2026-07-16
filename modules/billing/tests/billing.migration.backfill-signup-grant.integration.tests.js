/**
 * Module dependencies.
 */
import mongoose from 'mongoose';
import { describe, beforeAll, afterEach, afterAll, test, expect, jest } from '@jest/globals';

import mongooseService from '../../../lib/services/mongoose.js';
import config from '../../../config/index.js';
import { up as backfillSignupGrants } from '../migrations/20260707100000-backfill-missing-signup-grant-credits.js';

/**
 * Integration tests for the signup-grant backfill migration.
 *
 * Regression guard for the string-vs-ObjectId bug: billingextrabalances.organization
 * is Schema.ObjectId, so the migration MUST credit orgs through a path that casts to
 * ObjectId (it delegates to grantOnSignup → the Mongoose repository) — a raw-driver
 * write keyed on a string would create orphan, app-invisible ghost documents.
 *
 * The migration's `up()` takes no arguments — it scans the ENTIRE shared
 * `organizations` collection filtered only by plan. Run unscoped against the real
 * test DB, it would also silently credit any leftover grant-plan orgs left behind
 * by other integration test files (crashed runs, ordering quirks), mutating state
 * outside this test's ownership. `runScopedMigration` patches the `organizations`
 * collection's `find()` for the duration of a single `up()` call so it only ever
 * sees this test's own seeded fixture ids — the real migration logic (plan filter,
 * grantOnSignup delegation, idempotency) is untouched, only its blast radius is.
 */
describe('backfill-missing-signup-grant migration (integration):', () => {
  let organizations;
  let extraBalances;
  let grantPlanId;
  let grantAmount;
  let createdOrgIds = [];

  /**
   * Seed an organization on the given plan and track it for cleanup.
   * @param {string} plan - The plan id to set on the org.
   * @returns {Promise<import('mongoose').Types.ObjectId>} The new org ObjectId.
   */
  const seedOrg = async (plan) => {
    const _id = new mongoose.Types.ObjectId();
    await organizations.insertOne({ _id, name: `IT ${_id.toString()}`, plan });
    createdOrgIds.push(_id);
    return _id;
  };

  /**
   * Run the real migration `up()` scoped to only the given org ids — intersects the
   * migration's own `{ plan: { $in: grantPlanIds } }` query with `_id: { $in: orgIds }`
   * for the duration of the call, so it can never reach an org outside this test's
   * fixtures, then restores the unpatched collection.
   * @param {import('mongoose').Types.ObjectId[]} orgIds - Fixture ids owned by this test.
   * @returns {Promise<void>}
   */
  const runScopedMigration = async (orgIds) => {
    const realCollection = mongoose.connection.db.collection.bind(mongoose.connection.db);
    const spy = jest.spyOn(mongoose.connection.db, 'collection').mockImplementation((name) => {
      const coll = realCollection(name);
      if (name !== 'organizations') return coll;
      const realFind = coll.find.bind(coll);
      return { find: (filter, options) => realFind({ ...filter, _id: { $in: orgIds } }, options) };
    });
    try {
      await backfillSignupGrants();
    } finally {
      spy.mockRestore();
    }
  };

  beforeAll(async () => {
    await mongooseService.loadModels();
    await mongooseService.connect();
    organizations = mongoose.connection.db.collection('organizations');
    extraBalances = mongoose.connection.db.collection('billingextrabalances');
    const def = (config?.billing?.planDefinitions ?? []).find(
      (d) => typeof d.signupGrant === 'number' && d.signupGrant > 0,
    );
    grantPlanId = def.planId;
    grantAmount = def.signupGrant;
  });

  afterEach(async () => {
    if (createdOrgIds.length) {
      await organizations.deleteMany({ _id: { $in: createdOrgIds } });
      await extraBalances.deleteMany({ organization: { $in: createdOrgIds } });
      createdOrgIds = [];
    }
  });

  afterAll(async () => {
    await mongooseService.disconnect();
  });

  test('credits the configured grant to an ObjectId-keyed org missing it, readable by ObjectId', async () => {
    const orgId = await seedOrg(grantPlanId);

    await runScopedMigration(createdOrgIds);

    // Stored + readable keyed on the ObjectId — the critical-fix assertion.
    const eb = await extraBalances.findOne({ organization: orgId });
    expect(eb).not.toBeNull();
    expect(eb.cachedBalance).toBe(grantAmount);
    const grant = (eb.ledger || []).find((e) => e.source === 'signup_grant');
    expect(grant).toBeDefined();
    expect(grant.amount).toBe(grantAmount);
    expect(grant.refId).toBe(`signup_grant-${orgId.toString()}`);
    // A string-keyed lookup must NOT find a duplicate ghost document.
    expect(await extraBalances.findOne({ organization: orgId.toString() })).toBeNull();
  });

  test('is idempotent — a second run does not double-credit', async () => {
    const orgId = await seedOrg(grantPlanId);

    await runScopedMigration(createdOrgIds);
    await runScopedMigration(createdOrgIds);

    const docs = await extraBalances.find({ organization: orgId }).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0].cachedBalance).toBe(grantAmount);
    const grants = (docs[0].ledger || []).filter((e) => e.source === 'signup_grant');
    expect(grants).toHaveLength(1);
  });

  test('skips an org that already holds a signup_grant entry', async () => {
    const orgId = await seedOrg(grantPlanId);
    const repo = (await import('../repositories/billing.extraBalance.repository.js')).default;
    await repo.creditGrant(orgId.toString(), grantAmount, 'signup_grant');

    await runScopedMigration(createdOrgIds);

    const docs = await extraBalances.find({ organization: orgId }).toArray();
    expect(docs).toHaveLength(1);
    const grants = (docs[0].ledger || []).filter((e) => e.source === 'signup_grant');
    expect(grants).toHaveLength(1);
  });
});
