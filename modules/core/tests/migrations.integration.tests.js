/**
 * Module dependencies.
 */
import mongoose from 'mongoose';

import mongooseService from '../../../lib/services/mongoose.js';
import { bootstrap } from '../../../lib/app.js';
import migrations from '../../../lib/services/migrations.js';

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

  afterAll(async () => {
    try {
      await mongooseService.disconnect();
    } catch (e) {
      console.log(e);
      expect(e).toBeFalsy();
    }
  });
});
