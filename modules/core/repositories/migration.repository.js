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
 * @description Fetch the name of every migration recorded as executed.
 * @returns {Promise<Array<{name: string}>>} Lean records with only the `name` field.
 */
const listExecuted = () => mongoose.model('Migration').find({}, { name: 1, _id: 0 }).lean();

/**
 * @function create
 * @description Insert a new Migration record. Relies on the unique index on
 * `name` to reject duplicates — used both by the public `recordMigration()`
 * flow and the atomic claim logic in `claimMigration()`.
 * @param {string} name - Migration filename, unique key for the collection.
 * @returns {Promise<object>} The created Migration document.
 */
const create = (name) => mongoose.model('Migration').create({ name, executedAt: new Date() });

/**
 * @function deleteByName
 * @description Remove a Migration record by name. Used to unclaim a migration
 * when its execution fails so it can be retried on the next boot.
 * @param {string} name - Migration filename to delete.
 * @returns {Promise<object>} Mongo deletion result.
 */
const deleteByName = (name) => mongoose.model('Migration').deleteOne({ name });

export default { syncIndexes, listExecuted, create, deleteByName };
