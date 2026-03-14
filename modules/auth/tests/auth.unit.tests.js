/**
 * Module dependencies.
 */
import { jest } from '@jest/globals';

/**
 * Mocks — must be declared before dynamic imports of the module under test.
 * jest.unstable_mockModule is the correct API for ES module mocking.
 */
const mockGetBrut = jest.fn();
const mockUpdateById = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../../users/services/users.service.js', () => ({
  default: { getBrut: mockGetBrut, updateById: mockUpdateById },
}));

const mockBcryptCompare = jest.fn();
const mockBcryptHash = jest.fn();
jest.unstable_mockModule('bcrypt', () => ({
  default: {
    compare: (...args) => mockBcryptCompare(...args),
    hash: (...args) => mockBcryptHash(...args),
  },
}));

const mockZxcvbn = jest.fn();
jest.unstable_mockModule('zxcvbn', () => ({ default: (...args) => mockZxcvbn(...args) }));

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: {
    whitelists: { users: { default: ['_id', 'id', 'firstName', 'lastName', 'email', 'roles', 'provider'] } },
    zxcvbn: { minimumScore: 3 },
  },
}));

// Dynamic import after mocks are registered
const { default: AuthService } = await import('../services/auth.service.js');

/**
 * Unit tests
 */
describe('Auth service unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // removeSensitive
  // ---------------------------------------------------------------------------
  describe('removeSensitive()', () => {
    test('should return null when user is null', () => {
      expect(AuthService.removeSensitive(null)).toBeNull();
    });

    test('should return null when user is not an object', () => {
      expect(AuthService.removeSensitive('string')).toBeNull();
    });

    test('should strip fields not in the whitelist', () => {
      const user = { _id: '1', email: 'a@b.com', password: 'secret', roles: ['user'] };
      const result = AuthService.removeSensitive(user);
      expect(result.email).toBe('a@b.com');
      expect(result.password).toBeUndefined();
    });

    test('should pick only the provided custom keys when conf is supplied', () => {
      const user = { _id: '1', email: 'a@b.com', firstName: 'Joe', roles: ['user'] };
      const result = AuthService.removeSensitive(user, ['email']);
      expect(result).toEqual({ email: 'a@b.com' });
    });
  });

  // ---------------------------------------------------------------------------
  // comparePassword
  // ---------------------------------------------------------------------------
  describe('comparePassword()', () => {
    test('should return true when passwords match', async () => {
      mockBcryptCompare.mockResolvedValueOnce(true);
      const result = await AuthService.comparePassword('plain', 'hashed');
      expect(result).toBe(true);
      expect(mockBcryptCompare).toHaveBeenCalledWith('plain', 'hashed');
    });

    test('should return false when passwords do not match', async () => {
      mockBcryptCompare.mockResolvedValueOnce(false);
      const result = await AuthService.comparePassword('wrong', 'hashed');
      expect(result).toBe(false);
    });

    test('should coerce arguments to strings before comparing', async () => {
      mockBcryptCompare.mockResolvedValueOnce(true);
      await AuthService.comparePassword(12345, 67890);
      expect(mockBcryptCompare).toHaveBeenCalledWith('12345', '67890');
    });
  });

  // ---------------------------------------------------------------------------
  // hashPassword
  // ---------------------------------------------------------------------------
  describe('hashPassword()', () => {
    test('should resolve with the hashed string', async () => {
      mockBcryptHash.mockResolvedValueOnce('$2b$hashed');
      const result = await AuthService.hashPassword('mypassword');
      expect(result).toBe('$2b$hashed');
      expect(mockBcryptHash).toHaveBeenCalledWith('mypassword', 10);
    });

    test('should coerce the password to a string', async () => {
      mockBcryptHash.mockResolvedValueOnce('$2b$hashed');
      await AuthService.hashPassword(42);
      expect(mockBcryptHash).toHaveBeenCalledWith('42', 10);
    });
  });

  // ---------------------------------------------------------------------------
  // authenticate
  // ---------------------------------------------------------------------------
  describe('authenticate()', () => {
    test('should throw when user is not found', async () => {
      mockGetBrut.mockResolvedValueOnce(null);
      await expect(AuthService.authenticate('a@b.com', 'pass')).rejects.toThrow('invalid user or password.');
    });

    test('should return sanitised user when credentials are valid', async () => {
      const storedUser = { _id: '1', email: 'a@b.com', firstName: 'Joe', password: 'hashed', roles: ['user'], provider: 'local', save: jest.fn() };
      mockGetBrut.mockResolvedValueOnce(storedUser);
      mockBcryptCompare.mockResolvedValueOnce(true);
      const result = await AuthService.authenticate('a@b.com', 'plain');
      expect(result.email).toBe('a@b.com');
      expect(result.password).toBeUndefined();
    });

    test('should throw when password does not match', async () => {
      mockGetBrut.mockResolvedValueOnce({ email: 'a@b.com', password: 'hashed', save: jest.fn() });
      mockBcryptCompare.mockResolvedValueOnce(false);
      await expect(AuthService.authenticate('a@b.com', 'wrong')).rejects.toThrow('invalid user or password.');
    });
  });

  // ---------------------------------------------------------------------------
  // checkPassword
  // ---------------------------------------------------------------------------
  describe('checkPassword()', () => {
    test('should return the password when score meets the minimum', () => {
      mockZxcvbn.mockReturnValueOnce({ score: 3, feedback: { suggestions: [] } });
      expect(AuthService.checkPassword('StrongPass1!')).toBe('StrongPass1!');
    });

    test('should throw AppError when score is below minimum', () => {
      mockZxcvbn.mockReturnValueOnce({ score: 1, feedback: { suggestions: ['Add more characters.'] } });
      expect(() => AuthService.checkPassword('weak')).toThrow('Password too weak.');
    });

    test('error details should include mapped suggestion objects', () => {
      mockZxcvbn.mockReturnValueOnce({ score: 2, feedback: { suggestions: ['Use a mix of letters.', 'Avoid common words.'] } });
      let thrownError;
      try {
        AuthService.checkPassword('medium');
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeDefined();
      expect(thrownError.details).toEqual([{ message: 'Use a mix of letters.' }, { message: 'Avoid common words.' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // generateRandomPassphrase
  // ---------------------------------------------------------------------------
  describe('generateRandomPassphrase()', () => {
    test('should return a string that passes the strength check', () => {
      mockZxcvbn.mockReturnValue({ score: 4, feedback: { suggestions: [] } });
      const result = AuthService.generateRandomPassphrase();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThanOrEqual(20);
    });

    test('should throw when the generated password is too weak', () => {
      mockZxcvbn.mockReturnValue({ score: 0, feedback: { suggestions: ['Make it longer.'] } });
      expect(() => AuthService.generateRandomPassphrase()).toThrow('Password too weak.');
    });
  });
});
