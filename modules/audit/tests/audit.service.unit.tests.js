/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Mock the repository before importing the service
let mockCreate;
let mockList;

jest.unstable_mockModule('../repositories/audit.repository.js', () => ({
  default: {
    create: (...args) => mockCreate(...args),
    list: (...args) => mockList(...args),
  },
}));

// Mock config (mutable so individual tests can override flags)
const mockConfig = {
  audit: { enabled: true, ttlDays: 90, captureIp: true, captureUserAgent: true },
};
jest.unstable_mockModule('../../../config/index.js', () => ({
  default: mockConfig,
}));

// Mock logger to avoid winston config dependency in unit tests
jest.unstable_mockModule('../../../lib/services/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

/**
 * Unit tests
 */
describe('AuditService unit tests:', () => {
  let AuditService;

  beforeEach(async () => {
    mockCreate = jest.fn().mockResolvedValue({ _id: 'abc123', action: 'test.action' });
    mockList = jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, perPage: 20 });
    // Dynamic import after mocks are set up
    const mod = await import('../services/audit.service.js');
    AuditService = mod.default;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Reset config to defaults
    mockConfig.audit = { enabled: true, ttlDays: 90, captureIp: true, captureUserAgent: true };
  });

  test('should log an audit entry with request context', async () => {
    const userId = '507f1f77bcf86cd799439011';
    const orgId = '507f1f77bcf86cd799439012';

    await AuditService.log({
      action: 'auth.login',
      userId,
      organizationId: orgId,
      ip: '127.0.0.1',
      userAgent: 'TestAgent/1.0',
      targetType: 'User',
      targetId: userId,
      metadata: { foo: 'bar' },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.action).toBe('auth.login');
    expect(arg.userId).toBe(userId);
    expect(arg.orgId).toBe(orgId);
    expect(arg.ip).toBe('127.0.0.1');
    expect(arg.userAgent).toBe('TestAgent/1.0');
    expect(arg.targetType).toBe('User');
    expect(arg.targetId).toBe(userId);
    expect(arg.metadata).toEqual({ foo: 'bar' });
  });

  test('should log an audit entry without request context', async () => {
    await AuditService.log({ action: 'system.startup' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.action).toBe('system.startup');
    expect(arg.userId).toBeUndefined();
    expect(arg.orgId).toBeUndefined();
    expect(arg.ip).toBeFalsy();
    expect(arg.userAgent).toBeFalsy();
  });

  test('should not throw when repository create fails', async () => {
    mockCreate = jest.fn().mockRejectedValue(new Error('DB down'));

    const result = await AuditService.log({ action: 'test.fail' });
    expect(result).toBeNull();
  });

  test('should list audit logs with filters', async () => {
    const expected = { data: [{ action: 'auth.login' }], total: 1, page: 1, perPage: 20 };
    mockList = jest.fn().mockResolvedValue(expected);

    const result = await AuditService.list({ action: 'auth.login' }, 1, 20);
    expect(result).toEqual(expected);
    expect(mockList).toHaveBeenCalledWith({ action: 'auth.login' }, 1, 20);
  });

  test('should strip undefined filter values', async () => {
    const userId = '507f1f77bcf86cd799439011';
    await AuditService.list({ action: undefined, userId }, 1, 10);
    expect(mockList).toHaveBeenCalledWith({ userId }, 1, 10);
  });

  // GDPR config flag tests — ip/userAgent are now extracted by the caller
  test('should store ip when provided', async () => {
    await AuditService.log({ action: 'test.ip', ip: '10.0.0.1', userAgent: 'Bot/1.0' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.ip).toBe('10.0.0.1');
  });

  test('should store empty string ip when undefined is passed', async () => {
    await AuditService.log({ action: 'test.ip', ip: undefined, userAgent: 'Bot/1.0' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.ip).toBeFalsy();
  });

  test('should store userAgent when provided', async () => {
    await AuditService.log({ action: 'test.ua', ip: '10.0.0.1', userAgent: 'Bot/1.0' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.userAgent).toBe('Bot/1.0');
  });

  test('should set User-Agent to empty string when undefined is passed', async () => {
    await AuditService.log({ action: 'test.ua', ip: '10.0.0.1', userAgent: undefined });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.userAgent).toBeFalsy();
  });

  test('should store ip and userAgent when provided', async () => {
    await AuditService.log({ action: 'test.defaults', ip: '192.168.1.1', userAgent: 'DefaultBot/2.0' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.ip).toBe('192.168.1.1');
    expect(arg.userAgent).toBe('DefaultBot/2.0');
  });
});
