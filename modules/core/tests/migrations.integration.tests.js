/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

import mongooseService from '../../../lib/services/mongoose.js';
import { bootstrap } from '../../../lib/app.js';
import migrations from '../../../lib/services/migrations.js';
import logger from '../../../lib/services/logger.js';

/**
 * Integration tests for the migration system (requires DB connection)
 */
describe('Migrations integration tests:', () => {
  beforeAll(async () => {
    try {
      await bootstrap();
    } catch (err) {
      console.log(err);
      expect(err).toBeFalsy();
    }
  });

  describe('getExecutedMigrations', () => {
    it('should return a Set', async () => {
      const executed = await migrations.getExecutedMigrations();
      expect(executed).toBeInstanceOf(Set);
    });
  });

  describe('recordMigration', () => {
    const testMigrationName = `__test_migration_${Date.now()}.js`;

    afterAll(async () => {
      const Migration = mongoose.model('Migration');
      await Migration.deleteOne({ name: testMigrationName });
    });

    it('should create a migration record in the database', async () => {
      const record = await migrations.recordMigration(testMigrationName);
      expect(record).toBeDefined();
      expect(record.name).toBe(testMigrationName);
      expect(record.executedAt).toBeInstanceOf(Date);
    });

    it('should reject duplicate migration names', async () => {
      await expect(migrations.recordMigration(testMigrationName)).rejects.toThrow();
    });
  });

  describe('run', () => {
    it('should return a summary object with total and executed counts', async () => {
      const result = await migrations.run();
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('executed');
      expect(typeof result.total).toBe('number');
      expect(typeof result.executed).toBe('number');
    });

    it('should be idempotent when called multiple times', async () => {
      const first = await migrations.run();
      const second = await migrations.run();
      expect(second.executed).toBe(0);
      expect(second.total).toBe(first.total);
    });
  });

  // #3992: real end-to-end coverage of claim-with-status against a live DB —
  // by this point every real migration file has been executed at least once
  // by the `run` describe block above, so their Migration records exist.
  describe('claim-with-status (#3992)', () => {
    it('a completed migration record carries status:done + startedAt/finishedAt/pid/host', async () => {
      const Migration = mongoose.model('Migration');
      // No-op, side-effect-free real migration — safe to inspect/re-run.
      const record = await Migration.findOne({ name: /add-meter-fields\.js$/ }).lean();
      expect(record).toBeTruthy();
      expect(record.status).toBe('done');
      expect(record.startedAt).toBeInstanceOf(Date);
      expect(record.finishedAt).toBeInstanceOf(Date);
      expect(record.finishedAt.getTime()).toBeGreaterThanOrEqual(record.startedAt.getTime());
      expect(typeof record.pid).toBe('number');
      expect(typeof record.host).toBe('string');
    });
  });

  describe('legacy record (no status field) treated as done (#3992)', () => {
    const legacyName = `__legacy_no_status_${Date.now()}.js`;

    afterAll(async () => {
      const Migration = mongoose.model('Migration');
      await Migration.deleteOne({ name: legacyName });
    });

    it('is included in getExecutedMigrations() even though it predates the status field', async () => {
      // recordMigration() inserts the exact legacy shape (name + executedAt,
      // no status) — the same shape every pre-#3992 claim has in production.
      await migrations.recordMigration(legacyName);
      const executed = await migrations.getExecutedMigrations();
      expect(executed.has(legacyName)).toBe(true);
    });
  });

  describe('boot-time stale-claim resolution (#3992)', () => {
    // Re-use the same no-op, side-effect-free real migration as the
    // resume target — re-running its up() is a genuine no-op, so tampering
    // with its claim record here is safe and requires no cleanup of DB state
    // beyond the Migration record itself.
    const targetName = 'modules/billing/migrations/20260501000000-add-meter-fields.js';
    let originalRecord;

    beforeEach(async () => {
      const Migration = mongoose.model('Migration');
      originalRecord = await Migration.findOne({ name: targetName }).lean();
      // Sanity: must already be 'done' from the `run` describe block above.
      expect(originalRecord?.status).toBe('done');
    });

    afterEach(async () => {
      // Restore the record to its pre-tampering state so later suites/tests
      // (and any other assertion relying on stable migration history) see
      // consistent state.
      const Migration = mongoose.model('Migration');
      await Migration.updateOne(
        { name: targetName },
        {
          $set: {
            status: originalRecord.status,
            startedAt: originalRecord.startedAt,
            finishedAt: originalRecord.finishedAt,
          },
        },
      );
    });

    it('a stale running claim (age >= grace) is deleted with a loud WARN, then re-executed by run()', async () => {
      const Migration = mongoose.model('Migration');
      const staleStartedAt = new Date(Date.now() - 5000);
      await Migration.updateOne(
        { name: targetName },
        { $set: { status: 'running', startedAt: staleStartedAt }, $unset: { finishedAt: 1 } },
      );

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      let result;
      try {
        // graceMs: 1 — the 5s-old claim above is immediately past grace, no real wait.
        result = await migrations.run({ migrations: { staleRunningGraceMs: 1 } });
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls.some((args) => String(args[0]).includes(targetName))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }

      expect(result.executed).toBeGreaterThanOrEqual(1);
      const record = await Migration.findOne({ name: targetName }).lean();
      expect(record.status).toBe('done');
      expect(record.finishedAt.getTime()).toBeGreaterThan(staleStartedAt.getTime());
    });

    it('a fresh running claim within the grace window is waited on, not deleted, until it flips to done', async () => {
      const Migration = mongoose.model('Migration');
      await Migration.updateOne(
        { name: targetName },
        { $set: { status: 'running', startedAt: new Date() }, $unset: { finishedAt: 1 } },
      );

      // Simulate a genuinely concurrent runner (another instance mid-deploy)
      // completing shortly after boot begins polling.
      const flipTimer = setTimeout(() => {
        Migration.updateOne({ name: targetName }, { $set: { status: 'done', finishedAt: new Date() } }).catch(() => {});
      }, 50);

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await migrations.resolveStaleClaims({ migrations: { staleRunningGraceMs: 2000 } }, { pollIntervalMs: 20 });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        clearTimeout(flipTimer);
      }

      const record = await Migration.findOne({ name: targetName }).lean();
      expect(record.status).toBe('done');
    });
  });

  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });
});
