/**
 * Unit tests for isGlobalAdmin helper.
 */
import { describe, it, expect } from '@jest/globals';
import isGlobalAdmin from '../isGlobalAdmin.js';

describe('isGlobalAdmin', () => {
  it('should return false for undefined user', () => {
    expect(isGlobalAdmin(undefined)).toBe(false);
  });

  it('should return false for null user', () => {
    expect(isGlobalAdmin(null)).toBe(false);
  });

  it('should return false when user has no roles property', () => {
    expect(isGlobalAdmin({ _id: 'u1' })).toBe(false);
  });

  it('should return false when user roles is not an array', () => {
    expect(isGlobalAdmin({ roles: 'admin' })).toBe(false);
  });

  it('should return false when user roles is empty', () => {
    expect(isGlobalAdmin({ roles: [] })).toBe(false);
  });

  it('should return false when roles contains only user', () => {
    expect(isGlobalAdmin({ roles: ['user'] })).toBe(false);
  });

  it('should return false when roles contains lookalikes but not admin', () => {
    expect(isGlobalAdmin({ roles: ['user', 'superadmin', 'Admin'] })).toBe(false);
  });

  it('should return true when roles includes admin alongside user', () => {
    expect(isGlobalAdmin({ roles: ['user', 'admin'] })).toBe(true);
  });

  it('should return true when roles is exactly [admin]', () => {
    expect(isGlobalAdmin({ roles: ['admin'] })).toBe(true);
  });
});
