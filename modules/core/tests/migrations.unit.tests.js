/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

// Ensure the Migration model is registered before tests
import '../models/migration.model.mongoose.js';

import migrations from '../../../lib/services/migrations.js';
import migrationRepository from '../repositories/migration.repository.js';
import logger from '../../../lib/services/logger.js';

/**
 * Unit tests for the migration system (no DB connection required)
 */
describe('Migrations unit tests:', () => {
  describe('discoverMigrationFiles', () => {
    it('should return an array', async () => {
      const files = await migrations.discoverMigrationFiles();
      expect(Array.isArray(files)).toBe(true);
    });

    it('should return files sorted by filename', async () => {
      const files = await migrations.discoverMigrationFiles();
      for (let i = 1; i < files.length; i++) {
        const prev = path.basename(files[i - 1]);
        const curr = path.basename(files[i]);
        expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('runMigration', () => {
    it('should skip already-executed migrations', async () => {
      const executed = new Set(['modules/core/migrations/20260101000000-already-done.js']);
      const result = await migrations.runMigration('modules/core/migrations/20260101000000-already-done.js', executed);
      expect(result).toBe(false);
    });
  });

  describe('Migration model', () => {
    it('should be registered as a mongoose model', () => {
      const Migration = mongoose.model('Migration');
      expect(Migration).toBeDefined();
      expect(Migration.modelName).toBe('Migration');
    });

    it('should have name and executedAt fields', () => {
      const Migration = mongoose.model('Migration');
      const schema = Migration.schema;
      expect(schema.path('name')).toBeDefined();
      expect(schema.path('executedAt')).toBeDefined();
    });

    it('should require the name field', () => {
      const Migration = mongoose.model('Migration');
      const doc = new Migration({});
      const validation = doc.validateSync();
      expect(validation).toBeDefined();
      expect(validation.errors.name).toBeDefined();
    });

    it('should default executedAt to current date', () => {
      const Migration = mongoose.model('Migration');
      const doc = new Migration({ name: 'test-default-date.js' });
      expect(doc.executedAt).toBeInstanceOf(Date);
    });

    it('should serialize virtual id field in JSON', () => {
      const Migration = mongoose.model('Migration');
      const doc = new Migration({ name: 'test-virtual-id.js' });
      const json = doc.toJSON();
      expect(json.id).toBeDefined();
    });

    it('should declare a unique index on the name field', () => {
      const Migration = mongoose.model('Migration');
      // schema.indexes() returns [[fields, options], ...] for compound/explicit indexes.
      // For `unique: true` declared on the path, the index is carried on the schema path itself.
      const namePath = Migration.schema.path('name');
      expect(namePath.options.unique).toBe(true);
    });
  });

  // The following tests stub migrationRepository directly so they exercise the
  // claim / unclaim / error branches without needing a live MongoDB. Bootstrap
  // no longer re-runs migrations.run() per suite (it sets DEVKIT_MIGRATIONS_RAN
  // in globalSetup), so these branches must be covered explicitly.
  describe('repository-mocked branches', () => {
    let claimSpy;
    let markDoneSpy;
    let deleteByNameSpy;
    let listExecutedSpy;
    let listRunningSpy;
    let findByNameSpy;
    let syncIndexesSpy;

    beforeEach(() => {
      claimSpy = jest.spyOn(migrationRepository, 'claim');
      markDoneSpy = jest.spyOn(migrationRepository, 'markDone').mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
      deleteByNameSpy = jest.spyOn(migrationRepository, 'deleteByName').mockResolvedValue({ acknowledged: true, deletedCount: 1 });
      listExecutedSpy = jest.spyOn(migrationRepository, 'listExecuted');
      // #3992: run() now calls resolveStaleClaims() before the files/executed
      // comparison — default to "nothing running" so pre-existing tests below
      // that don't care about stale-claim resolution are unaffected.
      listRunningSpy = jest.spyOn(migrationRepository, 'listRunning').mockResolvedValue([]);
      // Default to null (never a real DB round-trip): a test that reaches the
      // poll branch without explicitly mocking a resolved value would otherwise
      // silently fall through to the REAL mongoose call and hang/timeout on
      // buffering instead of failing fast on an unexpected call.
      findByNameSpy = jest.spyOn(migrationRepository, 'findByName').mockResolvedValue(null);
      syncIndexesSpy = jest.spyOn(migrationRepository, 'syncIndexes').mockResolvedValue([]);
    });

    afterEach(() => {
      claimSpy.mockRestore();
      markDoneSpy.mockRestore();
      deleteByNameSpy.mockRestore();
      listExecutedSpy.mockRestore();
      listRunningSpy.mockRestore();
      findByNameSpy.mockRestore();
      syncIndexesSpy.mockRestore();
    });

    describe('runMigration claim path', () => {
      it('returns false when another runner already claimed the migration (E11000)', async () => {
        // Simulate the unique-index duplicate-key error from a concurrent runner
        const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        claimSpy.mockRejectedValueOnce(dup);
        const result = await migrations.runMigration('modules/core/migrations/__never-run-claim-fail.js', new Set());
        expect(result).toBe(false);
        expect(claimSpy).toHaveBeenCalledTimes(1);
      });

      it('rethrows non-duplicate errors from the repository', async () => {
        claimSpy.mockRejectedValueOnce(new Error('boom'));
        await expect(
          migrations.runMigration('modules/core/migrations/__never-run-other-error.js', new Set()),
        ).rejects.toThrow('boom');
      });

      it('unclaims when the migration file fails to import', async () => {
        claimSpy.mockResolvedValueOnce({ name: 'doesNotExist', status: 'running' });
        await expect(
          migrations.runMigration('modules/core/migrations/__file-does-not-exist.js', new Set()),
        ).rejects.toThrow();
        expect(deleteByNameSpy).toHaveBeenCalledTimes(1);
        expect(markDoneSpy).not.toHaveBeenCalled();
      });

      it('claims with status:running + pid/host forensic context, then marks done on success (#3992)', async () => {
        claimSpy.mockResolvedValueOnce({ name: 'ok', status: 'running' });
        // A real, side-effect-free migration file (no-op up()) so the import + up() call succeed for real.
        const realNoopMigration = path.resolve('modules/billing/migrations/20260501000000-add-meter-fields.js');
        const result = await migrations.runMigration(realNoopMigration, new Set());
        expect(result).toBe(true);
        expect(claimSpy).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ pid: expect.any(Number), host: expect.any(String) }),
        );
        expect(markDoneSpy).toHaveBeenCalledTimes(1);
        expect(deleteByNameSpy).not.toHaveBeenCalled();
      });

      it('unclaims (never marks done) when up() itself throws', async () => {
        claimSpy.mockResolvedValueOnce({ name: 'boom-up', status: 'running' });
        // A real ESM module living outside modules/&#42;/migrations/ (so a leftover
        // file, if cleanup ever failed, could never be picked up by
        // discoverMigrationFiles()'s glob and re-run against a real DB).
        // `.mjs` (not `.js`): this file lives outside the project root, so
        // there is no ancestor package.json with "type":"module" for Node's
        // loader to find — a plain `.js` extension there is parsed as
        // CommonJS and `export` throws a syntax error. `.mjs` is always ESM.
        const tmpFile = path.join(os.tmpdir(), `__3992-throws-in-up-${process.pid}-${Date.now()}.mjs`);
        const expectedName = path.relative(process.cwd(), tmpFile).replace(/\\/g, '/');
        fs.writeFileSync(tmpFile, "export async function up() { throw new Error('boom-up'); }\n");
        try {
          await expect(migrations.runMigration(tmpFile, new Set())).rejects.toThrow('boom-up');
          expect(deleteByNameSpy).toHaveBeenCalledWith(expectedName);
          expect(markDoneSpy).not.toHaveBeenCalled();
        } finally {
          fs.unlinkSync(tmpFile);
        }
      });
    });

    describe('run() summary branches', () => {
      it('returns total/executed counts when all migrations are already executed', async () => {
        // listExecuted returns every discovered file → executedCount stays 0
        const files = await migrations.discoverMigrationFiles();
        const executedNames = files.map((f) => path.relative(process.cwd(), f).replace(/\\/g, '/'));
        listExecutedSpy.mockResolvedValueOnce(executedNames.map((name) => ({ name })));
        const result = await migrations.run();
        expect(result.total).toBe(files.length);
        expect(result.executed).toBe(0);
        // resolveStaleClaims() runs before the executed-set comparison on every run()
        expect(listRunningSpy).toHaveBeenCalledTimes(1);
      });

      it('unclaims and rethrows when the imported migration has no up() export', async () => {
        // claim succeeds; the file we point at exists but exports no up()
        claimSpy.mockResolvedValueOnce({ name: 'no-up', status: 'running' });
        // This very test file is a real ESM module that does not export up()
        const realFileWithoutUp = path.resolve('modules/core/tests/migrations.unit.tests.js');
        await expect(
          migrations.runMigration(realFileWithoutUp, new Set()),
        ).rejects.toThrow(/does not export an up\(\) function/);
        expect(deleteByNameSpy).toHaveBeenCalled();
        expect(markDoneSpy).not.toHaveBeenCalled();
      });
    });

    // #3992: getExecutedMigrations() decides what "already done" means —
    // legacy records (no status field) and status:'done' are both skippable;
    // status:'running' must NEVER be treated as done (resolveStaleClaims owns it).
    describe('getExecutedMigrations status filtering (#3992)', () => {
      it('treats a legacy record (no status field) as done', async () => {
        listExecutedSpy.mockResolvedValueOnce([{ name: 'legacy-no-status.js' }]);
        const executed = await migrations.getExecutedMigrations();
        expect(executed.has('legacy-no-status.js')).toBe(true);
      });

      it('treats status:"done" as done', async () => {
        listExecutedSpy.mockResolvedValueOnce([{ name: 'finished.js', status: 'done' }]);
        const executed = await migrations.getExecutedMigrations();
        expect(executed.has('finished.js')).toBe(true);
      });

      it('does NOT treat status:"running" as done', async () => {
        listExecutedSpy.mockResolvedValueOnce([{ name: 'in-flight.js', status: 'running' }]);
        const executed = await migrations.getExecutedMigrations();
        expect(executed.has('in-flight.js')).toBe(false);
      });

      it('filters a mixed batch correctly', async () => {
        listExecutedSpy.mockResolvedValueOnce([
          { name: 'legacy.js' },
          { name: 'done.js', status: 'done' },
          { name: 'running.js', status: 'running' },
        ]);
        const executed = await migrations.getExecutedMigrations();
        expect([...executed].sort()).toEqual(['done.js', 'legacy.js']);
      });
    });

    // #3992: resolveRunningClaim is the boot-time decision unit for a single
    // status:'running' claim — stale (past grace) vs genuinely concurrent
    // (within grace, waits/polls).
    describe('resolveRunningClaim (#3992)', () => {
      it('stale claim (age >= grace) logs a WARN and deletes it so it can re-run', async () => {
        const staleRecord = { name: 'stale.js', status: 'running', startedAt: new Date(Date.now() - 1000) };
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        await migrations.resolveRunningClaim(staleRecord, { graceMs: 0 });
        expect(deleteByNameSpy).toHaveBeenCalledWith('stale.js');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('stale.js'));
        warnSpy.mockRestore();
      });

      it('fresh claim within grace waits (polls), then returns quietly once it flips to done', async () => {
        const freshRecord = { name: 'fresh.js', status: 'running', startedAt: new Date() };
        findByNameSpy.mockResolvedValueOnce({ ...freshRecord, status: 'done' });
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        await migrations.resolveRunningClaim(freshRecord, { graceMs: 5000, pollIntervalMs: 5 });
        expect(findByNameSpy).toHaveBeenCalledWith('fresh.js');
        expect(deleteByNameSpy).not.toHaveBeenCalledWith('fresh.js');
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('claim that disappears mid-wait (unclaimed elsewhere on failure) returns quietly', async () => {
        const freshRecord = { name: 'vanishing.js', status: 'running', startedAt: new Date() };
        findByNameSpy.mockResolvedValueOnce(null);
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        await migrations.resolveRunningClaim(freshRecord, { graceMs: 5000, pollIntervalMs: 5 });
        expect(findByNameSpy).toHaveBeenCalledWith('vanishing.js');
        expect(deleteByNameSpy).not.toHaveBeenCalledWith('vanishing.js');
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });

    // #3992: resolveStaleClaims is the boot-time orchestrator — fetches every
    // running claim and resolves each one.
    describe('resolveStaleClaims (#3992)', () => {
      it('resolves every running claim returned by listRunning', async () => {
        listRunningSpy.mockResolvedValueOnce([
          { name: 'stale-a.js', status: 'running', startedAt: new Date(Date.now() - 1000) },
          { name: 'stale-b.js', status: 'running', startedAt: new Date(Date.now() - 1000) },
        ]);
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        await migrations.resolveStaleClaims({ migrations: { staleRunningGraceMs: 0 } });
        expect(deleteByNameSpy).toHaveBeenCalledWith('stale-a.js');
        expect(deleteByNameSpy).toHaveBeenCalledWith('stale-b.js');
        warnSpy.mockRestore();
      });

      it('is a no-op when nothing is running', async () => {
        listRunningSpy.mockResolvedValueOnce([]);
        await migrations.resolveStaleClaims({ migrations: { staleRunningGraceMs: 0 } });
        expect(deleteByNameSpy).not.toHaveBeenCalled();
      });

      it('falls back to the default grace window when config value is not a positive number', async () => {
        listRunningSpy.mockResolvedValueOnce([{ name: 'edge.js', status: 'running', startedAt: new Date() }]);
        findByNameSpy.mockResolvedValueOnce({ name: 'edge.js', status: 'done' });
        // An invalid config value (negative / NaN / string) must not crash —
        // it falls back to DEFAULT_STALE_RUNNING_GRACE_MS (10 min), so the
        // fresh claim above takes the "wait" branch, not "stale". Small
        // pollIntervalMs override keeps this test fast.
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        await migrations.resolveStaleClaims({ migrations: { staleRunningGraceMs: -5 } }, { pollIntervalMs: 5 });
        expect(warnSpy).not.toHaveBeenCalled();
        expect(deleteByNameSpy).not.toHaveBeenCalledWith('edge.js');
        warnSpy.mockRestore();
      });
    });
  });
});
