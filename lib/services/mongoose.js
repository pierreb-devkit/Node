/**
 * Module dependencies.
 */

import chalk from 'chalk';
import mongoose from 'mongoose';
import path from 'path';
import config from '../../config/index.js';
import configHelper from '../helpers/config.js';
import logger from './logger.js';

/**
 * @desc Resolve the effective mongoose `debug` flag.
 *  Query logging is enabled only when BOTH the config opt-in is set AND the env is
 *  dev-grade (development/test/local). Any production-grade env (the literal
 *  `production` OR a deployment env label) forces it off so verbose query logs —
 *  which can include collection/field/value detail — never run in production.
 * @param {object} [cfg=config] - application configuration object
 * @returns {boolean} effective debug flag
 */
const resolveDebug = (cfg = config) => Boolean(cfg?.db?.debug) && configHelper.isDevEnv();

/**
 * Default bound (ms) on {@link awaitIndexBuilds} when `config.db.awaitIndexBuilds`
 * does not specify its own `timeoutMs` (#3990 follow-up).
 */
const DEFAULT_AWAIT_INDEX_BUILDS_TIMEOUT_MS = 60000;

/**
 * MongoDB server error codes for "an index with this name already exists with
 * a different definition" (#4004):
 *  - 85 `IndexOptionsConflict` — same name, different options (e.g. a schema
 *    declaration gaining a `partialFilterExpression` that the deployed
 *    database's index does not carry yet)
 *  - 86 `IndexKeySpecsConflict` — same name, different key spec
 * Both describe a state of the ENVIRONMENT (a legacy index on an
 * already-deployed database), not a defect in the code — the repair for them
 * is a drop/recreate migration, which runs AFTER {@link awaitIndexBuilds} in
 * the boot sequence (lib/app.js#bootstrap).
 */
const INDEX_CONFLICT_CODES = new Set([85, 86]);
const INDEX_CONFLICT_CODE_NAMES = new Set(['IndexOptionsConflict', 'IndexKeySpecsConflict']);

/**
 * @desc Whether an index-build rejection is a same-name conflict with a
 *  pre-existing index (see {@link INDEX_CONFLICT_CODES}).
 * @param {Error} err - rejection from `Model#init()`
 * @returns {boolean} true when the error is an index-name conflict
 */
const isIndexConflictError = (err) => INDEX_CONFLICT_CODES.has(err?.code) || INDEX_CONFLICT_CODE_NAMES.has(err?.codeName);

/**
 * @desc Log a tolerated same-name index conflict LOUDLY: the model, the driver
 *  error (whose message names the requested and existing index), and — best
 *  effort — the full declared (schema) vs live (collection) index specs, so an
 *  operator can see exactly which definition the database still holds. Never
 *  throws: spec enumeration failures are logged and swallowed, since this runs
 *  on a boot path that must proceed to the migration runner (#4004).
 * @param {string} modelName - name of the model whose index build conflicted
 * @param {Error} err - the conflict rejection from `Model#init()`
 * @returns {Promise<void>} resolves once the conflict has been logged
 */
const logIndexConflict = async (modelName, err) => {
  logger.error(
    chalk.red(
      `Index build CONFLICT on model '${modelName}' (${err?.codeName || err?.code}): ${err?.message} — ` +
        'boot CONTINUES with the LIVE (stale) index so the migration runner can reconcile it; ' +
        'the schema-declared spec is NOT applied until a migration drops/recreates this index.',
    ),
  );
  try {
    const model = mongoose.model(modelName);
    const declared = model.schema.indexes();
    const live = await model.collection.listIndexes().toArray();
    logger.error(chalk.red(`  declared (schema): ${JSON.stringify(declared)}`));
    logger.error(chalk.red(`  live (collection): ${JSON.stringify(live)}`));
  } catch (specErr) {
    logger.error(chalk.red(`  could not enumerate declared/live index specs: ${specErr?.message}`));
  }
};

/**
 * Load all mongoose related models
 */
const loadModels = async (callback) => {
  // Globbing model files
  await Promise.all(
    config.files.mongooseModels.map(async (modelPath) => {
      await import(path.resolve(modelPath));
    }),
  );

  if (callback) callback();
};

/**
 * Connect to the MongoDB server
 */
const connect = async () => {
  try {
    // Attach Node.js native Promises library implementation to Mongoose
    mongoose.Promise = Promise;
    // Requires as of 4.11.0 to opt-in to the new connect implementation
    // see: http://mongoosejs.com/docs/connections.html#use-mongo-client
    const mongoOptions = config.db.options;

    if (mongoOptions.sslCA) mongoOptions.sslCA = path.resolve(mongoOptions.sslCA);
    if (mongoOptions.sslCert) mongoOptions.sslCert = path.resolve(mongoOptions.sslCert);
    if (mongoOptions.sslKey) mongoOptions.sslKey = path.resolve(mongoOptions.sslKey);

    await mongoose.connect(config.db.uri, mongoOptions);
    mongoose.set('debug', resolveDebug(config));
    logger.info(chalk.yellow('Connected to MongoDB.'));

    return mongoose;
  } catch (err) {
    // Log Error
    logger.error(chalk.red('Could not connect to MongoDB!'));
    logger.error(err);
    throw err;
  }
};

/**
 * @desc Await index readiness for every currently registered model.
 *  `mongoose.connect()` resolving does not mean indexes exist yet — autoIndex
 *  builds run in the background, so callers must explicitly wait before
 *  treating the app as ready. `Model#init()` resolves once that model's index
 *  builds finish; mongoose already calls it once automatically when the model
 *  is compiled (cached on `model.$init`), so this simply awaits builds that
 *  are already in flight rather than triggering a second build.
 *  It also SURFACES index-creation errors (e.g. an unsupported
 *  `partialFilterExpression` operator) that a fire-and-forget autoIndex would
 *  otherwise silently swallow on the model's unlistened `'index'` event —
 *  callers should expect this call to reject when a schema declares an
 *  invalid index (#3990).
 *  Respects the effective `autoIndex` option (schema > connection > global):
 *  when it resolves falsy, `Model#init()` still resolves — it just skips the
 *  index build rather than forcing one.
 *
 *  Bounded by `config.db.awaitIndexBuilds` (#3990 follow-up — an unbounded
 *  wait here stalls readiness stack-wide on a rolling deploy whenever a
 *  big collection's index build takes a while):
 *    - `false` skips the wait entirely — index builds still happen via
 *      autoIndex, just fire-and-forget again (pre-#3990 behaviour).
 *    - any other value (default: `{}`) waits up to `timeoutMs` (default
 *      {@link DEFAULT_AWAIT_INDEX_BUILDS_TIMEOUT_MS}). On timeout, boot
 *      CONTINUES — a loud warning names the model(s) still building, and the
 *      in-flight build(s) keep going in the background; an eventual failure
 *      (e.g. an invalid index declaration) is still logged, just after boot
 *      already proceeded past this call.
 *  A genuine rejection that happens BEFORE the timeout (the common case — an
 *  invalid index declaration fails fast) still propagates and rejects this
 *  call, with ONE deliberate exception (#4004): a same-name index CONFLICT
 *  (codes 85/86 — the live collection already holds an index under the
 *  declared name with a different definition) is logged at error level and
 *  TOLERATED. That state is environment state, not a code bug: the migration
 *  that reconciles it runs AFTER this call (lib/app.js#bootstrap), so
 *  rejecting here would gate the repair behind the very defect it repairs —
 *  the app would crash-loop with no path forward short of manual index
 *  surgery. Serving with the stale live index (writes keep obeying the OLD
 *  constraint until the migration lands) beats not serving at all. NOTE: a
 *  conflict aborts that model's remaining index builds too (createIndexes is
 *  sequential per model), which the log calls out — the migration reconciling
 *  the conflict re-converges the rest via autoIndex on the next boot.
 * @param {object} [cfg=config] - application configuration object
 * @returns {Promise<void>} Resolves once every registered model's index builds
 *  finish, the configured timeout elapses, or immediately when disabled.
 */
const awaitIndexBuilds = async (cfg = config) => {
  const setting = cfg?.db?.awaitIndexBuilds;
  if (setting === false) return;

  // Number(...) (not Number.isFinite directly on the raw value) so a numeric
  // STRING survives — a `db.awaitIndexBuilds.timeoutMs` override supplied via a
  // Layer-4 DEVKIT_NODE_* env var always arrives as a string (config/index.js
  // only coerces the literal 'true'/'false', nothing numeric); reject
  // non-positive values so a malformed override falls back to the default
  // instead of racing straight to a 0ms/negative timeout.
  const configuredTimeoutMs = setting && typeof setting === 'object' ? Number(setting.timeoutMs) : NaN;
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : DEFAULT_AWAIT_INDEX_BUILDS_TIMEOUT_MS;

  const modelNames = mongoose.modelNames();
  if (modelNames.length === 0) return;

  const pending = new Set(modelNames);
  const builds = Promise.all(
    modelNames.map((name) =>
      mongoose.model(name)
        .init()
        .then((result) => {
          pending.delete(name);
          return result;
        })
        .catch(async (err) => {
          pending.delete(name);
          // Same-name index conflict with a pre-existing (legacy) index: log
          // loudly and keep booting so the migration runner — which runs right
          // after this in bootstrap — can reconcile it (#4004). Every other
          // rejection (e.g. an invalid index declaration) still propagates.
          if (!isIndexConflictError(err)) throw err;
          await logIndexConflict(name, err);
        }),
    ),
  );

  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });

  try {
    const winner = await Promise.race([builds, timeoutPromise]);
    if (winner === 'timeout') {
      logger.warn(
        chalk.red(
          `Index builds still in flight after ${timeoutMs}ms — continuing boot in a DEGRADED state (writes may race a not-yet-built index) for model(s): ${[...pending].join(', ')}`,
        ),
      );
      // Let the build(s) keep going in the background; surface an eventual
      // failure loudly instead of silently swallowing it, even though boot
      // already continued past this call.
      builds.catch((err) => {
        logger.error(chalk.red('Index build failed after boot continued past the awaitIndexBuilds timeout:'), err);
      });
    }
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Disconnect from the MongoDB server
 */
const disconnect = async () => {
  await mongoose.disconnect();
  logger.info(chalk.yellow('Disconnected from MongoDB.'));
};

export default {
  loadModels,
  connect,
  awaitIndexBuilds,
  disconnect,
  resolveDebug,
};
