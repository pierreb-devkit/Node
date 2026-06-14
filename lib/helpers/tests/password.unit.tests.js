/**
 * Unit tests for the password helper (bcrypt wrappers).
 * Dependency-free leaf — mocks only bcrypt.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockBcryptHash = jest.fn();
const mockBcryptCompare = jest.fn();

jest.unstable_mockModule('bcrypt', () => ({
  default: {
    hash: (...args) => mockBcryptHash(...args),
    compare: (...args) => mockBcryptCompare(...args),
  },
}));

const { default: passwordHelper, hashPassword, comparePassword } = await import('../password.js');

describe('password helper', () => {
  beforeEach(() => {
    mockBcryptHash.mockReset();
    mockBcryptCompare.mockReset();
  });

  describe('hashPassword()', () => {
    test('hashes the stringified password with saltRounds = 10', async () => {
      mockBcryptHash.mockResolvedValueOnce('$2b$hashed');
      const result = await hashPassword('mypassword');
      expect(result).toBe('$2b$hashed');
      expect(mockBcryptHash).toHaveBeenCalledWith('mypassword', 10);
    });

    test('coerces a non-string password to a string before hashing', async () => {
      mockBcryptHash.mockResolvedValueOnce('$2b$num');
      await hashPassword(12345);
      expect(mockBcryptHash).toHaveBeenCalledWith('12345', 10);
    });
  });

  describe('comparePassword()', () => {
    test('compares the stringified candidate against the stored hash', async () => {
      mockBcryptCompare.mockResolvedValueOnce(true);
      const result = await comparePassword('plain', 'hashed');
      expect(result).toBe(true);
      expect(mockBcryptCompare).toHaveBeenCalledWith('plain', 'hashed');
    });

    test('coerces non-string args to strings before comparing', async () => {
      mockBcryptCompare.mockResolvedValueOnce(false);
      await comparePassword(12345, 67890);
      expect(mockBcryptCompare).toHaveBeenCalledWith('12345', '67890');
    });
  });

  describe('default export', () => {
    test('exposes hashPassword and comparePassword', () => {
      expect(typeof passwordHelper.hashPassword).toBe('function');
      expect(typeof passwordHelper.comparePassword).toBe('function');
    });
  });
});
