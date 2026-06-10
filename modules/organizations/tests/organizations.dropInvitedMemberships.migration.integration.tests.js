/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

import { up } from '../migrations/20260610130000-drop-org-invited-memberships.js';

/**
 * Regression: `20260610130000-drop-org-invited-memberships` must unset the legacy
 * invite fields via the RAW collection driver.
 *
 * The Membership schema no longer declares `inviteToken` / `invitedEmail` /
 * `inviteExpiresAt`. A model-based `Membership.updateMany(..., { $unset })` would
 * have strict mode strip those keys from the update operator → the driver receives
 * no `$unset` and the fields survive (the bug this test guards). The migration
 * therefore writes via `db.collection('memberships')`.
 *
 * Crucial: docs are inserted AND read back via the raw collection. A model-based
 * read would project schema-less fields to `undefined` regardless of whether the
 * physical document still carries them — it would hide the bug. Reading raw is the
 * only way this test fails when the fix is reverted to the model-based `$unset`.
 */
describe('Migration drop-org-invited-memberships (raw $unset regression):', () => {
  let memberships;
  const orgId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  // Stable ids so we can target our own fixtures for read-back + cleanup.
  const survivingId = new mongoose.Types.ObjectId();
  const invitedId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await bootstrap();
    memberships = mongoose.connection.db.collection('memberships');

    // Clean any prior fixtures (idempotent across local re-runs).
    await memberships.deleteMany({ _id: { $in: [survivingId, invitedId] } });

    // (1) A SURVIVING active membership that still physically carries the three
    // legacy invite fields — inserted raw to bypass schema stripping.
    await memberships.insertOne({
      _id: survivingId,
      userId,
      organizationId: orgId,
      role: 'member',
      status: 'active',
      inviteToken: 'legacy-token-abc123',
      invitedEmail: 'legacy@example.com',
      inviteExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // (2) A leftover `status:'invited'` orphan row that the migration must DELETE.
    await memberships.insertOne({
      _id: invitedId,
      userId: null,
      organizationId: orgId,
      role: 'member',
      status: 'invited',
      inviteToken: 'orphan-token-xyz789',
      invitedEmail: 'orphan@example.com',
      inviteExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Run the migration under test.
    await up();
  });

  afterAll(async () => {
    try {
      await memberships.deleteMany({ _id: { $in: [survivingId, invitedId] } });
    } catch (_) { /* cleanup */ }
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });

  test('unsets inviteToken / invitedEmail / inviteExpiresAt on the surviving row (read RAW)', async () => {
    // Read via the raw collection — a model read would mask schema-less fields.
    const doc = await memberships.findOne({ _id: survivingId });

    expect(doc).not.toBeNull();
    // The row itself survives (it was active, not invited).
    expect(doc.status).toBe('active');
    // The three legacy fields are physically gone from the document.
    expect(doc).not.toHaveProperty('inviteToken');
    expect(doc).not.toHaveProperty('invitedEmail');
    expect(doc).not.toHaveProperty('inviteExpiresAt');
  });

  test("deletes the leftover status:'invited' row", async () => {
    const orphan = await memberships.findOne({ _id: invitedId });
    expect(orphan).toBeNull();
  });

  test('is idempotent — a second run is a no-op and leaves the surviving row clean', async () => {
    await up();
    const doc = await memberships.findOne({ _id: survivingId });
    expect(doc).not.toBeNull();
    expect(doc).not.toHaveProperty('inviteToken');
    expect(doc).not.toHaveProperty('invitedEmail');
    expect(doc).not.toHaveProperty('inviteExpiresAt');
  });
});
