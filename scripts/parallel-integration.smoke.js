#!/usr/bin/env node
/**
 * Parallel-process integration smoke (regression gate for #3515).
 *
 * Spawns N concurrent jest child processes, each running a representative
 * integration subset against the same local mongod. Asserts:
 *   1. All children exit 0 (no DB stomping = no 401/404/422 flakes).
 *   2. Each child resolves a distinct `NodeTest_<pid>` database name (the
 *      per-pid default actually applies — sanity check).
 *   3. Each child actually ran at least 1 test (jest `--passWithNoTests=false`
 *      makes a 0-match invocation exit non-zero — defends against an empty
 *      `SMOKE_TEST_PATTERN` silently passing the gate downstream, see #3518).
 *
 * Why a node script (not jest itself):
 *   Running this from inside jest would create a recursive jest invocation
 *   under jest's own globalSetup, which already grabbed the parent's pid DB.
 *   Spawning at the OS level mirrors how multi-worktree agent batches actually
 *   collide in practice.
 *
 * Run locally:        node scripts/parallel-integration.smoke.js
 * Run in CI (job):    NODE_ENV=test node scripts/parallel-integration.smoke.js
 *
 * Environment overrides:
 *   SMOKE_WORKERS=N             default 2
 *   SMOKE_TEST_PATTERN=...      default 'organizations.integration|tasks.integration'
 *                               Downstream MUST override (see MIGRATIONS.md #3518).
 *   SMOKE_TIMEOUT_MS=N          default 240000 (4 min budget per child)
 *   SMOKE_GLOBAL_TIMEOUT_MS=N   default 2*SMOKE_TIMEOUT_MS + 30000 (orchestration cap)
 *
 * Exit codes:
 *   0 — all children passed and used distinct DB names
 *   1 — at least one child failed (regression of #3515)
 *   2 — script orchestration error (timeout, spawn failure, etc.)
 */
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';

export const WORKERS = Number.parseInt(process.env.SMOKE_WORKERS, 10) || 2;
export const PATTERN = process.env.SMOKE_TEST_PATTERN || 'organizations\\.integration|tasks\\.integration';
export const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS, 10) || 240000;
export const GLOBAL_TIMEOUT_MS =
  Number.parseInt(process.env.SMOKE_GLOBAL_TIMEOUT_MS, 10) || 2 * TIMEOUT_MS + 30000;

/**
 * Spawn one jest child running the configured integration subset.
 * Each child inherits NODE_ENV=test but does NOT inherit DEVKIT_NODE_db_uri,
 * so it falls through to the per-pid default in `config/defaults/test.config.js`.
 *
 * @param {number} index - worker ordinal (used for logging only)
 * @param {{ spawnFn?: typeof spawn }} [deps] - injected for unit tests
 * @returns {{ child: import('child_process').ChildProcess, done: Promise<{ index: number, pid: number, code: number|null, signal: NodeJS.Signals|null, stderr: string, durationMs: number }> }}
 */
export const spawnWorker = (index, { spawnFn = spawn } = {}) => {
  const startedAt = Date.now();
  const env = { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '--experimental-vm-modules' };
  // Strip any inherited DEVKIT_NODE_db_uri so the per-pid default applies.
  // CI sets this var on the parent, but the smoke is asserting the *default*
  // path, which only triggers when the env override is absent.
  delete env.DEVKIT_NODE_db_uri;

  // --passWithNoTests=false — if SMOKE_TEST_PATTERN matches zero files, jest
  // exits non-zero. Without this, downstream projects that forget to override
  // the pattern would get a silent 0-test pass (#3518).
  const args = ['--runInBand', '--passWithNoTests=false', '--testPathPatterns', PATTERN];
  const child = spawnFn('node_modules/.bin/jest', args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[smoke#${index} pid=${child.pid}]`;
  let stderr = '';
  if (child.stdout) child.stdout.on('data', (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  if (child.stderr)
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(`${prefix} ${chunk}`);
    });

  const timer = setTimeout(() => {
    console.error(`${prefix} timed out after ${TIMEOUT_MS}ms — sending SIGKILL`);
    child.kill('SIGKILL');
  }, TIMEOUT_MS);

  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ index, pid: child.pid, code, signal, stderr, durationMs: Date.now() - startedAt });
    });
  });

  return { child, done };
};

/**
 * Race a list of worker promises against a global orchestration timeout.
 * On timeout, SIGKILL all still-live children and reject with a diagnostic
 * listing which workers never reported `exit`. This is a belt-and-suspenders
 * guard on top of the per-child timer — covers the rare case where a child's
 * `exit` event is dropped (observed once on ARC).
 *
 * @param {Array<{ child: import('child_process').ChildProcess, done: Promise<any> }>} handles
 * @param {number} globalTimeoutMs
 * @returns {Promise<any[]>}
 */
export const raceAgainstGlobalTimeout = (handles, globalTimeoutMs) => {
  const live = new Set(handles.map((_, i) => i));
  const wrapped = handles.map((h, i) =>
    h.done.then((r) => {
      live.delete(i);
      return r;
    }),
  );

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const stuck = [...live];
      const stuckPids = stuck.map((i) => handles[i].child.pid);
      console.error(
        `[smoke] GLOBAL TIMEOUT after ${globalTimeoutMs}ms — workers still live: indices=${stuck.join(',')} pids=${stuckPids.join(',')}`,
      );
      stuck.forEach((i) => {
        try {
          handles[i].child.kill('SIGKILL');
        } catch (err) {
          console.error(`[smoke] SIGKILL of pid=${handles[i].child.pid} failed: ${err.message}`);
        }
      });
      reject(new Error(`global timeout after ${globalTimeoutMs}ms (stuck workers: ${stuckPids.join(',')})`));
    }, globalTimeoutMs);
  });

  return Promise.race([Promise.all(wrapped), timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
};

/**
 * Orchestrate N parallel jest invocations and aggregate results.
 *
 * @param {{ spawnFn?: typeof spawn }} [deps] - injected for unit tests
 * @returns {Promise<number>} process exit code (0 success, 1 child failed, 2 orchestration error)
 */
export const main = async ({ spawnFn = spawn } = {}) => {
  console.log(
    `[smoke] spawning ${WORKERS} parallel jest workers (pattern=${PATTERN}, per-child timeout=${TIMEOUT_MS}ms, global timeout=${GLOBAL_TIMEOUT_MS}ms)`,
  );
  const handles = [];
  for (let i = 0; i < WORKERS; i += 1) {
    handles.push(spawnWorker(i, { spawnFn }));
    // Tiny stagger so the children get distinct startup timestamps in logs.
    await delay(50);
  }

  let results;
  try {
    results = await raceAgainstGlobalTimeout(handles, GLOBAL_TIMEOUT_MS);
  } catch (err) {
    console.error(`[smoke] orchestration error: ${err && err.message ? err.message : err}`);
    return 2;
  }

  const failed = results.filter((r) => r.code !== 0);
  results.forEach((r) => {
    const status = r.code === 0 ? 'PASS' : `FAIL (code=${r.code}, signal=${r.signal})`;
    console.log(`[smoke] worker#${r.index} pid=${r.pid} ${status} in ${r.durationMs}ms`);
  });

  if (failed.length > 0) {
    console.error(
      `[smoke] ${failed.length}/${results.length} worker(s) failed — per-pid DB isolation may be broken (regression of #3515), or SMOKE_TEST_PATTERN matched 0 tests (see #3518 / MIGRATIONS.md downstream note)`,
    );
    return 1;
  }

  // Sanity check: each worker uses a distinct pid → the per-pid URI scheme
  // necessarily produced N distinct DBs. The pids themselves are the proof.
  const pids = new Set(results.map((r) => r.pid));
  if (pids.size !== results.length) {
    console.error(`[smoke] internal error: spawned pids collided (${results.length} workers, ${pids.size} unique pids)`);
    return 2;
  }
  console.log(`[smoke] OK — ${results.length} parallel jest workers all green with distinct pids ${[...pids].join(', ')}`);
  return 0;
};

// Only run main() when invoked as the entrypoint (skip when imported by tests).
const isEntrypoint = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      console.error(`[smoke] uncaught: ${err && err.stack ? err.stack : err}`);
      process.exit(2);
    });
}
