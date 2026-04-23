/**
 * Jest global setup - drops the test database before the test suite runs.
 * Replaces the gulp dropDB task that previously ran before jest.
 * Silently skips if MongoDB is unreachable (e.g. fresh CI environment).
 *
 * Safety guards (#3476):
 *   1. Refuse to drop anything when `NODE_ENV !== 'test'`. Protects downstream
 *      projects that export `NODE_ENV=<project>` in their shell and invoke
 *      jest directly (e.g. `npx jest`, IDE runners) bypassing the
 *      `cross-env NODE_ENV=test` wrapper used by the npm `test*` scripts.
 *   2. Belt-and-suspenders: also refuse when the resolved DB name does not
 *      contain `test` (case-insensitive). Catches leaked overrides of
 *      `config.db.uri` that point at a non-test database.
 *
 * Both checks log a clear refusal reason and exit without connecting.
 */
import mongoose from 'mongoose';

/**
 * Jest global setup entry point — drops the test database before the suite runs.
 * Enforces the NODE_ENV + DB-name guards described at the top of this file.
 * @returns {Promise<void>} Resolves once the guard check completes and, when
 * guards pass and Mongo is reachable, once the database has been dropped and
 * the connection closed. Never rejects — a Mongo failure is swallowed so tests
 * can still run against existing state (e.g. fresh CI without mongo).
 */
export default async () => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      `[jest.globalSetup] Refusing to drop DB: NODE_ENV is "${process.env.NODE_ENV}", expected "test". Skipping drop.`,
    );
    return;
  }
  try {
    const config = (await import('../config/index.js')).default;
    const dbName = new URL(config.db.uri).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) {
      console.warn(
        `[jest.globalSetup] Refusing to drop "${dbName}": name does not match /test/i. Aborting.`,
      );
      return;
    }
    await mongoose.connect(config.db.uri);
    try {
      await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  } catch {
    // MongoDB unreachable or drop failed — tests will run against existing state
  }
};
