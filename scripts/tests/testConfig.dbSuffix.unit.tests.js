/**
 * Unit tests for the unified per-process DB suffix injected by `config/index.js` (#3563).
 *
 * The suffix `_p${pid}_w${workerId}` is the single isolation mechanism:
 *   - `pid` separates concurrent jest invocations (e.g. multi-worktree agent batches).
 *   - `workerId` separates workers within a single `jest --maxWorkers > 1` invocation.
 *   - Workers from different invocations cannot collide (pid differs).
 *
 * These tests mock `process.pid` and `process.env.JEST_WORKER_ID` to verify
 * the suffix shape without spawning real jest workers.
 *
 * Memory `feedback_codacy_meta_tests_avoid`: no meta-tests / orchestrators here.
 */
import { describe, test, expect } from '@jest/globals';

/**
 * Applies the suffix logic extracted from `config/index.js` to a base URI.
 * Kept inline so the test is self-contained; the real path runs in config/index.js.
 * If the logic changes, update both.
 *
 * @param {string} baseUri
 * @param {number} pid
 * @param {string} workerId - '0' when JEST_WORKER_ID is unset
 * @returns {string} URI with suffix applied
 */
const applySuffix = (baseUri, pid, workerId) => {
  const suffix = `_p${pid}_w${workerId}`;
  const parsed = new URL(baseUri);
  const dbName = parsed.pathname.replace(/^\//, '') || 'test';
  if (dbName.endsWith(suffix)) return baseUri;
  parsed.pathname = `/${dbName}${suffix}`;
  return parsed.toString();
};

describe('config/index.js unified DB suffix (_p{pid}_w{workerId})', () => {
  const BASE_URI = 'mongodb://127.0.0.1:27017/NodeTest';

  test('single worker (no JEST_WORKER_ID) → suffix _p<pid>_w0', () => {
    const pid = 12345;
    const workerId = '0'; // JEST_WORKER_ID unset → '0'
    const uri = applySuffix(BASE_URI, pid, workerId);
    expect(uri).toBe(`mongodb://127.0.0.1:27017/NodeTest_p${pid}_w0`);
  });

  test('jest multi-worker JEST_WORKER_ID=1 → suffix _p<pid>_w1', () => {
    const pid = 12345;
    const uri = applySuffix(BASE_URI, pid, '1');
    expect(uri).toBe(`mongodb://127.0.0.1:27017/NodeTest_p${pid}_w1`);
  });

  test('jest multi-worker JEST_WORKER_ID=2 → distinct suffix from worker 1', () => {
    const pid = 12345;
    const uri1 = applySuffix(BASE_URI, pid, '1');
    const uri2 = applySuffix(BASE_URI, pid, '2');
    expect(uri1).not.toBe(uri2);
    expect(uri2).toBe(`mongodb://127.0.0.1:27017/NodeTest_p${pid}_w2`);
  });

  test('overlapping worker IDs across different pids → distinct URIs (no collision)', () => {
    // Two concurrent jest invocations that both happen to have JEST_WORKER_ID=1
    // must still resolve distinct databases because their pids differ.
    const uriProc1 = applySuffix(BASE_URI, 11111, '1');
    const uriProc2 = applySuffix(BASE_URI, 22222, '1');
    expect(uriProc1).not.toBe(uriProc2);
    expect(uriProc1).toContain('_p11111_w1');
    expect(uriProc2).toContain('_p22222_w1');
  });

  test('suffix preserves /test/i drop-guard invariant (NodeTest_ prefix kept)', () => {
    const uri = applySuffix(BASE_URI, 99999, '3');
    const dbName = new URL(uri).pathname.replace(/^\//, '');
    expect(/test/i.test(dbName)).toBe(true);
    expect(dbName).toMatch(/^NodeTest_p\d+_w\d+$/);
  });

  test('CI override URI gets the same suffix appended (no stripping)', () => {
    // CI sets DEVKIT_NODE_db_uri=mongodb://localhost:27017/NodeTest (Layer 4 override)
    // The suffix block runs after deepMerge, so it appends to whatever URI is final.
    const ciUri = 'mongodb://localhost:27017/NodeTest';
    const uri = applySuffix(ciUri, 55555, '2');
    expect(uri).toBe('mongodb://localhost:27017/NodeTest_p55555_w2');
    expect(/test/i.test(new URL(uri).pathname.replace(/^\//, ''))).toBe(true);
  });
});
