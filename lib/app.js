/**
 * Module dependencies.
 */
import chalk from 'chalk';
import nodeHttp from 'http';
import nodeHttps from 'https';

import config from '../config/index.js';
import logger from './services/logger.js';
import express from './services/express.js';
import mongooseService from './services/mongoose.js';
import migrations from './services/migrations.js';
import AnalyticsService from './services/analytics.js';

// Establish a MongoDB connection, instantiating all models
const startMongoose = async () => {
  try {
    await mongooseService.loadModels();
    const connection = await mongooseService.connect();
    return connection;
  } catch (e) {
    throw new Error(e);
  }
};

/**
 * Establish ExpressJS powered web server
 * @return {object} app
 */
const startExpress = async () => {
  try {
    const app = await express.init();
    return app;
  } catch (e) {
    throw new Error(e);
  }
};

/**
 * Bootstrap the required services
 *
 * In test mode (--runInBand, single process), subsequent calls skip the
 * migrations step by checking the `DEVKIT_MIGRATIONS_RAN` environment variable.
 * That variable is set by `scripts/jest.globalSetup.js` which runs ONCE before
 * any test vm context is created. Keys set on process.env in globalSetup are
 * included in jest's protectProperties() sweep and survive per-suite vm context
 * teardown unchanged — unlike module-scope vars or globalThis which are reset
 * per test file under --experimental-vm-modules.
 *
 * Migrations are DB-backed and idempotent; skipping the glob scan + DB
 * round-trip on 2nd+ suite bootstraps saves ≈ 100 ms × 18 suites ≈ 1.8 s
 * and avoids redundant file-read accumulation under --experimental-vm-modules.
 *
 * Each test suite still gets a fresh Express app and mongoose connection so
 * per-suite module state (e.g. config mutations in tests) is correctly isolated.
 *
 * In production / non-test environments the env flag is never set, so behaviour
 * is unchanged.
 *
 * @returns {Promise<{db: object, app: object}>} Resolves with db and app instances
 */
const bootstrap = async () => {
  let db;
  let app;

  try {
    db = await startMongoose();
    // DEVKIT_MIGRATIONS_RAN is set by jest.globalSetup.js before any vm context
    // is created, so it persists across all test suite vm context teardown cycles.
    // Falls through to migrations.run() when globalSetup failed or flag is absent.
    // Scoped to NODE_ENV=test so the flag cannot accidentally skip migrations in
    // production or dev (e.g. when --env-file-if-exists=.env injects it).
    const migrationsAlreadyRan =
      process.env.NODE_ENV === 'test' && process.env.DEVKIT_MIGRATIONS_RAN === '1';
    if (!migrationsAlreadyRan) {
      await migrations.run();
    } else {
      // globalSetup already ran migrations on a DB that may differ from the one
      // this suite connects to (e.g. a per-worker DB identified by JEST_WORKER_ID,
      // or the same base DB when running with --runInBand). Ensure the unique
      // index on Migration.name exists in the currently-connected DB so
      // duplicate-rejection works correctly (e.g. migrations.integration.tests.js).
      // On the base DB this is a harmless no-op — indexes already exist after
      // globalSetup ran migrations.run().
      await migrations.ensureMigrationIndexes();
    }
    app = await startExpress();
  } catch (e) {
    throw new Error(`unable to initialize Mongoose or ExpressJS : ${e}`);
  }

  return {
    db,
    app,
  };
};

/**
 * @desc Log server configuration and SaaS readiness summary to console.
 * @returns {Promise<void>}
 */
const logConfiguration = async () => {
  // Create server URL
  const server = `${(config.secure && config.secure.credentials ? 'https://' : 'http://') + config.api.host}:${config.api.port}`;
  // Logging initialization
  logger.info(chalk.green(config.app.title));
  logger.info(chalk.green(`Environment:     ${process.env.NODE_ENV ? process.env.NODE_ENV : 'development'}`));
  logger.info(chalk.green(`Server:          ${server}`));
  const safeUri = config.db.uri.replace(/\/\/[^@]+@/, '//***:***@');
  logger.info(chalk.green(`Database:        ${safeUri}`));
  if (config.cors.origin.length > 0) logger.info(chalk.green(`Cors:            ${config.cors.origin}`));

  // SaaS readiness summary (skip in test to keep output clean)
  if (process.env.NODE_ENV !== 'test') {
    try {
      const { default: HomeService } = await import('../modules/home/services/home.service.js');
      const checks = HomeService.getReadinessStatus();
      logger.info(chalk.green('SaaS Readiness:'));
      checks.forEach((c) => {
        const icon = c.status === 'ok' ? chalk.green('OK') : chalk.yellow('WARN');
        logger.info(`  ${icon}  ${c.category.padEnd(12)} ${c.message}`);
      });
    } catch (err) {
      logger.warn(chalk.yellow(`  SaaS readiness check failed: ${err.message}`), err);
    }
  }
};

// Boot up the server
const start = async () => {
  let db;
  let app;
  let http;

  try {
    ({ db, app } = await bootstrap());
  } catch (e) {
    throw new Error(e);
  }

  try {
    if (config.secure && config.secure.credentials)
      http = await nodeHttps.createServer(config.secure.credentials, app).setTimeout(config.api.timeout).listen(config.api.port, config.api.host);
    else http = await nodeHttp.createServer(app).setTimeout(config.api.timeout).listen(config.api.port, config.api.host);
    await logConfiguration();
    return {
      db,
      app,
      http,
    };
  } catch (e) {
    throw new Error(e);
  }
};

const FORCE_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Gracefully shut down the server, disconnecting services before exiting.
 * If the server promise rejects (e.g. failed to start), logs the error and exits.
 * A forced exit is triggered after {@link FORCE_SHUTDOWN_TIMEOUT_MS} ms if shutdown hangs.
 *
 * @param {Promise<{http: import('http').Server}>} server - Promise returned by {@link start}
 * @returns {Promise<void>} Resolves when shutdown is initiated (process exits via callback)
 */
const shutdown = async (server) => {
  // Force exit if graceful shutdown hangs
  const forceTimeout = setTimeout(() => {
    logger.error(chalk.red('Forced shutdown (timeout)'));
    process.exit(1);
  }, FORCE_SHUTDOWN_TIMEOUT_MS);
  forceTimeout.unref();

  try {
    const value = await server;
    await AnalyticsService.shutdown();
    await mongooseService.disconnect();
    value.http.close((err) => {
      if (err) {
        logger.error(chalk.red('Error on server close.'), err);
        process.exitCode = 1;
      } else {
        logger.info(chalk.yellow('Server closed'));
      }
      process.exit();
    });
  } catch (err) {
    logger.error(chalk.red('Shutdown error: server never started or shutdown failed'), err);
    process.exit(1);
  }
};

export { bootstrap, start, shutdown };
