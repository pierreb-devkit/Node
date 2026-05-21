/**
 * Distributed lock primitive for multi-pod cron jobs.
 *
 * Uses a MongoDB TTL collection (`cron_locks`) to ensure mutual exclusion
 * across replicas. A lock document expires automatically after `ttlMs`
 * milliseconds — pod crashes therefore never permanently block scheduling.
 *
 * Usage:
 *   const holder = `${process.env.HOSTNAME ?? 'unknown'}:${randomUUID()}`
 *   const acquired = await acquireLock({ name: 'billing.weeklyReset', ttlMs: 10 * 60 * 1000, holder })
 *   if (!acquired) return               // another pod holds the lock
 *   try {
 *     // ... work
 *   } finally {
 *     await releaseLock({ name: 'billing.weeklyReset', holder })
 *   }
 */

import mongoose from 'mongoose';

const LockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    lockedAt: { type: Date, required: true },
    lockedUntil: { type: Date, required: true },
    holder: { type: String, required: true },
  },
  { collection: 'cron_locks', versionKey: false },
);

// MongoDB TTL index — auto-deletes expired docs so stale locks don't accumulate.
LockSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 0 });

export const CronLock = mongoose.models.CronLock ?? mongoose.model('CronLock', LockSchema);

/**
 * @function acquireLock
 * @description Attempt to acquire a named lock. Returns true if acquired,
 * false if the lock is currently held by another holder.
 *
 * Implementation: findOneAndUpdate with upsert on the condition that either
 * no doc exists (_id absent) or the existing doc has expired (lockedUntil < now).
 * Duplicate-key errors (E11000) from the unique _id index are caught and
 * returned as false (another pod raced to acquire simultaneously).
 *
 * @param {object} opts
 * @param {string} opts.name     - Unique lock name (e.g. 'billing.weeklyReset')
 * @param {number} opts.ttlMs    - Lock duration in milliseconds
 * @param {string} opts.holder   - Unique identifier for the calling pod/process
 * @returns {Promise<boolean>}
 */
export async function acquireLock({ name, ttlMs, holder }) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttlMs);
  try {
    const result = await CronLock.findOneAndUpdate(
      { _id: name, lockedUntil: { $lt: now } },
      { $set: { lockedAt: now, lockedUntil, holder } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    return result?.holder === holder;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

/**
 * @function releaseLock
 * @description Release a lock only if the caller is the current holder.
 * No-op if the lock is held by a different holder (prevents accidental release
 * after a TTL expiry + re-acquire by another pod).
 *
 * @param {object} opts
 * @param {string} opts.name   - Lock name to release
 * @param {string} opts.holder - Must match the holder that acquired the lock
 * @returns {Promise<void>}
 */
export async function releaseLock({ name, holder }) {
  await CronLock.deleteOne({ _id: name, holder });
}

export default { CronLock, acquireLock, releaseLock };
