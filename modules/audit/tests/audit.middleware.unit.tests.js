/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import EventEmitter from 'events';

// Mock AuditService before importing the middleware
let mockLog;

jest.unstable_mockModule('../services/audit.service.js', () => ({
  default: {
    log: (...args) => mockLog(...args),
  },
}));

const mockLoggerError = jest.fn();
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: { error: mockLoggerError, warn: jest.fn(), info: jest.fn() },
}));

/**
 * Unit tests for audit middleware
 */
describe('Audit middleware unit tests:', () => {
  let createAuditMiddleware;
  let deriveAction;
  let deriveTargetType;
  let deriveTargetId;

  beforeEach(async () => {
    mockLog = jest.fn().mockResolvedValue({ _id: 'abc123' });
    const mod = await import('../middlewares/audit.middleware.js');
    createAuditMiddleware = mod.createAuditMiddleware;
    deriveAction = mod.deriveAction;
    deriveTargetType = mod.deriveTargetType;
    deriveTargetId = mod.deriveTargetId;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Helper to create a mock response that emits 'finish'.
   */
  const createRes = (statusCode = 200) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    return res;
  };

  /**
   * Helper to create a mock request.
   */
  const createReq = (overrides = {}) => ({
    method: 'POST',
    originalUrl: '/api/auth/signin',
    url: '/api/auth/signin',
    baseUrl: '/api/auth',
    route: { path: '/signin' },
    user: { _id: '507f1f77bcf86cd799439011' },
    organization: { _id: '507f1f77bcf86cd799439012' },
    params: {},
    ip: '127.0.0.1',
    headers: { 'user-agent': 'TestAgent/1.0' },
    ...overrides,
  });

  test('should skip GET requests', () => {
    const middleware = createAuditMiddleware();
    const req = createReq({ method: 'GET', originalUrl: '/api/users' });
    const res = createRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    res.emit('finish');
    expect(mockLog).not.toHaveBeenCalled();
  });

  test('should skip non-API routes (skip prefixes)', () => {
    const middleware = createAuditMiddleware();
    const next = jest.fn();

    const prefixes = ['/public/file.js', '/favicon.ico', '/api/docs', '/api/health'];
    for (const url of prefixes) {
      const req = createReq({ method: 'POST', originalUrl: url });
      const res = createRes();
      middleware(req, res, next);
      res.emit('finish');
    }

    expect(mockLog).not.toHaveBeenCalled();
  });

  test('should skip unauthenticated requests', () => {
    const middleware = createAuditMiddleware();
    const req = createReq({ user: null });
    const res = createRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    res.emit('finish');
    expect(mockLog).not.toHaveBeenCalled();
  });

  test('should skip non-2xx responses', () => {
    const middleware = createAuditMiddleware();
    const req = createReq();
    const res = createRes(401);
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');
    expect(mockLog).not.toHaveBeenCalled();
  });

  test('should skip 500 responses', () => {
    const middleware = createAuditMiddleware();
    const req = createReq();
    const res = createRes(500);
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');
    expect(mockLog).not.toHaveBeenCalled();
  });

  test('should log POST mutations with correct action/targetType/targetId', () => {
    const middleware = createAuditMiddleware();
    const req = createReq({
      method: 'POST',
      originalUrl: '/api/auth/signin',
      baseUrl: '/api/auth',
      route: { path: '/signin' },
      params: {},
    });
    const res = createRes(200);
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');

    expect(mockLog).toHaveBeenCalledTimes(1);
    const call = mockLog.mock.calls[0][0];
    expect(call.action).toBe('auth.signin');
    expect(call.targetType).toBe('User');
    expect(call.req).toBe(req);
  });

  test('should log PUT mutations', () => {
    const middleware = createAuditMiddleware();
    const orgId = '507f1f77bcf86cd799439099';
    const req = createReq({
      method: 'PUT',
      originalUrl: `/api/organizations/${orgId}`,
      baseUrl: '/api/organizations',
      route: { path: '/:orgId' },
      params: { orgId },
    });
    const res = createRes(200);
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');

    expect(mockLog).toHaveBeenCalledTimes(1);
    const call = mockLog.mock.calls[0][0];
    expect(call.action).toBe('organizations');
    expect(call.targetType).toBe('Organization');
    expect(call.targetId).toBe(orgId);
  });

  test('should log DELETE mutations', () => {
    const middleware = createAuditMiddleware();
    const userId = '507f1f77bcf86cd799439088';
    const req = createReq({
      method: 'DELETE',
      originalUrl: `/api/users/${userId}`,
      baseUrl: '/api/users',
      route: { path: '/:userId' },
      params: { userId },
    });
    const res = createRes(200);
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');

    expect(mockLog).toHaveBeenCalledTimes(1);
    const call = mockLog.mock.calls[0][0];
    expect(call.action).toBe('users');
    expect(call.targetType).toBe('User');
    expect(call.targetId).toBe(userId);
  });

  test('should derive action from nested route path', () => {
    expect(deriveAction('/signin', '/api/auth')).toBe('auth.signin');
    expect(deriveAction('/checkout', '/api/billing')).toBe('billing.checkout');
    expect(deriveAction('/:orgId/members/invite', '/api/organizations')).toBe('organizations.invite');
    expect(deriveAction('/:token', '/api/auth/password/reset')).toBe('auth.reset');
  });

  test('should derive targetType from route', () => {
    expect(deriveTargetType('/signin', '/api/auth')).toBe('User');
    expect(deriveTargetType('/checkout', '/api/billing')).toBe('Organization');
    expect(deriveTargetType('/:orgId', '/api/organizations')).toBe('Organization');
    expect(deriveTargetType('/', '/api/tasks')).toBe('Task');
  });

  test('should derive targetId from params', () => {
    expect(deriveTargetId({ orgId: '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011');
    expect(deriveTargetId({ token: 'abc123' })).toBe('');
    expect(deriveTargetId({})).toBe('');
    expect(deriveTargetId(null)).toBe('');
  });

  test('should accept custom skipPrefixes', () => {
    const middleware = createAuditMiddleware({ skipPrefixes: ['/api/custom'] });
    const req = createReq({ method: 'POST', originalUrl: '/api/custom/action' });
    const res = createRes();
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');
    expect(mockLog).not.toHaveBeenCalled();
  });

  test('should not throw when AuditService.log rejects and should log the error', async () => {
    const dbError = new Error('DB down');
    mockLog = jest.fn().mockRejectedValue(dbError);
    const middleware = createAuditMiddleware();
    const req = createReq();
    const res = createRes(200);
    const next = jest.fn();

    middleware(req, res, next);
    // Should not throw
    expect(() => res.emit('finish')).not.toThrow();
    // Allow the .catch() handler to run
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLoggerError).toHaveBeenCalledWith(
      'audit.middleware: audit log write failed',
      { message: dbError.message, stack: dbError.stack },
    );
  });
});
