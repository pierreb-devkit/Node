import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  registerDataProvider,
  runDataExport,
  runDataErasure,
  getProviders,
  _reset,
} from '../lib/dataProvider.registry.js';

describe('DataProvider Registry', () => {
  beforeEach(() => {
    _reset();
  });

  describe('registerDataProvider', () => {
    it('should register a valid provider', () => {
      const exportFn = async () => ({});
      const eraseFn = async () => ({});

      registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: exportFn,
        erase: eraseFn,
      });

      const providers = getProviders();
      expect(providers.size).toBe(1);
      expect(providers.has('tasks')).toBe(true);
    });

    it('should throw TypeError for empty key', () => {
      expect(() => registerDataProvider({
        key: '',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: async () => ({}),
      })).toThrow('registerDataProvider: key must be a non-empty string');
    });

    it('should throw TypeError for non-string key', () => {
      expect(() => registerDataProvider({
        key: 123,
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: async () => ({}),
      })).toThrow('registerDataProvider: key must be a non-empty string');
    });

    it('should throw TypeError for invalid axis', () => {
      expect(() => registerDataProvider({
        key: 'tasks',
        axis: 'invalid',
        retention: 'delete',
        export: async () => ({}),
        erase: async () => ({}),
      })).toThrow('registerDataProvider: axis must be "user" or "org"');
    });

    it('should throw TypeError for invalid retention', () => {
      expect(() => registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'invalid',
        export: async () => ({}),
        erase: async () => ({}),
      })).toThrow('registerDataProvider: retention must be "delete" or "anonymize"');
    });

    it('should throw TypeError for non-function export', () => {
      expect(() => registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: 'not a function',
        erase: async () => ({}),
      })).toThrow('registerDataProvider: export must be a function');
    });

    it('should throw TypeError for non-function erase', () => {
      expect(() => registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: 'not a function',
      })).toThrow('registerDataProvider: erase must be a function');
    });

    it('should overwrite provider with same key (key-dedup)', () => {
      const exportFn1 = async () => ({ version: 1 });
      const eraseFn1 = async () => ({});
      const exportFn2 = async () => ({ version: 2 });
      const eraseFn2 = async () => ({});

      registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: exportFn1,
        erase: eraseFn1,
      });

      registerDataProvider({
        key: 'tasks',
        axis: 'org',
        retention: 'anonymize',
        export: exportFn2,
        erase: eraseFn2,
      });

      const providers = getProviders();
      expect(providers.size).toBe(1);
      expect(providers.get('tasks').axis).toBe('org');
      expect(providers.get('tasks').retention).toBe('anonymize');
    });
  });

  describe('runDataExport', () => {
    it('should run single provider export', async () => {
      const exportFn = async (payload) => ({
        tasks: [{ id: 1, title: 'Test Task' }],
        userId: payload.userId,
      });

      registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: exportFn,
        erase: async () => ({}),
      });

      const result = await runDataExport({ userId: 'user123' });

      expect(result.data.tasks).toEqual({
        tasks: [{ id: 1, title: 'Test Task' }],
        userId: 'user123',
      });
      expect(result.modules).toEqual(['tasks']);
    });

    it('should run multiple providers sequentially', async () => {
      const order = [];

      const tasksExport = async () => {
        order.push('tasks');
        return { tasks: [] };
      };

      const uploadsExport = async () => {
        order.push('uploads');
        return { uploads: [] };
      };

      registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: tasksExport,
        erase: async () => ({}),
      });

      registerDataProvider({
        key: 'uploads',
        axis: 'user',
        retention: 'delete',
        export: uploadsExport,
        erase: async () => ({}),
      });

      const result = await runDataExport({ userId: 'user123' });

      expect(order).toEqual(['tasks', 'uploads']);
      expect(result.modules).toEqual(['tasks', 'uploads']);
    });

    it('should return empty data for zero providers', async () => {
      const result = await runDataExport({ userId: 'user123' });

      expect(result.data).toEqual({});
      expect(result.modules).toEqual([]);
    });
  });

  describe('runDataErasure', () => {
    it('should run single provider erase', async () => {
      const eraseFn = async (payload) => ({
        deleted: 5,
        userId: payload.userId,
      });

      registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: eraseFn,
      });

      const result = await runDataErasure({ userId: 'user123' });

      expect(result.results.tasks).toEqual({
        deleted: 5,
        userId: 'user123',
      });
    });

    it('should propagate errors (fail-closed)', async () => {
      const eraseFn1 = async () => {
        throw new Error('Provider 1 failed');
      };

      const eraseFn2 = async () => ({
        deleted: 3,
      });

      registerDataProvider({
        key: 'failing',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: eraseFn1,
      });

      registerDataProvider({
        key: 'success',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: eraseFn2,
      });

      await expect(runDataErasure({ userId: 'user123' }))
        .rejects.toThrow('Provider 1 failed');
    });

    it('should run providers sequentially', async () => {
      const order = [];

      const tasksErase = async () => {
        order.push('tasks');
        return { deleted: 1 };
      };

      const uploadsErase = async () => {
        order.push('uploads');
        return { deleted: 2 };
      };

      registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: tasksErase,
      });

      registerDataProvider({
        key: 'uploads',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: uploadsErase,
      });

      await runDataErasure({ userId: 'user123' });

      expect(order).toEqual(['tasks', 'uploads']);
    });
  });

  describe('_reset', () => {
    it('should clear all registered providers', () => {
      registerDataProvider({
        key: 'tasks',
        axis: 'user',
        retention: 'delete',
        export: async () => ({}),
        erase: async () => ({}),
      });

      expect(getProviders().size).toBe(1);

      _reset();

      expect(getProviders().size).toBe(0);
    });
  });
});
