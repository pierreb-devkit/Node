/**
 * Module dependencies.
 */
import schema from '../models/audit.schema.js';

/**
 * Unit tests
 */
describe('AuditLog schema unit tests:', () => {
  test('should validate a valid audit log entry', () => {
    const entry = {
      action: 'auth.login',
      userId: '507f1f77bcf86cd799439011',
      orgId: '507f1f77bcf86cd799439012',
      targetType: 'User',
      targetId: '507f1f77bcf86cd799439011',
      ip: '127.0.0.1',
      userAgent: 'Mozilla/5.0',
      metadata: { browser: 'Chrome' },
    };
    const result = schema.AuditLog.safeParse(entry);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe('auth.login');
  });

  test('should fail when action is empty', () => {
    const result = schema.AuditLog.safeParse({ action: '' });
    expect(result.success).toBe(false);
  });

  test('should fail when action is missing', () => {
    const result = schema.AuditLog.safeParse({});
    expect(result.success).toBe(false);
  });

  test('should provide defaults for optional fields', () => {
    const result = schema.AuditLog.safeParse({ action: 'test' });
    expect(result.success).toBe(true);
    expect(result.data.targetType).toBe('');
    expect(result.data.targetId).toBe('');
    expect(result.data.ip).toBe('');
    expect(result.data.userAgent).toBe('');
    expect(result.data.metadata).toEqual({});
  });

  test('should validate AuditQuery with defaults', () => {
    const result = schema.AuditQuery.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.page).toBe(1);
    expect(result.data.perPage).toBe(20);
  });

  test('should validate AuditQuery with custom values', () => {
    const result = schema.AuditQuery.safeParse({
      action: 'auth.login',
      userId: 'user1',
      page: '3',
      perPage: '50',
    });
    expect(result.success).toBe(true);
    expect(result.data.page).toBe(3);
    expect(result.data.perPage).toBe(50);
  });

  test('should reject perPage over 100', () => {
    const result = schema.AuditQuery.safeParse({ perPage: '200' });
    expect(result.success).toBe(false);
  });

  test('should reject page less than 1', () => {
    const result = schema.AuditQuery.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });
});
