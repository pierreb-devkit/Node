/**
 * Jest global teardown — drops the test database after the test suite finishes.
 * Companion to `scripts/jest.globalSetup.js` (#3476) and the per-pid DB default
 * introduced in #3515. Without teardown, every parallel jest run leaves an
 * orphan `NodeTest_<pid>` database on the local mongod and they accumulate
 * indefinitely.
 *
 * Safety guards mirror globalSetup:
 *   1. Refuse to drop anything when `NODE_ENV !== 'test'`.
 *   2. Refuse when the resolved DB name does not contain `test`
 *      (case-insensitive).
 *
 * Failures are swallowed — an offline mongod after the suite ran (e.g. the
 * developer killed it manually) must not fail the jest exit code.
 */
import mongoose from 'mongoose';

/**
 * Jest global teardown entry point — drops the test DB resolved from config.
 * @returns {Promise<void>} Resolves once the guard check completes and, when
 * guards pass and Mongo is reachable, once the database has been dropped and
 * the connection closed. Never rejects.
 */
export default async () => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      `[jest.globalTeardown] Refusing to drop DB: NODE_ENV is "${process.env.NODE_ENV}", expected "test". Skipping drop.`,
    );
    return;
  }
  try {
    const config = (await import('../config/index.js')).default;
    const dbName = new URL(config.db.uri).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) {
      console.warn(
        `[jest.globalTeardown] Refusing to drop "${dbName}": name does not match /test/i. Aborting.`,
      );
      return;
    }
    await mongoose.connect(config.db.uri);
    try {
      await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  } catch (err) {
    // MongoDB unreachable or drop failed — log so silent failures don't hide
    // accumulating orphan DBs in CI logs, but never fail the suite exit code.
    console.warn(`[jest.globalTeardown] Skipped drop: ${err && err.message ? err.message : err}`);
  }
};
