/**
 * Unit tests for the parallel-integration smoke orchestrator (#3518).
 *
 * Mocks `child_process.spawn` so we never actually launch jest. Asserts:
 *  - workers spawn with --passWithNoTests=false (catches downstream 0-test silent pass)
 *  - DEVKIT_NODE_db_uri is stripped from child env (per-pid default applies)
 *  - main() returns exit code 1 when any child exits non-zero
 *  - raceAgainstGlobalTimeout SIGKILLs stuck children and rejects with diagnostic
 *
 * NOTE: we test the orchestrator's branching (pass / fail / hang) without the
 * smoke script as the test itself, addressing Codacy's "missing coverage on
 * complex orchestrator file" finding.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

const importFresh = async () => {
  jest.resetModules();
  return import('../parallel-integration.smoke.js');
};

/**
 * Build a fake ChildProcess with controllable exit + kill spy.
 * @param {{ pid?: number }} opts
 */
const makeFakeChild = ({ pid = 1234 } = {}) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  child.exitWith = (code, signal = null) => {
    setImmediate(() => child.emit('exit', code, signal));
  };
  return child;
};

/**
 * Wait for main()'s spawn loop to finish (it has a 50ms inter-spawn delay).
 * Lets us call child.exitWith() after every worker is registered.
 */
const waitForSpawn = (workers = 2) => new Promise((r) => setTimeout(r, 50 * (workers + 1)));

describe('scripts/parallel-integration.smoke orchestrator', () => {
  let originalWorkers;
  let originalTimeout;
  let originalGlobalTimeout;
  let originalDbUri;

  beforeEach(() => {
    originalWorkers = process.env.SMOKE_WORKERS;
    originalTimeout = process.env.SMOKE_TIMEOUT_MS;
    originalGlobalTimeout = process.env.SMOKE_GLOBAL_TIMEOUT_MS;
    originalDbUri = process.env.DEVKIT_NODE_db_uri;
    process.env.SMOKE_WORKERS = '2';
    process.env.SMOKE_TIMEOUT_MS = '60000';
    process.env.SMOKE_GLOBAL_TIMEOUT_MS = '120000';
    process.env.DEVKIT_NODE_db_uri = 'mongodb://parent/should-be-stripped';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalWorkers === undefined) delete process.env.SMOKE_WORKERS;
    else process.env.SMOKE_WORKERS = originalWorkers;
    if (originalTimeout === undefined) delete process.env.SMOKE_TIMEOUT_MS;
    else process.env.SMOKE_TIMEOUT_MS = originalTimeout;
    if (originalGlobalTimeout === undefined) delete process.env.SMOKE_GLOBAL_TIMEOUT_MS;
    else process.env.SMOKE_GLOBAL_TIMEOUT_MS = originalGlobalTimeout;
    if (originalDbUri === undefined) delete process.env.DEVKIT_NODE_db_uri;
    else process.env.DEVKIT_NODE_db_uri = originalDbUri;
    jest.restoreAllMocks();
  });

  test('spawnWorker passes --passWithNoTests=false and strips DEVKIT_NODE_db_uri', async () => {
    const { spawnWorker } = await importFresh();
    const child = makeFakeChild({ pid: 100 });
    const spawnFn = jest.fn(() => child);

    const handle = spawnWorker(0, { spawnFn });
    child.exitWith(0);
    await handle.done;

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnFn.mock.calls[0];
    expect(bin).toBe('node_modules/.bin/jest');
    expect(args).toEqual(expect.arrayContaining(['--runInBand', '--passWithNoTests=false', '--testPathPatterns']));
    expect(opts.env.DEVKIT_NODE_db_uri).toBeUndefined();
    expect(opts.env.NODE_ENV).toBe('test');
  });

  test('main returns 0 when all workers exit 0 with distinct pids', async () => {
    const { main } = await importFresh();
    const c1 = makeFakeChild({ pid: 200 });
    const c2 = makeFakeChild({ pid: 201 });
    const queue = [c1, c2];
    const spawnFn = jest.fn(() => queue.shift());

    const promise = main({ spawnFn });
    await waitForSpawn();
    c1.exitWith(0);
    c2.exitWith(0);
    const code = await promise;

    expect(code).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  test('main returns 1 when any worker exits non-zero', async () => {
    const { main } = await importFresh();
    const c1 = makeFakeChild({ pid: 300 });
    const c2 = makeFakeChild({ pid: 301 });
    const queue = [c1, c2];
    const spawnFn = jest.fn(() => queue.shift());

    const promise = main({ spawnFn });
    await waitForSpawn();
    c1.exitWith(0);
    c2.exitWith(1); // simulates jest --passWithNoTests=false on 0-match pattern
    const code = await promise;

    expect(code).toBe(1);
  });

  test('main returns 2 and SIGKILLs stuck children on global timeout', async () => {
    process.env.SMOKE_GLOBAL_TIMEOUT_MS = '50';
    process.env.SMOKE_TIMEOUT_MS = '999999';
    const { main } = await importFresh();
    const c1 = makeFakeChild({ pid: 400 });
    const c2 = makeFakeChild({ pid: 401 });
    const queue = [c1, c2];
    const spawnFn = jest.fn(() => queue.shift());

    const promise = main({ spawnFn });
    // Neither child ever emits exit — global timeout must fire.
    const code = await promise;

    expect(code).toBe(2);
    expect(c1.kill).toHaveBeenCalledWith('SIGKILL');
    expect(c2.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('main returns 2 when a worker reports collided pid', async () => {
    const { main } = await importFresh();
    const c1 = makeFakeChild({ pid: 500 });
    const c2 = makeFakeChild({ pid: 500 }); // same pid = orchestration error
    const queue = [c1, c2];
    const spawnFn = jest.fn(() => queue.shift());

    const promise = main({ spawnFn });
    await waitForSpawn();
    c1.exitWith(0);
    c2.exitWith(0);
    const code = await promise;

    expect(code).toBe(2);
  });
});
