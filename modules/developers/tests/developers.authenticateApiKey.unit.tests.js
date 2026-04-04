/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Unit tests for API Key authentication middleware
 */
describe('Developers authenticateApiKey middleware unit tests:', () => {
  let authenticateApiKey;
  let mockApiKeyService;
  let mockConfig;
  let mockNext;
  let mockRes;
  let mockReq;

  beforeEach(async () => {
    jest.resetModules();

    mockApiKeyService = {
      authenticate: jest.fn(),
    };

    mockConfig = {
      developers: { keys: { enabled: true } },
    };

    jest.unstable_mockModule('../services/developers.apiKey.service.js', () => ({
      default: mockApiKeyService,
    }));

    jest.unstable_mockModule('../../../config/index.js', () => ({
      default: mockConfig,
    }));

    jest.unstable_mockModule('../../../lib/helpers/responses.js', () => ({
      default: {
        error: jest.fn((res, status, msg, desc) => () => ({ type: 'error', status, message: msg, description: desc })),
      },
    }));

    const mod = await import('../middlewares/developers.authenticateApiKey.js');
    authenticateApiKey = mod.default;

    mockNext = jest.fn();
    mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
    mockReq = { headers: {} };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should call next when keys are not enabled', async () => {
    mockConfig.developers.keys.enabled = false;

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  test('should call next when no X-API-Key header', async () => {
    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  test('should call next when X-API-Key does not start with trawl_', async () => {
    mockReq.headers['x-api-key'] = 'other_token_here';

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockApiKeyService.authenticate).not.toHaveBeenCalled();
  });

  test('should return 401 when API key is invalid', async () => {
    mockReq.headers['x-api-key'] = 'trawl_invalidkey';
    mockApiKeyService.authenticate.mockResolvedValue(null);

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
  });

  test('should set req.organization and req.apiKeyAuth when valid', async () => {
    const mockApiKey = { _id: 'key1', user: 'user1', organizationId: 'org1' };

    mockReq.headers['x-api-key'] = 'trawl_validkey12345678';
    mockApiKeyService.authenticate.mockResolvedValue(mockApiKey);

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockReq.organization).toEqual({ _id: 'org1' });
    expect(mockReq.apiKeyAuth).toBe(true);
    expect(mockNext).toHaveBeenCalled();
  });

  test('should handle authentication errors with 500 response', async () => {
    mockReq.headers['x-api-key'] = 'trawl_errorkey12345678';
    mockApiKeyService.authenticate.mockRejectedValue(new Error('DB error'));

    const mod = await import('../../../lib/helpers/responses.js');
    const mockResponses = mod.default;

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockResponses.error).toHaveBeenCalledWith(mockRes, 500, 'Internal Server Error', 'API key authentication failed');
  });
});
