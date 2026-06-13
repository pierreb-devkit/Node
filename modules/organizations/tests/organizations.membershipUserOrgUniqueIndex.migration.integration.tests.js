/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import { PENDING_SOURCES } from '../lib/constants.js';

import { up } from '../migrations/20260612120000-membership-user-org-unique-index.js';

const INDEX_NAME = 'user_org_unique';

/**
 * Migration `20260612120000-membership-user-org-unique-index` (#3841).
 *
 * The old schema spec used `$ne` in its partialFilterExpression — unsupported by
 * MongoDB — so the unique (userId, organizationId) guard NEVER materialized on
 * any database (autoIndex failures land on the model's unlistened 'index' event).
 * Verifies the fixed end state via the RAW collection driver:
 *   - up() creates `user_org_unique` with the EXACT spec (key, unique, $type filter);
 *   - idempotent (a second run leaves exactly one index on the key);
 *   - a same-key index living under another name is dropped and replaced;
 *   - pre-existing duplicate (userId, organizationId) pairs ABORT the migration
 *     before any index work.
 */
describe('Migration membership-user-org-unique-index:', () => {
  let memberships;
  const orgId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await bootstrap();
    memberships = mongoose.connection.db.collection('memberships');
  });

  afterAll(async () => {
    try {
      await memberships.deleteMany({ organizationId: orgId });
    } catch (_) { /* cleanup */ }
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });

  const findIndex = async (name) => {
    const indexes = await memberships.listIndexes().toArray();
    return indexes.find((ix) => ix.name === name);
  };

  test('up() creates user_org_unique with the exact spec', async () => {
    await up();
    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.key).toEqual({ userId: 1, organizationId: 1 });
    expect(ix.unique).toBe(true);
    expect(ix.partialFilterExpression).toEqual({ userId: { $type: 'objectId' } });
  });

  test('is idempotent — a second run leaves exactly one index on the key', async () => {
    await up();
    await up();
    const indexes = await memberships.listIndexes().toArray();
    const sameKey = indexes.filter((ix) => ix.key && ix.key.userId === 1 && ix.key.organizationId === 1);
    expect(sameKey.length).toBe(1);
    expect(sameKey[0].name).toBe(INDEX_NAME);
  });

  test('drops a same-key index living under another name and installs the canonical one', async () => {
    try { await memberships.dropIndex(INDEX_NAME); } catch (_) { /* already absent */ }
    await memberships.createIndex({ userId: 1, organizationId: 1 }, { name: 'userId_1_organizationId_1' });
    await up();
    expect(await findIndex('userId_1_organizationId_1')).toBeUndefined();
    const ix = await findIndex(INDEX_NAME);
    expect(ix).toBeDefined();
    expect(ix.unique).toBe(true);
  });

  test('ABORTS on pre-existing duplicate (userId, organizationId) pairs without touching indexes', async () => {
    const dupA = new mongoose.Types.ObjectId();
    const dupB = new mongoose.Types.ObjectId();
    try {
      try { await memberships.dropIndex(INDEX_NAME); } catch (_) { /* already absent */ }
      await memberships.insertOne({
        _id: dupA, userId, organizationId: orgId, role: 'member', status: 'pending',
        source: PENDING_SOURCES.OWNER_ADD, createdAt: new Date(), updatedAt: new Date(),
      });
      await memberships.insertOne({
        _id: dupB, userId, organizationId: orgId, role: 'member', status: 'pending',
        source: PENDING_SOURCES.JOIN_REQUEST, createdAt: new Date(), updatedAt: new Date(),
      });
      await expect(up()).rejects.toThrow(/duplicate membership/);
      // Abort happened before any index work — the index is still absent.
      expect(await findIndex(INDEX_NAME)).toBeUndefined();
    } finally {
      await memberships.deleteMany({ _id: { $in: [dupA, dupB] } });
      await up(); // restore the migrated end state for the suites that follow
    }
  });
});
