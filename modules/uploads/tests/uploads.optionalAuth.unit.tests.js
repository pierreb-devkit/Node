/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

// passport.authenticate(strategy, opts, cb) returns a middleware; the mock calls cb
// with the (err, user) pair each test sets.
let authResult;
jest.unstable_mockModule('passport', () => ({
  default: {
    authenticate: (_strategy, _opts, cb) => () => cb(authResult.err, authResult.user),
  },
}));

let mockResolveMembership;
jest.unstable_mockModule('../../organizations/services/organizations.membership.service.js', () => ({
  default: { resolveMembership: (...args) => mockResolveMembership(...args) },
}));

const mockWarn = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { warn: (...args) => mockWarn(...args) },
}));

/**
 * Unit tests
 */
describe('uploads optionalAuth unit tests:', () => {
  let optionalAuth;

  beforeAll(async () => {
    optionalAuth = (await import('../middlewares/uploads.optionalAuth.js')).default;
  });

  beforeEach(() => {
    mockWarn.mockClear();
    mockResolveMembership = jest.fn();
  });

  /**
   * Run the middleware and resolve once it calls next().
   * @param {Object} req - fake request
   * @returns {Promise<void>}
   */
  const run = (req) => new Promise((resolve) => optionalAuth(req, {}, resolve));

  test('no token leaves the request as a guest', async () => {
    authResult = { err: null, user: false };
    const req = {};
    await run(req);
    expect(req.user).toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('a user lookup error is logged and the request stays a guest', async () => {
    authResult = { err: new Error('db down'), user: false };
    const req = {};
    await run(req);
    expect(req.user).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  test('a valid user with a current organization gets its membership', async () => {
    const membership = { organizationId: 'org1' };
    mockResolveMembership.mockResolvedValue(membership);
    authResult = { err: null, user: { _id: 'u1', currentOrganization: 'org1' } };
    const req = {};
    await run(req);
    expect(req.user._id).toBe('u1');
    expect(req.membership).toBe(membership);
  });

  test('a membership lookup error is logged and leaves no membership', async () => {
    mockResolveMembership.mockRejectedValue(new Error('lookup failed'));
    authResult = { err: null, user: { _id: 'u1', currentOrganization: 'org1' } };
    const req = {};
    await run(req);
    expect(req.user._id).toBe('u1');
    expect(req.membership).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });
});
