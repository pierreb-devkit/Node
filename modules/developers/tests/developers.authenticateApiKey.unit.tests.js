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

  test('should call next when no Authorization header', async () => {
    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  test('should call next when Authorization does not start with Bearer', async () => {
    mockReq.headers.authorization = 'Basic abc123';

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  test('should call next when token does not start with trawl_', async () => {
    mockReq.headers.authorization = 'Bearer jwt_token_here';

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockApiKeyService.authenticate).not.toHaveBeenCalled();
  });

  test('should return 401 when API key is invalid', async () => {
    mockReq.headers.authorization = 'Bearer trawl_invalidkey';
    mockApiKeyService.authenticate.mockResolvedValue(null);

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
  });

  test('should set req.organization and req.apiKeyAuth when valid', async () => {
    const mockApiKey = { _id: 'key1', user: 'user1', organizationId: 'org1' };

    mockReq.headers.authorization = 'Bearer trawl_validkey12345678';
    mockApiKeyService.authenticate.mockResolvedValue(mockApiKey);

    await authenticateApiKey(mockReq, mockRes, mockNext);

    expect(mockReq.organization).toEqual({ _id: 'org1' });
    expect(mockReq.apiKeyAuth).toBe(true);
    expect(mockNext).toHaveBeenCalled();
  });

  test('should return 429 when rate limited', async () => {
    const mockApiKey = { _id: 'key2', user: 'user1', organizationId: 'org1' };
    mockApiKeyService.authenticate.mockResolvedValue(mockApiKey);

    mockReq.headers.authorization = 'Bearer trawl_ratetest12345678';

    // First request should succeed
    await authenticateApiKey(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();

    // Second immediate request should be rate limited
    mockNext.mockClear();
    await authenticateApiKey(mockReq, mockRes, mockNext);
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.set).toHaveBeenCalledWith('Retry-After', '5');
  });
});
