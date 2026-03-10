/**
 * Module dependencies.
 */
import chalk from 'chalk';
import mongoose from 'mongoose';
import path from 'path';
import { glob } from 'glob';

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
  const Migration = mongoose.model('Migration');
  const records = await Migration.find({}, { name: 1, _id: 0 }).lean();
  return new Set(records.map((r) => r.name));
};

/**
 * Record a migration as executed in the database.
 * @param {string} name - the migration filename used as unique key
 * @returns {Promise<object>} the created Migration document
 */
const recordMigration = async (name) => {
  const Migration = mongoose.model('Migration');
  return Migration.create({ name, executedAt: new Date() });
};

/**
 * Run a single migration file's `up()` export.
 * The migration is recorded in the database after successful execution.
 * If the migration name already exists in the DB, it is skipped (idempotent).
 * @param {string} filePath - path to the migration file
 * @param {Set<string>} executed - set of already-executed migration names
 * @returns {Promise<boolean>} true if the migration was run, false if skipped
 */
const runMigration = async (filePath, executed) => {
  const name = path.basename(filePath);

  // Idempotent: skip if already recorded
  if (executed.has(name)) {
    return false;
  }

  const mod = await import(path.resolve(filePath));

  if (typeof mod.up !== 'function') {
    throw new Error(`Migration file ${name} does not export an up() function`);
  }

  await mod.up();
  await recordMigration(name);

  console.log(chalk.green(`  Migration executed: ${name}`));
  return true;
};

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

  const files = await discoverMigrationFiles();

  if (files.length === 0) {
    console.log(chalk.yellow('No migration files found.'));
    return { total: 0, executed: 0 };
  }

  const executed = await getExecutedMigrations();
  let executedCount = 0;

  console.log(chalk.yellow(`Running migrations (${files.length} found, ${executed.size} already executed)...`));

  for (const filePath of files) {
    try {
      const wasRun = await runMigration(filePath, executed);
      if (wasRun) executedCount++;
    } catch (err) {
      console.error(chalk.red(`Migration failed: ${path.basename(filePath)}`));
      console.error(chalk.red(err.message));
      throw err;
    }
  }

  if (executedCount > 0) {
    console.log(chalk.green(`Migrations complete: ${executedCount} executed.`));
  } else {
    console.log(chalk.yellow('All migrations already up to date.'));
  }

  return { total: files.length, executed: executedCount };
};

export default { run, discoverMigrationFiles, getExecutedMigrations, recordMigration, runMigration };
