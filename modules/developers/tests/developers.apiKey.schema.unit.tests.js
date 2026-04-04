/**
 * Module dependencies.
 */
import schema from '../models/developers.apiKey.schema.js';

/**
 * Unit tests
 */
describe('Developers API Key schema unit tests:', () => {
  describe('ApiKeyCreate schema', () => {
    test('should accept a valid create request with name only', (done) => {
      const result = schema.ApiKeyCreate.safeParse({ name: 'My Key' });
      expect(result.error).toBeFalsy();
      expect(result.data.name).toBe('My Key');
      expect(result.data.scopes).toEqual(['read']);
      done();
    });

    test('should accept valid scopes', (done) => {
      const result = schema.ApiKeyCreate.safeParse({
        name: 'My Key',
        scopes: ['read', 'write'],
      });
      expect(result.error).toBeFalsy();
      expect(result.data.scopes).toEqual(['read', 'write']);
      done();
    });

    test('should accept a valid create request with expiresAt', (done) => {
      const result = schema.ApiKeyCreate.safeParse({
        name: 'My Key',
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
      expect(result.error).toBeFalsy();
      expect(result.data.expiresAt).toBeInstanceOf(Date);
      done();
    });

    test('should reject when name is missing', (done) => {
      const result = schema.ApiKeyCreate.safeParse({});
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject when name is empty', (done) => {
      const result = schema.ApiKeyCreate.safeParse({ name: '' });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject when name exceeds 100 characters', (done) => {
      const result = schema.ApiKeyCreate.safeParse({ name: 'a'.repeat(101) });
      expect(result.error).toBeDefined();
      done();
    });

    test('should reject unknown fields', (done) => {
      const result = schema.ApiKeyCreate.safeParse({
        name: 'My Key',
        unknown: 'field',
      });
      expect(result.error).toBeDefined();
      done();
    });

    test('should default scopes to read', (done) => {
      const result = schema.ApiKeyCreate.safeParse({ name: 'My Key' });
      expect(result.error).toBeFalsy();
      expect(result.data.scopes).toEqual(['read']);
      done();
    });

    test('should reject invalid scope value', (done) => {
      const result = schema.ApiKeyCreate.safeParse({
        name: 'My Key',
        scopes: ['invalid'],
      });
      expect(result.error).toBeDefined();
      done();
    });
  });
});
