/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for API Key service
 */
describe('Developers API Key service unit tests:', () => {
  let ApiKeyService;
  let mockRepository;

  const orgId = '507f1f77bcf86cd799439011';
  const userId = '607f1f77bcf86cd799439022';

  beforeEach(async () => {
    jest.resetModules();

    mockRepository = {
      create: jest.fn(),
      list: jest.fn(),
      get: jest.fn(),
      findByHashedKey: jest.fn(),
      revoke: jest.fn(),
      updateLastUsed: jest.fn().mockResolvedValue({}),
    };

    jest.unstable_mockModule('../repositories/developers.apiKey.repository.js', () => ({
      default: mockRepository,
    }));

    const mod = await import('../services/developers.apiKey.service.js');
    ApiKeyService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create', () => {
    test('should create an API key and return the raw key once', async () => {
      const mockUser = { _id: userId };
      mockRepository.create.mockResolvedValue({
        toJSON: () => ({
          id: 'key123',
          name: 'Test Key',
          prefix: 'trawl_abcd12',
          scopes: ['read'],
          expiresAt: null,
          createdAt: new Date(),
        }),
      });

      const result = await ApiKeyService.create({ name: 'Test Key', scopes: ['read'] }, mockUser, orgId);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Key',
          scopes: ['read'],
          user: userId,
          organizationId: orgId,
          hashedKey: expect.any(String),
          prefix: expect.stringMatching(/^trawl_/),
        }),
      );
      expect(result.plainKey).toBeDefined();
      expect(result.plainKey).toMatch(/^trawl_/);
      expect(result.id).toBe('key123');
    });

    test('should use SHA-256 to hash the key', async () => {
      const mockUser = { _id: userId };
      let capturedHashedKey;
      mockRepository.create.mockImplementation((data) => {
        capturedHashedKey = data.hashedKey;
        return Promise.resolve({
          toJSON: () => ({ id: 'k1', name: 'Test', prefix: data.prefix }),
        });
      });

      await ApiKeyService.create({ name: 'Test' }, mockUser, orgId);

      // SHA-256 hash is 64 hex characters
      expect(capturedHashedKey).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('list', () => {
    test('should delegate to repository with organization and pagination', async () => {
      mockRepository.list.mockResolvedValue({ data: [], total: 0 });

      const result = await ApiKeyService.list(orgId, 1, 20);

      expect(mockRepository.list).toHaveBeenCalledWith(orgId, 1, 20);
      expect(result).toEqual({ data: [], total: 0 });
    });
  });

  describe('get', () => {
    test('should delegate to repository', async () => {
      mockRepository.get.mockResolvedValue({ id: 'k1' });

      const result = await ApiKeyService.get('k1');

      expect(mockRepository.get).toHaveBeenCalledWith('k1');
      expect(result).toEqual({ id: 'k1' });
    });
  });

  describe('revoke', () => {
    test('should delegate to repository', async () => {
      mockRepository.revoke.mockResolvedValue({ id: 'k1', revoked: true });

      const result = await ApiKeyService.revoke('k1');

      expect(mockRepository.revoke).toHaveBeenCalledWith('k1');
      expect(result.revoked).toBe(true);
    });
  });

  describe('authenticate', () => {
    test('should return null for non-trawl_ prefix', async () => {
      const result = await ApiKeyService.authenticate('sk_test_123');
      expect(result).toBeNull();
    });

    test('should return null for empty input', async () => {
      const result = await ApiKeyService.authenticate('');
      expect(result).toBeNull();
    });

    test('should return null for null input', async () => {
      const result = await ApiKeyService.authenticate(null);
      expect(result).toBeNull();
    });

    test('should return the key document when hash matches', async () => {
      const candidate = { _id: 'key123', user: userId, organizationId: orgId };
      mockRepository.findByHashedKey.mockResolvedValue(candidate);

      const result = await ApiKeyService.authenticate('trawl_abcd12345678rest');

      expect(result).toBe(candidate);
      expect(mockRepository.findByHashedKey).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/));
      expect(mockRepository.updateLastUsed).toHaveBeenCalledWith('key123');
    });

    test('should return null when no key found by hash', async () => {
      mockRepository.findByHashedKey.mockResolvedValue(null);

      const result = await ApiKeyService.authenticate('trawl_abcd12345678rest');

      expect(result).toBeNull();
    });
  });
});
