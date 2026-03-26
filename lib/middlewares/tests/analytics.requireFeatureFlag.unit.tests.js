/**
 * Module dependencies.
 */
import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

/**
 * Unit tests for requireFeatureFlag middleware
 */
describe('requireFeatureFlag middleware unit tests:', () => {
  let requireFeatureFlag;
  let mockFeatureFlagsService;
  let req;
  let res;
  let next;

  beforeEach(async () => {
    jest.resetModules();

    mockFeatureFlagsService = {
      isEnabled: jest.fn(),
      getVariant: jest.fn(),
    };

    jest.unstable_mockModule('../../services/analytics.featureFlags.js', () => ({
      default: mockFeatureFlagsService,
    }));

    const mod = await import('../analytics.requireFeatureFlag.js');
    requireFeatureFlag = mod.default;

    req = {
      user: { _id: 'user-123' },
      organization: { _id: 'org-456' },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should call next when flag is enabled', async () => {
    mockFeatureFlagsService.isEnabled.mockResolvedValue(true);

    const middleware = requireFeatureFlag('beta-feature');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockFeatureFlagsService.isEnabled).toHaveBeenCalledWith(
      'beta-feature',
      'user-123',
      { groups: { company: 'org-456' } },
    );
  });

  test('should return 403 when flag is disabled', async () => {
    mockFeatureFlagsService.isEnabled.mockResolvedValue(false);
    mockFeatureFlagsService.getVariant.mockResolvedValue(false);

    const middleware = requireFeatureFlag('beta-feature');
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Forbidden',
      }),
    );
  });

  test('should call next when analytics is not configured (fail-open)', async () => {
    mockFeatureFlagsService.isEnabled.mockResolvedValue(false);
    mockFeatureFlagsService.getVariant.mockResolvedValue(undefined);

    const middleware = requireFeatureFlag('beta-feature');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  test('should return 401 when user is not authenticated', async () => {
    req.user = undefined;

    const middleware = requireFeatureFlag('beta-feature');
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('should not include groups when organization is absent', async () => {
    req.organization = undefined;
    mockFeatureFlagsService.isEnabled.mockResolvedValue(true);

    const middleware = requireFeatureFlag('beta-feature');
    await middleware(req, res, next);

    expect(mockFeatureFlagsService.isEnabled).toHaveBeenCalledWith(
      'beta-feature',
      'user-123',
      {},
    );
    expect(next).toHaveBeenCalledWith();
  });

  test('should call next(err) on unexpected errors', async () => {
    const error = new Error('PostHog timeout');
    mockFeatureFlagsService.isEnabled.mockRejectedValue(error);

    const middleware = requireFeatureFlag('beta-feature');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
