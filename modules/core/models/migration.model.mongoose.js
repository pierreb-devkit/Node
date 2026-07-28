/**
 * Module dependencies
 */
import mongoose from 'mongoose';

const Schema = mongoose.Schema;

/**
 * Migration tracking schema — records which migration files have been executed.
 */
const MigrationSchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  executedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  // Claim-with-status (#3992): tells apart a migration whose `up()` genuinely
  // finished from one whose claim was written but the process was hard-killed
  // (OOM/SIGKILL/pod eviction) before `up()` returned.
  //   - 'running': claimed, `up()` has not yet resolved. lib/services/
  //     migrations.js#resolveStaleClaims() treats a 'running' claim older
  //     than config.migrations.staleRunningGraceMs as crash residue from a
  //     prior boot and resumes it (all in-tree migrations are required to be
  //     idempotent — see MIGRATIONS.md — so re-running is safe).
  //   - 'done': `up()` completed successfully.
  //   - absent (no `status` field at all): a legacy claim written before this
  //     field existed. ALWAYS treated as 'done' — see the back-compat
  //     handling in lib/services/migrations.js#getExecutedMigrations(). It is
  //     never reinterpreted as anything else, or migration history would
  //     silently re-run on every project that upgrades past this change.
  status: {
    type: String,
    enum: ['running', 'done'],
  },
  // Set when the claim is written (status:'running'); mirrors `executedAt`
  // but is the field `resolveStaleClaims()` measures claim age against.
  startedAt: {
    type: Date,
  },
  // Set when `up()` resolves successfully (status flips to 'done').
  finishedAt: {
    type: Date,
  },
  // Forensic context captured at claim time — which process/host claimed
  // this migration, useful when diagnosing a stale 'running' claim after a
  // crash.
  pid: {
    type: Number,
  },
  host: {
    type: String,
  },
});

/**
 * @desc Function to add id (+ _id) to all objects
 * @returns {string} hex string of the document _id
 */
function addID() {
  return this._id.toHexString();
}

/**
 * Model configuration
 */
MigrationSchema.virtual('id').get(addID);
// Ensure virtual fields are serialised.
MigrationSchema.set('toJSON', {
  virtuals: true,
});

mongoose.model('Migration', MigrationSchema);
