/**
 * Module dependencies
 */
import mongoose from 'mongoose';

/**
 * Migration: Rename consumedHistoryIds → consumedAttributionKeys + backfill key format
 *
 * Background: PR #3576 introduced per-step idempotency keys in the format
 * `${historyId}:${stepKey}` (e.g. "507f1f77bcf86cd799439011:initial").
 * However the schema field `consumedHistoryIds` was typed `[Schema.ObjectId]`,
 * causing Mongoose to throw CastError for every string key written — silently
 * swallowed in _attributeMeter, meaning all meter attributions failed.
 *
 * This migration:
 * 1. Converts legacy raw ObjectId entries to `${id}:initial` strings (preserving
 *    replay protection for pre-#3576 attributions).
 * 2. Renames the field from `consumedHistoryIds` to `consumedAttributionKeys`.
 * 3. Is idempotent: documents already migrated (no `consumedHistoryIds` field) are skipped.
 *
 * Uses raw collection driver (not Mongoose model) so that $unset of the legacy field
 * is not stripped by strict-mode schema enforcement.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const collection = mongoose.connection.db.collection('billingusages');

  // Process in batches to avoid memory pressure on large collections
  const BATCH_SIZE = 500;
  let processed = 0;

  const cursor = collection.find(
    { consumedHistoryIds: { $exists: true } },
    { projection: { _id: 1, consumedHistoryIds: 1 } },
  );

  const ops = [];

  for await (const doc of cursor) {
    const legacyIds = Array.isArray(doc.consumedHistoryIds) ? doc.consumedHistoryIds : [];

    // Backfill: convert raw ObjectId strings to id:initial format
    const migrated = legacyIds.map((entry) => {
      const str = entry?.toString?.() ?? String(entry);
      // Already in new format (contains colon) — preserve as-is
      if (str.includes(':')) return str;
      // Raw ObjectId string → append :initial
      return `${str}:initial`;
    });

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { consumedAttributionKeys: migrated },
          $unset: { consumedHistoryIds: '' },
        },
      },
    });

    if (ops.length >= BATCH_SIZE) {
      await collection.bulkWrite(ops, { ordered: false });
      processed += ops.length;
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    await collection.bulkWrite(ops, { ordered: false });
    processed += ops.length;
  }

  if (processed > 0) {
    console.info(
      `[migration] rename-consumed-history-ids: migrated ${processed} documents to consumedAttributionKeys`,
    );
  }
}

/**
 * Down: reverse migration — strip :initial suffix back to raw ObjectId strings,
 * restore consumedHistoryIds field, remove consumedAttributionKeys.
 *
 * Note: this only faithfully restores entries in `id:initial` format.
 * Entries with other stepKeys (e.g. `id:digest`) cannot be reversed to ObjectId
 * and are dropped (replay protection for those steps will be lost).
 *
 * @returns {Promise<void>}
 */
export async function down() {
  const collection = mongoose.connection.db.collection('billingusages');
  const BATCH_SIZE = 500;
  let processed = 0;

  const cursor = collection.find(
    { consumedAttributionKeys: { $exists: true } },
    { projection: { _id: 1, consumedAttributionKeys: 1 } },
  );

  const ops = [];

  for await (const doc of cursor) {
    const keys = Array.isArray(doc.consumedAttributionKeys) ? doc.consumedAttributionKeys : [];

    // Only restore :initial entries as raw ObjectId strings
    const restored = keys
      .filter((key) => /^[a-fA-F0-9]{24}(:initial)?$/.test(key))
      .map((key) => key.replace(/:initial$/, ''));

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { consumedHistoryIds: restored },
          $unset: { consumedAttributionKeys: '' },
        },
      },
    });

    if (ops.length >= BATCH_SIZE) {
      await collection.bulkWrite(ops, { ordered: false });
      processed += ops.length;
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    await collection.bulkWrite(ops, { ordered: false });
    processed += ops.length;
  }

  if (processed > 0) {
    console.info(
      `[migration] rename-consumed-history-ids DOWN: restored ${processed} documents to consumedHistoryIds`,
    );
  }
}
