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

  // Issue #4064: responses.error(res, ...)(x) reads `x.details` off whatever
  // it is handed. Before this fix, the 403 branch passed `{ type, flag }`
  // flat, with no `.details` key at all — pickWhitelistedDetails
  // (lib/helpers/responses.js) received `undefined` and produced no
  // `payload.details` in ANY environment, not just production. This test
  // forces NODE_ENV=production so the dev-only serialized-error blob
  // (payload.error) cannot exist either — the same production-mode-toggle
  // convention used in billing.quota.unit.tests.js (#4062) — so the only way
  // this test can pass is via the real `payload.details` field a production
  // client reads. Proven red against the pre-fix code (see commit history).
  test('production mode: 403 response carries type in payload.details, not just the dev-only error blob', async () => {
    mockFeatureFlagsService.isEnabled.mockResolvedValue(false);
    mockFeatureFlagsService.getVariant.mockResolvedValue(false);

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const middleware = requireFeatureFlag('beta-feature');
      await middleware(req, res, next);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    expect(res.status).toHaveBeenCalledWith(403);
    const payload = res.json.mock.calls[0][0];
    // `type` is on the built-in whitelist (lib/helpers/responses.js
    // DEFAULT_DETAILS_WHITELIST) and is safe/useful for a client to branch
    // on. `flag` names an internal PostHog feature-toggle key and is
    // deliberately NOT whitelisted (see analytics.requireFeatureFlag.js) —
    // it must never appear in the production body.
    expect(payload.details).toEqual({ type: 'FEATURE_FLAG_DISABLED' });
    expect(payload.details.flag).toBeUndefined();
    // Production never leaks the raw serialized-error blob.
    expect(payload.error).toBeUndefined();
  });
});
