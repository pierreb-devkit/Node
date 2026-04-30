/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';
import path from 'path';
import mongoose from 'mongoose';

// Ensure the Migration model is registered before tests
import '../models/migration.model.mongoose.js';

import migrations from '../../../lib/services/migrations.js';
import migrationRepository from '../repositories/migration.repository.js';

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
    let createSpy;
    let deleteByNameSpy;
    let listExecutedSpy;
    let syncIndexesSpy;

    beforeEach(() => {
      createSpy = jest.spyOn(migrationRepository, 'create');
      deleteByNameSpy = jest.spyOn(migrationRepository, 'deleteByName').mockResolvedValue({ acknowledged: true, deletedCount: 1 });
      listExecutedSpy = jest.spyOn(migrationRepository, 'listExecuted');
      syncIndexesSpy = jest.spyOn(migrationRepository, 'syncIndexes').mockResolvedValue([]);
    });

    afterEach(() => {
      createSpy.mockRestore();
      deleteByNameSpy.mockRestore();
      listExecutedSpy.mockRestore();
      syncIndexesSpy.mockRestore();
    });

    describe('runMigration claim path', () => {
      it('returns false when another runner already claimed the migration (E11000)', async () => {
        // Simulate the unique-index duplicate-key error from a concurrent runner
        const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        createSpy.mockRejectedValueOnce(dup);
        const result = await migrations.runMigration('modules/core/migrations/__never-run-claim-fail.js', new Set());
        expect(result).toBe(false);
        expect(createSpy).toHaveBeenCalledTimes(1);
      });

      it('rethrows non-duplicate errors from the repository', async () => {
        createSpy.mockRejectedValueOnce(new Error('boom'));
        await expect(
          migrations.runMigration('modules/core/migrations/__never-run-other-error.js', new Set()),
        ).rejects.toThrow('boom');
      });

      it('unclaims when the migration file fails to import', async () => {
        createSpy.mockResolvedValueOnce({ name: 'doesNotExist' });
        await expect(
          migrations.runMigration('modules/core/migrations/__file-does-not-exist.js', new Set()),
        ).rejects.toThrow();
        expect(deleteByNameSpy).toHaveBeenCalledTimes(1);
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
      });

      it('unclaims and rethrows when the imported migration has no up() export', async () => {
        // claim succeeds; the file we point at exists but exports no up()
        createSpy.mockResolvedValueOnce({ name: 'no-up' });
        // This very test file is a real ESM module that does not export up()
        const realFileWithoutUp = path.resolve('modules/core/tests/migrations.unit.tests.js');
        await expect(
          migrations.runMigration(realFileWithoutUp, new Set()),
        ).rejects.toThrow(/does not export an up\(\) function/);
        expect(deleteByNameSpy).toHaveBeenCalled();
      });
    });
  });
});
