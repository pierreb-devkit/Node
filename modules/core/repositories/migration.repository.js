/**
 * Module dependencies
 */
import mongoose from 'mongoose';

/**
 * @function syncIndexes
 * @description Synchronise the Migration collection's indexes with the schema.
 * Creates any missing indexes (notably the unique index on `name` that backs
 * the atomic claim logic) and drops any indexes no longer declared on the
 * schema. Idempotent and safe to call on every boot.
 * @returns {Promise<Array<string>>} Names of indexes dropped during sync.
 */
const syncIndexes = () => mongoose.model('Migration').syncIndexes();

/**
 * @function listExecuted
 * @description Fetch the name + status of every Migration record. Despite the
 * name (kept for back-compat with existing callers), this returns records
 * regardless of status — `status` is included precisely so callers (see
 * `lib/services/migrations.js#getExecutedMigrations`) can distinguish a
 * genuinely completed migration (status `'done'` or absent/legacy) from one
 * still `'running'` (#3992).
 * @returns {Promise<Array<{name: string, status?: string}>>} Lean records with `name` + `status`.
 */
const listExecuted = () => mongoose.model('Migration').find({}, { name: 1, status: 1, _id: 0 }).lean();

/**
 * @function listRunning
 * @description Fetch every Migration record whose claim is still `'running'`
 * — candidates for `resolveStaleClaims()`'s boot-time stale-claim check
 * (#3992). A record in this state was either claimed by a runner still
 * genuinely in flight (another instance mid-deploy), or is crash residue from
 * a hard-killed process.
 * @returns {Promise<Array<object>>} Lean records with all fields (name, status, startedAt, pid, host, ...).
 */
const listRunning = () => mongoose.model('Migration').find({ status: 'running' }).lean();

/**
 * @function findByName
 * @description Fetch a single Migration record by name. Used to re-check a
 * `'running'` claim's live status while polling in `resolveStaleClaims()`.
 * @param {string} name - Migration filename.
 * @returns {Promise<object|null>} Lean record, or null if no longer present (unclaimed).
 */
const findByName = (name) => mongoose.model('Migration').findOne({ name }).lean();

/**
 * @function create
 * @description Insert a new Migration record. Relies on the unique index on
 * `name` to reject duplicates — used by the public `recordMigration()` flow.
 * No `status` is set: a record inserted this way is legacy-shaped by design
 * and is treated as `'done'` under the back-compat rule (missing status =
 * done), which is correct here too — this call represents an already-complete
 * migration, not a claim-in-progress.
 * @param {string} name - Migration filename, unique key for the collection.
 * @returns {Promise<object>} The created Migration document.
 */
const create = (name) => mongoose.model('Migration').create({ name, executedAt: new Date() });

/**
 * @function claim
 * @description Atomically claim a migration by inserting a `status:'running'`
 * record before its `up()` runs (#3992). Relies on the unique index on `name`
 * to reject a concurrent claim (E11000) exactly like `create()`. Captures
 * forensic context (`pid`, `host`) so a stale claim can be diagnosed later.
 * @param {string} name - Migration filename, unique key for the collection.
 * @param {{pid?: number, host?: string}} [context] - forensic claim context.
 * @returns {Promise<object>} The created Migration document.
 */
const claim = (name, { pid, host } = {}) =>
  mongoose.model('Migration').create({
    name,
    executedAt: new Date(),
    status: 'running',
    startedAt: new Date(),
    pid,
    host,
  });

/**
 * @function markDone
 * @description Flip a claimed migration's status from `'running'` to `'done'`
 * after its `up()` resolves successfully, stamping `finishedAt` (#3992).
 * @param {string} name - Migration filename.
 * @returns {Promise<object>} Mongo update result.
 */
const markDone = (name) => mongoose.model('Migration').updateOne({ name }, { $set: { status: 'done', finishedAt: new Date() } });

/**
 * @function deleteByName
 * @description Remove a Migration record by name. Used to unclaim a migration
 * when its execution fails so it can be retried on the next boot, and to
 * clear a stale `'running'` claim so it can be resumed (#3992).
 * @param {string} name - Migration filename to delete.
 * @returns {Promise<object>} Mongo deletion result.
 */
const deleteByName = (name) => mongoose.model('Migration').deleteOne({ name });

export default { syncIndexes, listExecuted, listRunning, findByName, create, claim, markDone, deleteByName };
