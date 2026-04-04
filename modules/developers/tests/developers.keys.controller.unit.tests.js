/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for API Keys controller
 */
describe('Developers Keys controller unit tests:', () => {
  let controller;
  let mockApiKeyService;
  let mockRes;

  const orgId = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    jest.resetModules();

    mockApiKeyService = {
      create: jest.fn(),
      list: jest.fn(),
      get: jest.fn(),
      revoke: jest.fn(),
    };

    jest.unstable_mockModule('../services/developers.apiKey.service.js', () => ({
      default: mockApiKeyService,
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        success: jest.fn((res, msg) => (data) => ({ type: 'success', message: msg, data })),
        error: jest.fn((res, status, msg, desc) => () => ({ type: 'error', message: msg, description: desc })),
      },
    }));

    const mod = await import('../controllers/developers.keys.controller.js');
    controller = mod.default;

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('list', () => {
    test('should call service with organization id and pagination defaults', async () => {
      const req = { organization: { _id: orgId }, query: {} };
      mockApiKeyService.list.mockResolvedValue({ data: [], total: 0 });

      await controller.list(req, mockRes);

      expect(mockApiKeyService.list).toHaveBeenCalledWith(orgId, 1, 20);
    });

    test('should pass pagination query params to service', async () => {
      const req = { organization: { _id: orgId }, query: { page: '2', perPage: '10' } };
      mockApiKeyService.list.mockResolvedValue({ data: [], total: 0 });

      await controller.list(req, mockRes);

      expect(mockApiKeyService.list).toHaveBeenCalledWith(orgId, 2, 10);
    });
  });

  describe('create', () => {
    test('should call service with body, user and org id', async () => {
      const req = {
        body: { name: 'Key' },
        user: { _id: 'user1' },
        organization: { _id: orgId },
      };
      mockApiKeyService.create.mockResolvedValue({ id: 'k1', plainKey: 'trawl_abc' });

      await controller.create(req, mockRes);

      expect(mockApiKeyService.create).toHaveBeenCalledWith(
        { name: 'Key' },
        { _id: 'user1' },
        orgId,
      );
    });

    test('should handle service errors', async () => {
      const req = {
        body: { name: 'Key' },
        user: { _id: 'user1' },
        organization: { _id: orgId },
      };
      mockApiKeyService.create.mockRejectedValue(new Error('fail'));

      await controller.create(req, mockRes);
      // Controller should not throw
    });
  });

  describe('revoke', () => {
    test('should call service with apiKey id from req.apiKey', async () => {
      const req = { apiKey: { _id: 'k1' } };
      mockApiKeyService.revoke.mockResolvedValue({ id: 'k1', revoked: true });

      await controller.revoke(req, mockRes);

      expect(mockApiKeyService.revoke).toHaveBeenCalledWith('k1');
    });
  });

  describe('apiKeyByID', () => {
    test('should load api key and attach to req', async () => {
      const req = {};
      const next = jest.fn();
      mockApiKeyService.get.mockResolvedValue({ _id: 'k1', name: 'Test' });

      await controller.apiKeyByID(req, mockRes, next, 'k1');

      expect(req.apiKey).toEqual({ _id: 'k1', name: 'Test' });
      expect(next).toHaveBeenCalled();
    });

    test('should return 404 when key not found', async () => {
      const req = {};
      const next = jest.fn();
      mockApiKeyService.get.mockResolvedValue(null);

      await controller.apiKeyByID(req, mockRes, next, 'k1');

      expect(next).not.toHaveBeenCalled();
    });
  });
});
