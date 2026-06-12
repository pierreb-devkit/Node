/**
 * Module dependencies
 */
import mongoose from 'mongoose';

import { MEMBERSHIP_STATUSES, PENDING_SOURCES } from '../lib/constants.js';

/**
 * Migration: backfill `source` on existing PENDING memberships.
 *
 * The consent split (P5a) adds a `source` discriminator to PENDING memberships:
 *   - 'join_request' — the user asked to join (owner approves → ACTIVE);
 *   - 'owner_add'    — an owner added the user (the invited user accepts → ACTIVE).
 *
 * Every PENDING membership that existed BEFORE this change was a join request (the
 * owner_add flow did not exist), so they are all backfilled to 'join_request'.
 *
 * Why this matters (E17 migration ordering): the new code reads the owner-approval
 * surface as `source: 'join_request' OR source absent` so legacy rows stay visible
 * until this backfill runs. After this migration, every PENDING row carries an
 * explicit source and the `$exists:false` fallback in the service/controller can be
 * removed (follow-up). Downstream rollouts MUST run this migration BEFORE deploying any code
 * that filters owner_adds out of the approval surface, so no join request is ever
 * hidden.
 *
 * `source` IS declared on the schema now, so a model `updateMany` `$set` would NOT
 * be stripped by strict mode. We nonetheless use the RAW collection driver to match
 * the house migration style and to be robust regardless of model-registration state
 * at migration time. ACTIVE memberships are intentionally left untouched (source is
 * only meaningful while PENDING).
 *
 * Idempotent: the filter requires `source` ABSENT, so a second run matches nothing.
 * @returns {Promise<void>} Resolves when the backfill has completed.
 */
export async function up() {
  // Model `Membership` → default collection `memberships`.
  const db = mongoose.connection.db;
  const memberships = db.collection('memberships');

  const result = await memberships.updateMany(
    { status: MEMBERSHIP_STATUSES.PENDING, source: { $exists: false } },
    { $set: { source: PENDING_SOURCES.JOIN_REQUEST } },
  );

  const modified = result?.modifiedCount ?? 0;
  console.info(`[migration] backfill-membership-source: set source='join_request' on ${modified} pending membership(s)`);
}

/**
 * Down migration: unset `source` on the rows this backfill set (PENDING
 * join_requests). ACTIVE rows and owner_adds are untouched. Best-effort reversal.
 * @returns {Promise<void>} Resolves when the unset has completed.
 */
export async function down() {
  const db = mongoose.connection.db;
  const memberships = db.collection('memberships');
  await memberships.updateMany(
    { status: MEMBERSHIP_STATUSES.PENDING, source: PENDING_SOURCES.JOIN_REQUEST },
    { $unset: { source: '' } },
  );
  console.warn('[migration] backfill-membership-source DOWN: unset source on pending join_requests');
}
