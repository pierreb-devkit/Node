/**
 * Module dependencies.
 */
import chalk from 'chalk';
import os from 'os';
import path from 'path';
import { glob } from 'glob';
import config from '../../config/index.js';
import logger from './logger.js';
import migrationRepository from '../../modules/core/repositories/migration.repository.js';

/**
 * Default bound (ms) on {@link resolveStaleClaims} when
 * `config.migrations.staleRunningGraceMs` is not a positive number (#3992).
 */
const DEFAULT_STALE_RUNNING_GRACE_MS = 10 * 60 * 1000;

/**
 * Poll interval (ms) used by {@link resolveStaleClaims} while waiting on a
 * `'running'` claim that is still within the grace window (#3992). Not
 * config-exposed — only the grace window itself is a documented knob; this is
 * an implementation detail bounded by that window (worst case wait = grace).
 */
const DEFAULT_STALE_CLAIM_POLL_INTERVAL_MS = 1000;

/**
 * @desc Promise-based sleep helper used by {@link resolveStaleClaims}'s poll loop.
 * @param {number} ms - milliseconds to wait
 * @returns {Promise<void>} Resolves after `ms` milliseconds.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Retrieve the set of migration names that are genuinely complete — i.e.
 * safe to skip on this and every future boot.
 *
 * Back-compat (#3992): a record with no `status` field at all predates
 * claim-with-status and completed under the old claim-before-up() semantics
 * (a bare insert WAS the completion signal) — it is ALWAYS treated as
 * `'done'`, explicitly and unconditionally, never re-interpreted as anything
 * else. Getting this wrong in either direction is bad: treating it as
 * incomplete would re-run migration history that already applied on every
 * project that upgrades past this change; there is no third state to invent.
 * A record with `status:'running'` is NOT included here — it is either still
 * genuinely in flight or stale crash residue, both handled by
 * {@link resolveStaleClaims} before this function is ever consulted in
 * {@link run}.
 * @returns {Promise<Set<string>>} set of migration names considered complete
 */
const getExecutedMigrations = async () => {
  const records = await migrationRepository.listExecuted();
  return new Set(records.filter((r) => r.status == null || r.status === 'done').map((r) => r.name));
};

/**
 * Record a migration as executed in the database.
 * @param {string} name - the migration filename used as unique key
 * @returns {Promise<object>} the created Migration document
 */
const recordMigration = (name) => migrationRepository.create(name);

/**
 * Atomically claim a migration by inserting a `status:'running'` record
 * before execution (#3992). Uses the unique name index to prevent concurrent
 * runners from executing the same migration. Captures `pid`/`host` forensic
 * context so a stale claim can later be attributed to the process/host that
 * left it behind.
 * @param {string} name - the migration filename used as unique key
 * @returns {Promise<boolean>} true if claimed successfully, false if already claimed by another runner
 */
const claimMigration = async (name) => {
  try {
    await migrationRepository.claim(name, { pid: process.pid, host: os.hostname() });
    return true;
  } catch (err) {
    // Duplicate key error means another runner already claimed it
    if (err.code === 11000) return false;
    throw err;
  }
};

/**
 * Flip a claimed migration's status to `'done'` after its `up()` resolves
 * successfully (#3992). The prior thrown-error path (unclaim → retry next
 * boot) is unchanged — this only runs on the success branch.
 * @param {string} name - the migration filename
 * @returns {Promise<object>} the update result
 */
const markMigrationDone = (name) => migrationRepository.markDone(name);

/**
 * Remove a claimed migration record on failure so it can be retried.
 * @param {string} name - the migration filename
 * @returns {Promise<object>} the deletion result
 */
const unclaimMigration = (name) => migrationRepository.deleteByName(name);

/**
 * @desc Resolve the effective stale-claim grace window (ms). Mirrors the
 * `Number(...)` coercion pattern in `lib/services/mongoose.js#awaitIndexBuilds`
 * so a Layer-4 `DEVKIT_NODE_*` env override (always a string) still works.
 * @param {object} [cfg=config] - application configuration object
 * @returns {number} grace window in milliseconds
 */
const resolveStaleGraceMs = (cfg = config) => {
  const configured = Number(cfg?.migrations?.staleRunningGraceMs);
  // >= 0 (not > 0): a configured `0` is a deliberate, valid override (treat any
  // running claim as immediately stale) — only a negative/NaN/missing value
  // falls back to the default.
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_STALE_RUNNING_GRACE_MS;
};

/**
 * @desc Resolve a single `status:'running'` claim found at boot (#3992):
 * either it is a genuinely concurrent runner (another instance mid-deploy,
 * still within the grace window) or crash residue from a hard-killed process
 * (OOM/SIGKILL/pod eviction) that never reached the success branch.
 *
 * While the claim's age is below `graceMs`, this WAITS — polling the live
 * record until it flips to `'done'` (the concurrent runner finished; nothing
 * more to do, {@link getExecutedMigrations} will see it as complete) or
 * disappears (the concurrent runner's `up()` threw and unclaimed it; the
 * migration is now claimable again in the normal loop). The wait is bounded
 * by the remaining grace window — worst case this blocks boot for `graceMs`.
 *
 * Once the age reaches `graceMs` with the claim still `'running'`, it is
 * presumed to be crash residue: this logs a loud WARN and deletes the claim
 * so the normal claim/run loop in {@link run} re-claims and re-runs it.
 * Re-running is safe because every migration in this tree is required to be
 * idempotent (MIGRATIONS.md) — the unique claim index still serializes any
 * genuinely-new claim against this one.
 * @param {object} record - a lean Migration record with `status:'running'`
 * @param {{graceMs: number, pollIntervalMs?: number}} opts - resolution options
 * @returns {Promise<void>} Resolves once the claim is no longer an open question.
 */
const resolveRunningClaim = async (record, { graceMs, pollIntervalMs = DEFAULT_STALE_CLAIM_POLL_INTERVAL_MS }) => {
  let current = record;

  while (current && current.status === 'running') {
    // startedAt is always set alongside status:'running' — repository.claim()
    // is the only writer of that shape (a legacy, status-less record can
    // never reach here; getExecutedMigrations() already treats it as done).
    const startedAt = new Date(current.startedAt).getTime();
    const ageMs = Date.now() - startedAt;

    if (ageMs >= graceMs) {
      logger.warn(
        chalk.yellow(
          `  Resuming migration ${current.name} after interrupted run: claim stuck in 'running' for ${ageMs}ms (>= grace window ${graceMs}ms) — presumed crash residue from a hard kill (OOM/SIGKILL/pod eviction). Deleting the stale claim; it will re-run (migrations are required to be idempotent, see MIGRATIONS.md).`,
        ),
      );
      await unclaimMigration(current.name);
      return;
    }

    // Still within the grace window: could be a concurrent runner on another
    // instance mid-deploy. Wait, then re-check the live record.
    await sleep(Math.min(pollIntervalMs, graceMs - ageMs));
    current = await migrationRepository.findByName(current.name);
  }
};

/**
 * @desc Boot-time stale-claim detection (#3992). Scans every Migration record
 * still `status:'running'` and resolves each one via
 * {@link resolveRunningClaim} — waiting out genuinely concurrent runners,
 * deleting crash residue so it can be resumed. Must run BEFORE
 * {@link getExecutedMigrations} is consulted, so a resumed migration is
 * correctly excluded from the "already done" set and re-attempted below.
 *
 * Resolves every record CONCURRENTLY (`Promise.all`, mirroring
 * `lib/services/mongoose.js#awaitIndexBuilds`'s own `Promise.all` shape for
 * the same "bounded parallel wait at boot" problem) — each record is an
 * independent migration (unique `name`), so there is no ordering dependency
 * between them. Sequential resolution would make a multi-replica rolling
 * deploy's boot time scale additively with the number of concurrently
 * in-flight claims (up to N × `graceMs` worst case) instead of the shared
 * bound of a single `graceMs`.
 * @param {object} [cfg=config] - application configuration object
 * @param {{pollIntervalMs?: number}} [opts] - test seam for the wait-poll interval (default {@link DEFAULT_STALE_CLAIM_POLL_INTERVAL_MS})
 * @returns {Promise<void>} Resolves once every running claim is settled.
 */
const resolveStaleClaims = async (cfg = config, { pollIntervalMs = DEFAULT_STALE_CLAIM_POLL_INTERVAL_MS } = {}) => {
  const graceMs = resolveStaleGraceMs(cfg);
  const runningRecords = await migrationRepository.listRunning();

  await Promise.all(runningRecords.map((record) => resolveRunningClaim(record, { graceMs, pollIntervalMs })));
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

  // Flip the claim to 'done' now that up() has actually finished (#3992) —
  // this is the atomic completion signal a hard kill mid-up() used to skip
  // entirely, since the pre-fix claim (a bare insert) doubled as "executed".
  await markMigrationDone(name);

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
 *
 * Boot-time stale-claim detection (#3992): before computing which migrations
 * are already done, {@link resolveStaleClaims} settles every leftover
 * `status:'running'` claim — a hard kill mid-`up()` on a prior boot leaves
 * exactly this trace. Must run first so a resumed migration is excluded from
 * the "already done" set below and re-attempted in the loop, instead of being
 * permanently skipped.
 * @param {object} [cfg=config] - application configuration object (test seam)
 * @returns {Promise<{total: number, executed: number}>} summary of migration run
 */
const run = async (cfg = config) => {
  // Ensure the Migration model is registered
  await import(path.resolve('modules/core/models/migration.model.mongoose.js'));

  // Ensure the unique index on `name` exists before any claim/record calls.
  // Without this, older deployments whose `migrations` collection was created
  // before the unique index was added would silently allow duplicate claims.
  await ensureMigrationIndexes();

  // Resolve any 'running' claim left over from a prior boot (crash residue or
  // a genuinely concurrent runner) BEFORE the files/executed comparison below.
  await resolveStaleClaims(cfg);

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

export default {
  run,
  discoverMigrationFiles,
  getExecutedMigrations,
  recordMigration,
  runMigration,
  ensureMigrationIndexes,
  resolveStaleClaims,
  resolveRunningClaim,
};
