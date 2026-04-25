/**
 * Regression test for `config/defaults/test.config.js` per-pid DB URI (#3515).
 *
 * Without isolation, parallel jest processes (multi-worktree agent batches)
 * stomp on each other's fixtures via the shared `NodeTest` DB and
 * `globalSetup.dropDatabase()`. The default URI must include
 * `process.pid` so each invocation gets its own database.
 *
 * The literal `NodeTest_` prefix preserves the `/test/i` DB-name guard in
 * `scripts/jest.globalSetup.js`. Both invariants are asserted here.
 */
import { describe, test, expect } from '@jest/globals';

import testConfig from '../../config/defaults/test.config.js';

describe('config/defaults/test.config.js per-pid DB URI', () => {
  test('default db.uri includes process.pid (parallel-process isolation)', () => {
    expect(testConfig.db.uri).toContain(String(process.pid));
  });

  test('default db.uri starts with NodeTest_ to preserve /test/i drop-guard', () => {
    const dbName = new URL(testConfig.db.uri).pathname.replace(/^\//, '');
    expect(dbName).toMatch(/^NodeTest_/);
    expect(/test/i.test(dbName)).toBe(true);
  });

  test('default db.uri targets the local mongod (not a shared CI host)', () => {
    expect(testConfig.db.uri).toMatch(/^mongodb:\/\/127\.0\.0\.1:27017\//);
  });
});
