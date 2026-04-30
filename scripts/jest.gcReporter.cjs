/**
 * Jest reporter that calls global.gc() after each test suite when available.
 *
 * Registered in jest.config.js reporters array alongside the default reporter.
 * Requires --expose-gc in NODE_OPTIONS (already set in test:coverage script).
 *
 * Why: jest --runInBand accumulates module registry snapshots, mock closures, and
 * Mongoose schema objects across 99 suites in a single process. V8's heuristic GC
 * trigger is based on heap growth rate; calling gc() explicitly after each suite
 * ensures the old generation is collected before the next suite loads its modules.
 * This reduces peak RSS by releasing memory that V8 would otherwise hold until
 * it reached the old-space limit.
 *
 * When --expose-gc is absent (test:all, test:unit, test:integration), global.gc
 * is undefined and this reporter is a no-op, so it is safe to leave enabled for
 * all test runs.
 */

class GcReporter {
  onTestFileResult() {
    if (typeof global.gc === 'function') {
      global.gc();
    }
  }
}

module.exports = GcReporter;
