/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import configHelper from '../config.js';

/**
 * Unit tests for the environment predicate — isDevEnv / isProd.
 *
 * These are the shared production-hardening predicate. The deployment model runs
 * downstream apps as NODE_ENV={projectName} (any non-dev label), so hardening must
 * key off "is this NOT a known dev env" rather than the literal "production".
 */
describe('config helper — environment predicate (isDevEnv / isProd):', () => {
  describe('isDevEnv', () => {
    test('returns true for development', () => {
      expect(configHelper.isDevEnv('development')).toBe(true);
    });

    test('returns true for test', () => {
      expect(configHelper.isDevEnv('test')).toBe(true);
    });

    test('returns true for local', () => {
      expect(configHelper.isDevEnv('local')).toBe(true);
    });

    test('returns false for production', () => {
      expect(configHelper.isDevEnv('production')).toBe(false);
    });

    test('returns false for an arbitrary project env label', () => {
      expect(configHelper.isDevEnv('someproject')).toBe(false);
    });
  });

  describe('isProd', () => {
    test('returns true for production', () => {
      expect(configHelper.isProd('production')).toBe(true);
    });

    test('returns true for an arbitrary project env label (downstream deployment model)', () => {
      expect(configHelper.isProd('someproject')).toBe(true);
    });

    test('returns false for development', () => {
      expect(configHelper.isProd('development')).toBe(false);
    });

    test('returns false for test', () => {
      expect(configHelper.isProd('test')).toBe(false);
    });

    test('returns false for local', () => {
      expect(configHelper.isProd('local')).toBe(false);
    });
  });

  describe('default argument reads process.env.NODE_ENV at call time', () => {
    test('isDevEnv() honors NODE_ENV mutated after import', () => {
      const original = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        expect(configHelper.isDevEnv()).toBe(false);
        expect(configHelper.isProd()).toBe(true);
        process.env.NODE_ENV = 'development';
        expect(configHelper.isDevEnv()).toBe(true);
        expect(configHelper.isProd()).toBe(false);
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    test('isProd() defaults to development (dev) when NODE_ENV is unset', () => {
      const original = process.env.NODE_ENV;
      try {
        delete process.env.NODE_ENV;
        expect(configHelper.isProd()).toBe(false);
        expect(configHelper.isDevEnv()).toBe(true);
      } finally {
        process.env.NODE_ENV = original;
      }
    });
  });
});
