/**
 * Module dependencies.
 */
import { jest, describe, test, expect } from '@jest/globals';

// Mock config before importing the module under test
let mockRateLimitConfig;
jest.unstable_mockModule('../../../config/index.js', () => ({
  default: {
    get rateLimit() { return mockRateLimitConfig; },
  },
}));

// Track all calls — use a plain array immune to clearMocks
const calls = [];
jest.unstable_mockModule('express-rate-limit', () => ({
  default: (opts) => {
    calls.push(opts);
    const middleware = (req, _res, next) => next();
    middleware._rateLimitOpts = opts;
    middleware._keyGenerator = opts.keyGenerator;
    return middleware;
  },
  ipKeyGenerator: (ip) => `ipkg:${ip}`,
}));

// Import once — the Proxy is a singleton, so use distinct profile names per test
const { default: limiters } = await import('../rateLimiter.js');

describe('rateLimiter middleware unit tests:', () => {
  describe('passthrough behavior', () => {
    test('should return passthrough middleware when rateLimit config is undefined', () => {
      mockRateLimitConfig = undefined;
      const middleware = limiters.noConfig;
      const next = jest.fn();
      middleware({}, {}, next);
      expect(next).toHaveBeenCalled();
    });

    test('should return passthrough when profile is missing from config', () => {
      mockRateLimitConfig = { existingProfile: { windowMs: 1000, max: 5 } };
      const middleware = limiters.missingProfile;
      const next = jest.fn();
      middleware({}, {}, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('keyGenerator', () => {
    test('should return userId for authenticated requests', () => {
      mockRateLimitConfig = {
        profileAuth: { windowMs: 1000, max: 5 },
      };
      const callsBefore = calls.length;
      limiters.profileAuth;
      expect(calls.length).toBe(callsBefore + 1);

      const opts = calls[calls.length - 1];
      expect(opts.keyGenerator).toBeDefined();
      const req = { user: { _id: { toString: () => '507f1f77bcf86cd799439011' } }, ip: '10.0.0.1' };
      expect(opts.keyGenerator(req)).toBe('507f1f77bcf86cd799439011');
    });

    test('should fall back to ipKeyGenerator(req.ip) for unauthenticated requests', () => {
      mockRateLimitConfig = {
        profileUnauth: { windowMs: 1000, max: 100 },
      };
      limiters.profileUnauth;

      const opts = calls[calls.length - 1];
      const req = { ip: '203.0.113.42' };
      expect(opts.keyGenerator(req)).toBe('ipkg:203.0.113.42');
    });

    test('should fall back to ipKeyGenerator(req.ip) when user exists but _id is undefined', () => {
      mockRateLimitConfig = {
        profileNoId: { windowMs: 1000, max: 5 },
      };
      limiters.profileNoId;

      const opts = calls[calls.length - 1];
      const req = { user: {}, ip: '192.168.1.1' };
      expect(opts.keyGenerator(req)).toBe('ipkg:192.168.1.1');
    });

    test('should respect custom keyGenerator from config profile', () => {
      const customKeyGen = (req) => req.headers['x-api-key'];
      mockRateLimitConfig = {
        profileCustom: { windowMs: 1000, max: 50, keyGenerator: customKeyGen },
      };
      limiters.profileCustom;

      const opts = calls[calls.length - 1];
      expect(opts.keyGenerator).toBe(customKeyGen);
    });
  });

  describe('caching', () => {
    test('should cache limiter and not recreate on second access', () => {
      mockRateLimitConfig = {
        profileCache: { windowMs: 1000, max: 5 },
      };
      const callsBefore = calls.length;
      const first = limiters.profileCache;
      const second = limiters.profileCache;
      expect(first).toBe(second);
      expect(calls.length - callsBefore).toBe(1);
    });
  });
});
