/**
 * Regression tests for `config/defaults/test.config.js` (#3515, #3563).
 *
 * The default URI is a neutral `NodeTest` base. Per-process isolation is now
 * applied by a single block in `config/index.js` that appends `_p${pid}_w${workerId}`.
 * These tests verify the neutral base shape and the /test/i drop-guard invariant.
 */
import { describe, test, expect } from '@jest/globals';

import testConfig from '../../config/defaults/test.config.js';

describe('config/defaults/test.config.js base URI shape', () => {
  test('default db.uri is the neutral NodeTest base (suffix applied by config/index.js)', () => {
    expect(testConfig.db.uri).toBe('mongodb://127.0.0.1:27017/NodeTest');
  });

  test('default db.uri starts with NodeTest to preserve /test/i drop-guard', () => {
    const dbName = new URL(testConfig.db.uri).pathname.replace(/^\//, '');
    expect(dbName).toMatch(/^NodeTest/);
    expect(/test/i.test(dbName)).toBe(true);
  });

  test('default db.uri targets the local mongod (not a shared CI host)', () => {
    expect(testConfig.db.uri).toMatch(/^mongodb:\/\/127\.0\.0\.1:27017\//);
  });
});
