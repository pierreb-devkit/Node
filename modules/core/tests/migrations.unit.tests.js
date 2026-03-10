/**
 * Module dependencies.
 */
import path from 'path';
import mongoose from 'mongoose';

// Ensure the Migration model is registered before tests
import '../models/migration.model.mongoose.js';

import migrations from '../../../lib/services/migrations.js';

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
      const executed = new Set(['20260101000000-already-done.js']);
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
  });
});
