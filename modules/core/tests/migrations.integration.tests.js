/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

import mongooseService from '../../../lib/services/mongoose.js';
import { bootstrap } from '../../../lib/app.js';
import migrations from '../../../lib/services/migrations.js';
import migrationRepository from '../repositories/migration.repository.js';
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
    // A core-owned, no-op, side-effect-free real migration as the resume
    // target (`modules/core/migrations/20260728130000-noop-core-test-fixture.js`)
    // — re-running its up() is a genuine no-op, so tampering with its claim
    // record here is safe and requires no cleanup of DB state beyond the
    // Migration record itself. Core-owned (not modules/billing's fixture) so
    // this suite never depends on an unrelated, optional module (#3992 follow-up).
    const targetName = 'modules/core/migrations/20260728130000-noop-core-test-fixture.js';
    let originalRecord;

    beforeEach(async () => {
      const Migration = mongoose.model('Migration');
      originalRecord = await Migration.findOne({ name: targetName }).lean();
      // Sanity: must already be 'done' from the `run` describe block above.
      expect(originalRecord?.status).toBe('done');
    });

    afterEach(async () => {
      // If the beforeEach sanity check failed, originalRecord was never
      // snapshotted — skip restoration so that assertion failure surfaces
      // instead of being masked by a TypeError reading .status off undefined.
      if (!originalRecord) return;
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

  // #3992 follow-up: a late failure from a runner must only ever remove ITS
  // OWN claim (name + status:'running' + matching pid/host), never a
  // differently-owned record — real Mongo coverage of migration.repository.js#deleteClaim,
  // not just the mocked call-shape assertions in the unit suite.
  describe('ownership-scoped unclaim on failure (#3992 follow-up)', () => {
    it('a failing runMigration deletes only the claim it just inserted', async () => {
      const Migration = mongoose.model('Migration');
      // Real ESM file outside modules/&#42;/migrations/ so discoverMigrationFiles()'s
      // glob can never pick up a leftover if cleanup failed.
      const tmpFile = path.join(os.tmpdir(), `__3992-ownership-throws-${process.pid}-${Date.now()}.mjs`);
      const name = path.relative(process.cwd(), tmpFile).replace(/\\/g, '/');
      fs.writeFileSync(tmpFile, "export async function up() { throw new Error('boom'); }\n");
      try {
        await expect(migrations.runMigration(tmpFile, new Set())).rejects.toThrow('boom');
        expect(await Migration.findOne({ name }).lean()).toBeNull();
      } finally {
        fs.unlinkSync(tmpFile);
        await Migration.deleteOne({ name });
      }
    });

    it('deleteClaim never removes a still-running claim owned by a different pid/host', async () => {
      const Migration = mongoose.model('Migration');
      const name = `__3992_ownership_running_${Date.now()}.js`;
      // Simulate a genuinely different, still-in-flight runner's claim
      // (status:'running', foreign pid/host) — isolates the ownership check
      // itself, distinct from markDone's separate status:'running' guard.
      await Migration.create({ name, executedAt: new Date(), status: 'running', startedAt: new Date(), pid: 999999, host: 'a-different-host' });
      try {
        const result = await migrationRepository.deleteClaim(name, { pid: process.pid, host: os.hostname() });
        expect(result.deletedCount).toBe(0);
        const record = await Migration.findOne({ name }).lean();
        expect(record).toBeTruthy();
        expect(record.status).toBe('running');
        expect(record.pid).toBe(999999);
      } finally {
        await Migration.deleteOne({ name });
      }
    });

    it('deleteClaim never removes an already-completed record, even one this pid/host once owned', async () => {
      const Migration = mongoose.model('Migration');
      const name = `__3992_ownership_done_${Date.now()}.js`;
      const context = { pid: process.pid, host: os.hostname() };
      // Simulate THIS process's own claim having already been flipped to
      // done by the time a (hypothetically delayed) failure handler runs —
      // status:'running' in the filter must block the delete even when
      // pid/host match exactly.
      await Migration.create({ name, executedAt: new Date(), status: 'done', startedAt: new Date(), finishedAt: new Date(), ...context });
      try {
        const result = await migrationRepository.deleteClaim(name, context);
        expect(result.deletedCount).toBe(0);
        const record = await Migration.findOne({ name }).lean();
        expect(record).toBeTruthy();
        expect(record.status).toBe('done');
      } finally {
        await Migration.deleteOne({ name });
      }
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
