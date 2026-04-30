/**
 * Jest global setup — runs once in the jest main process before any test file.
 *
 * Responsibilities:
 *  1. Drop the test database (clean-slate guard, original behaviour).
 *  2. Run migrations once and set `process.env.DEVKIT_MIGRATIONS_RAN = '1'`
 *     so that per-suite bootstrap() calls can skip the migrations step.
 *
 * Why process.env and not process properties or globalThis?
 *   Jest --experimental-vm-modules creates a fresh vm.createContext() for each
 *   test file. Both globalThis and arbitrary process properties set INSIDE a vm
 *   context are cleaned up by jest's GlobalProxy on teardown.
 *   process.env keys set IN GLOBALSETUP (before any vm context is created) are
 *   present when jest calls protectProperties(process) during vm context
 *   initialisation — they land in the "protected" set and survive all
 *   per-suite teardown cycles unchanged.
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
import path from 'path';

/**
 * Jest global setup entry point.
 * @returns {Promise<void>}
 */
export default async () => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      `[jest.globalSetup] Refusing to drop DB: NODE_ENV is "${process.env.NODE_ENV}", expected "test". Skipping drop.`,
    );
    return;
  }

  // 1. Drop the test database (clean-slate guard)
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

  // 2. Run migrations once before any test vm context is created.
  //    Set process.env.DEVKIT_MIGRATIONS_RAN = '1' so per-suite bootstrap() calls
  //    can skip migrations.run() (saves ~100ms × 18 suites ≈ 1.8s).
  //    Keys set on process.env HERE (before vm contexts) are included in jest's
  //    protectProperties() pass and survive per-suite GlobalProxy teardown.
  try {
    const config = (await import('../config/index.js')).default;
    await mongoose.connect(config.db.uri);
    try {
      // Load mongoose models (needed by migration model registry)
      await Promise.all(
        config.files.mongooseModels.map(async (modelPath) => {
          await import(path.resolve(modelPath));
        }),
      );

      // Run pending migrations
      const migrations = (await import('../lib/services/migrations.js')).default;
      await migrations.run();

      // Mark migrations as run so test vm contexts skip migrations.run()
      process.env.DEVKIT_MIGRATIONS_RAN = '1';
    } finally {
      await mongoose.disconnect();
    }
  } catch (err) {
    // Non-fatal: test suites will run migrations themselves (pre-existing behaviour)
    console.warn('[jest.globalSetup] migrations pre-run failed — suites run individually:', err.message);
  }
};
