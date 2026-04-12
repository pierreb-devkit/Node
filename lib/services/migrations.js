/**
 * Module dependencies.
 */
import chalk from 'chalk';
import path from 'path';
import { glob } from 'glob';
import logger from './logger.js';
import migrationRepository from '../../modules/core/repositories/migration.repository.js';

/**
 * Scan all modules for migration files matching `modules/&#42;/migrations/&#42;.js`.
 * @returns {Promise<string[]>} sorted list of absolute migration file paths
 */
const discoverMigrationFiles = async () => {
  const pattern = 'modules/*/migrations/*.js';
  const files = glob.sync(pattern.replace(/\\/g, '/'));
  // Sort by filename (date-prefixed) to ensure execution order
  files.sort((a, b) => {
    const nameA = path.basename(a);
    const nameB = path.basename(b);
    return nameA.localeCompare(nameB);
  });
  return files;
};

/**
 * Retrieve the set of migration names that have already been executed.
 * @returns {Promise<Set<string>>} set of executed migration names
 */
const getExecutedMigrations = async () => {
  const records = await migrationRepository.listExecuted();
  return new Set(records.map((r) => r.name));
};

/**
 * Record a migration as executed in the database.
 * @param {string} name - the migration filename used as unique key
 * @returns {Promise<object>} the created Migration document
 */
const recordMigration = (name) => migrationRepository.create(name);

/**
 * Atomically claim a migration by inserting a record before execution.
 * Uses the unique name index to prevent concurrent runners from executing the same migration.
 * @param {string} name - the migration filename used as unique key
 * @returns {Promise<boolean>} true if claimed successfully, false if already claimed by another runner
 */
const claimMigration = async (name) => {
  try {
    await migrationRepository.create(name);
    return true;
  } catch (err) {
    // Duplicate key error means another runner already claimed it
    if (err.code === 11000) return false;
    throw err;
  }
};

/**
 * Remove a claimed migration record on failure so it can be retried.
 * @param {string} name - the migration filename
 * @returns {Promise<object>} the deletion result
 */
const unclaimMigration = (name) => migrationRepository.deleteByName(name);

/**
 * Run a single migration file's `up()` export.
 * The migration is recorded in the database after successful execution.
 * If the migration name already exists in the DB, it is skipped (idempotent).
 * @param {string} filePath - path to the migration file
 * @param {Set<string>} executed - set of already-executed migration names
 * @returns {Promise<boolean>} true if the migration was run, false if skipped
 */
const runMigration = async (filePath, executed) => {
  const name = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

  // Idempotent: skip if already recorded
  if (executed.has(name)) {
    return false;
  }

  // Atomically claim the migration to prevent concurrent execution
  const claimed = await claimMigration(name);
  if (!claimed) {
    logger.warn(chalk.yellow(`  Migration already claimed by another runner: ${name}`));
    return false;
  }

  let mod;
  try {
    mod = await import(path.resolve(filePath));
  } catch (err) {
    // Unclaim so the migration can be retried on next startup
    await unclaimMigration(name);
    throw err;
  }

  if (typeof mod.up !== 'function') {
    await unclaimMigration(name);
    throw new Error(`Migration file ${name} does not export an up() function`);
  }

  try {
    await mod.up();
  } catch (err) {
    // Remove the claim so the migration can be retried on next startup
    await unclaimMigration(name);
    throw err;
  }

  logger.info(chalk.green(`  Migration executed: ${name}`));
  return true;
};

/**
 * Ensure the Migration collection's indexes are in sync with the schema.
 * The `name` field has a unique index that backs the atomic claim logic in
 * {@link claimMigration}; without it, concurrent runners can execute the same
 * migration twice. Delegates to the repository so the service layer never
 * touches Mongoose directly.
 * @returns {Promise<void>} Resolves once indexes have been synchronised.
 */
const ensureMigrationIndexes = () => migrationRepository.syncIndexes();

/**
 * Run all pending migrations in order.
 * Scans `modules/&#42;/migrations/&#42;.js`, compares with the `migrations` MongoDB
 * collection, and executes any pending migrations sorted by filename date prefix.
 * If any migration fails, the error is thrown to prevent the app from starting.
 * @returns {Promise<{total: number, executed: number}>} summary of migration run
 */
const run = async () => {
  // Ensure the Migration model is registered
  await import(path.resolve('modules/core/models/migration.model.mongoose.js'));

  // Ensure the unique index on `name` exists before any claim/record calls.
  // Without this, older deployments whose `migrations` collection was created
  // before the unique index was added would silently allow duplicate claims.
  await ensureMigrationIndexes();

  const files = await discoverMigrationFiles();

  if (files.length === 0) {
    logger.warn(chalk.yellow('No migration files found.'));
    return { total: 0, executed: 0 };
  }

  const executed = await getExecutedMigrations();
  let executedCount = 0;

  logger.info(chalk.yellow(`Running migrations (${files.length} found, ${executed.size} already executed)...`));

  for (const filePath of files) {
    try {
      const wasRun = await runMigration(filePath, executed);
      if (wasRun) executedCount++;
    } catch (err) {
      logger.error(chalk.red(`Migration failed: ${path.basename(filePath)}`), err);
      throw err;
    }
  }

  if (executedCount > 0) {
    logger.info(chalk.green(`Migrations complete: ${executedCount} executed.`));
  } else {
    logger.info(chalk.yellow('All migrations already up to date.'));
  }

  return { total: files.length, executed: executedCount };
};

export default { run, discoverMigrationFiles, getExecutedMigrations, recordMigration, runMigration, ensureMigrationIndexes };
