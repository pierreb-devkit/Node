/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { bootstrap } from '../../../lib/app.js';
import mongooseService from '../../../lib/services/mongoose.js';

import { up } from '../migrations/20261125120000-invitation-org-target.js';

/**
 * Migration `20261125120000-invitation-org-target`.
 *
 * Backfills `organizationId: null` + `role: null` on invitations written before the
 * organization target existed, and builds `{ organizationId: 1, status: 1 }`. Verified
 * through the RAW collection driver. Must:
 *   - backfill both fields on a legacy row (fields absent);
 *   - never overwrite a row that already carries an organization target;
 *   - be idempotent (a second run changes nothing);
 *   - leave the index in place.
 */
describe('Migration invitation-org-target:', () => {
  let invitations;
  const legacyId = new mongoose.Types.ObjectId();
  const targetedId = new mongoose.Types.ObjectId();
  const orgId = new mongoose.Types.ObjectId();
  const ids = [legacyId, targetedId];

  beforeAll(async () => {
    await bootstrap();
    invitations = mongoose.connection.db.collection('invitations');
    await invitations.deleteMany({ _id: { $in: ids } });

    const base = { expiresAt: new Date(Date.now() + 3600000), status: 'pending', createdAt: new Date(), updatedAt: new Date() };
    // (1) Legacy row — no organizationId / role keys at all.
    await invitations.insertOne({ _id: legacyId, email: 'legacy-mig@example.com', token: `mig-legacy-${legacyId}`, invitedBy: null, ...base });
    // (2) Row already targeting an organization — must stay as-is.
    await invitations.insertOne({
      _id: targetedId, email: 'targeted-mig@example.com', token: `mig-targeted-${targetedId}`, invitedBy: null, organizationId: orgId, role: 'admin', ...base,
    });

    await up();
  });

  afterAll(async () => {
    try {
      await invitations.deleteMany({ _id: { $in: ids } });
    } catch (_) { /* cleanup */ }
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });

  test('backfills organizationId:null and role:null on the legacy row (stored, not implied)', async () => {
    const doc = await invitations.findOne({ _id: legacyId });
    expect(doc).toHaveProperty('organizationId', null);
    expect(doc).toHaveProperty('role', null);
  });

  test('does NOT overwrite a row that already carries an organization target', async () => {
    const doc = await invitations.findOne({ _id: targetedId });
    expect(String(doc.organizationId)).toBe(String(orgId));
    expect(doc.role).toBe('admin');
  });

  test('builds the { organizationId: 1, status: 1 } index', async () => {
    const indexes = await invitations.indexes();
    expect(indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ organizationId: 1, status: 1 }))).toBe(true);
  });

  test('is idempotent — a second run leaves everything as-is', async () => {
    await up();
    const legacy = await invitations.findOne({ _id: legacyId });
    expect(legacy.organizationId).toBeNull();
    expect(legacy.role).toBeNull();
    const targeted = await invitations.findOne({ _id: targetedId });
    expect(String(targeted.organizationId)).toBe(String(orgId));
    expect(targeted.role).toBe('admin');
  });
});
