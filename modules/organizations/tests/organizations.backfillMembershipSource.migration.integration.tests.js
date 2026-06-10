/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';
import { PENDING_SOURCES } from '../lib/constants.js';

import { up } from '../migrations/20260610140000-backfill-membership-source.js';

/**
 * Migration `20260610140000-backfill-membership-source` (P5a — #3813).
 *
 * Sets `source: 'join_request'` on all pre-existing PENDING memberships (they were
 * all join requests before the owner_add flow existed). Verified via the RAW
 * collection driver. Must:
 *   - backfill source on a sourceless PENDING row;
 *   - leave ACTIVE rows untouched (source only matters while PENDING);
 *   - NOT overwrite a row that already has a source;
 *   - be idempotent (a second run changes nothing).
 */
describe('Migration backfill-membership-source:', () => {
  let memberships;
  const orgId = new mongoose.Types.ObjectId();
  const userPending = new mongoose.Types.ObjectId();
  const userActive = new mongoose.Types.ObjectId();
  const pendingId = new mongoose.Types.ObjectId();
  const activeId = new mongoose.Types.ObjectId();
  const alreadySourcedId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await bootstrap();
    memberships = mongoose.connection.db.collection('memberships');
    await memberships.deleteMany({ _id: { $in: [pendingId, activeId, alreadySourcedId] } });

    // (1) Legacy PENDING row with NO source — the backfill target.
    await memberships.insertOne({
      _id: pendingId, userId: userPending, organizationId: orgId, role: 'member', status: 'pending',
      createdAt: new Date(), updatedAt: new Date(),
    });
    // (2) ACTIVE row with no source — must stay untouched.
    await memberships.insertOne({
      _id: activeId, userId: userActive, organizationId: orgId, role: 'owner', status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    });
    // (3) A PENDING row that already has a source — must NOT be overwritten.
    await memberships.insertOne({
      _id: alreadySourcedId, userId: new mongoose.Types.ObjectId(), organizationId: orgId, role: 'member',
      status: 'pending', source: PENDING_SOURCES.OWNER_ADD, createdAt: new Date(), updatedAt: new Date(),
    });

    await up();
  });

  afterAll(async () => {
    try {
      await memberships.deleteMany({ _id: { $in: [pendingId, activeId, alreadySourcedId] } });
    } catch (_) { /* cleanup */ }
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });

  test('backfills source=join_request on the sourceless PENDING row', async () => {
    const doc = await memberships.findOne({ _id: pendingId });
    expect(doc.source).toBe(PENDING_SOURCES.JOIN_REQUEST);
  });

  test('leaves the ACTIVE row untouched (no source added)', async () => {
    const doc = await memberships.findOne({ _id: activeId });
    expect(doc).not.toHaveProperty('source');
  });

  test('does NOT overwrite a row that already has a source', async () => {
    const doc = await memberships.findOne({ _id: alreadySourcedId });
    expect(doc.source).toBe(PENDING_SOURCES.OWNER_ADD);
  });

  test('is idempotent — a second run leaves everything as-is', async () => {
    await up();
    expect((await memberships.findOne({ _id: pendingId })).source).toBe(PENDING_SOURCES.JOIN_REQUEST);
    expect(await memberships.findOne({ _id: activeId })).not.toHaveProperty('source');
    expect((await memberships.findOne({ _id: alreadySourcedId })).source).toBe(PENDING_SOURCES.OWNER_ADD);
  });
});
