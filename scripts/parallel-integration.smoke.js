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
// `||` fallback: `parseInt('0', 10) || 240000` collapses `0` to the default
// because `0` is falsy. This is intentional — disabling the per-child watchdog
// via env is not supported (children leaked past the 15-min CI cap on ARC the
// one time the timer was missing). `SMOKE_TIMEOUT_MS=0` silently uses 240s; to
// truly run without a per-child timer, edit the code, do not set the env var.
// (Negative values are truthy and would pass through, but `setTimeout` clamps
// negative delays to 0ms, which would SIGKILL the children before they spawn —
// also undesirable. Just don't set negative values.)
export const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS, 10) || 240000;
export const GLOBAL_TIMEOUT_MS =
  Number.parseInt(process.env.SMOKE_GLOBAL_TIMEOUT_MS, 10) || 2 * TIMEOUT_MS + 30000;

/**
 * Spawn one jest child running the configured integration subset.
 * Each child inherits NODE_ENV=test but does NOT inherit DEVKIT_NODE_db_uri,
 * so it falls through to the per-pid default in `config/defaults/test.config.js`.
 *
 * The returned `handle` exposes a mutable `settled` flag flipped to `true`
 * once the child either exits or errors. Orchestration code (timeout path,
 * spawn-error catch) inspects this flag to identify which children still
 * need a SIGKILL — see `killStragglers` below.
 *
 * @param {number} index - worker ordinal (used for logging only)
 * @param {{ spawnFn?: typeof spawn }} [deps] - injected for unit tests
 * @returns {{ child: import('child_process').ChildProcess, done: Promise<{ index: number, pid: number, code: number|null, signal: NodeJS.Signals|null, stderr: string, durationMs: number }>, settled: boolean }}
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

  // Mutated to `true` by either the `exit` or `error` handler. `killStragglers`
  // reads this to skip already-settled children and avoid SIGKILL-ing a pid
  // the OS may have already recycled.
  const handle = { child, done: undefined, settled: false };

  handle.done = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      handle.settled = true;
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      handle.settled = true;
      resolve({ index, pid: child.pid, code, signal, stderr, durationMs: Date.now() - startedAt });
    });
  });

  // Attach a no-op rejection handler on the handle so that an early rejection
  // (e.g. ENOENT fires on nextTick, before `raceAgainstGlobalTimeout` had a
  // chance to wire its own `.then`) doesn't trip Node's unhandledRejection
  // tracker. The original rejection still propagates through `handle.done` to
  // any consumer that does attach later — this is purely a tracking guard.
  handle.done.catch(() => {});

  return handle;
};

/**
 * SIGKILL any handles whose child hasn't yet emitted `exit` (or `error`).
 * Reachable from both the global-timeout path and the spawn-error catch in
 * `main()` — without this, a `child.on('error', ...)` rejection on one worker
 * would short-circuit `Promise.all`, clear the global timer via `.finally`,
 * and leave sibling jest workers running until the 15-min CI cap.
 *
 * Best-effort: a `kill` failure is logged but never thrown, since this runs
 * during cleanup and the orchestrator is already on its way to a non-zero
 * exit code.
 *
 * @param {Array<{ child: import('child_process').ChildProcess, settled: boolean }>} handles
 * @param {string} reason - context for the log line
 */
export const killStragglers = (handles, reason) => {
  const stragglers = handles.filter((h) => !h.settled);
  if (stragglers.length === 0) return;
  const pids = stragglers.map((h) => h.child.pid);
  console.error(`[smoke] ${reason} — SIGKILL ${stragglers.length} unsettled worker(s) pids=${pids.join(',')}`);
  stragglers.forEach((h) => {
    try {
      h.child.kill('SIGKILL');
    } catch (err) {
      console.error(`[smoke] SIGKILL of pid=${h.child.pid} failed: ${err.message}`);
    }
  });
};

/**
 * Race a list of worker promises against a global orchestration timeout.
 * On timeout, SIGKILL all still-live children and reject with a diagnostic
 * listing which workers never reported `exit`. This is a belt-and-suspenders
 * guard on top of the per-child timer — covers the rare case where a child's
 * `exit` event is dropped (observed once on ARC).
 *
 * @param {Array<{ child: import('child_process').ChildProcess, done: Promise<any>, settled: boolean }>} handles
 * @param {number} globalTimeoutMs
 * @returns {Promise<any[]>}
 */
export const raceAgainstGlobalTimeout = (handles, globalTimeoutMs) => {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const stuckPids = handles.filter((h) => !h.settled).map((h) => h.child.pid);
      killStragglers(handles, `GLOBAL TIMEOUT after ${globalTimeoutMs}ms`);
      reject(new Error(`global timeout after ${globalTimeoutMs}ms (stuck workers: ${stuckPids.join(',')})`));
    }, globalTimeoutMs);
  });

  return Promise.race([Promise.all(handles.map((h) => h.done)), timeoutPromise]).finally(() =>
    clearTimeout(timeoutHandle),
  );
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
    // Spawn-error path: a `child.on('error', ...)` rejection from one worker
    // (binary missing, OS-level spawn failure) propagates here and short-circuits
    // `Promise.all`, so sibling workers may still be running. Without this
    // cleanup, they would leak as orphans until the 15-min CI cap. The global
    // timeout path SIGKILLs internally and re-enters as a no-op here (settled).
    killStragglers(handles, 'orchestration aborted — cleaning up siblings');
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
