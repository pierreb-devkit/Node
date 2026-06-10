import { describe, test, expect } from '@jest/globals';
import redactUrl, { SENSITIVE_QUERY_KEYS } from '../redactUrl.js';

describe('redactUrl', () => {
  test('redacts an inviteToken value, preserving the path', () => {
    expect(redactUrl('/api/auth/signup?inviteToken=abc123deadbeef')).toBe('/api/auth/signup?inviteToken=REDACTED');
  });

  test('redacts inviteToken among other query params, leaving the rest intact', () => {
    expect(redactUrl('/api/auth/signup?foo=1&inviteToken=secret&bar=2')).toBe('/api/auth/signup?foo=1&inviteToken=REDACTED&bar=2');
  });

  test('redacts inviteToken when it is the first of several params', () => {
    expect(redactUrl('/x?inviteToken=secret&bar=2')).toBe('/x?inviteToken=REDACTED&bar=2');
  });

  test('leaves a URL without a query string unchanged', () => {
    expect(redactUrl('/api/auth/signup')).toBe('/api/auth/signup');
  });

  test('leaves a URL whose query has no sensitive key unchanged', () => {
    expect(redactUrl('/api/users?page=2&perPage=10')).toBe('/api/users?page=2&perPage=10');
  });

  test('handles a bare sensitive key with no value (no = sign)', () => {
    // `?inviteToken` with no value: still scrubbed (becomes inviteToken=REDACTED) so a
    // malformed/edge query can never leak a partial token form downstream.
    expect(redactUrl('/x?inviteToken')).toBe('/x?inviteToken=REDACTED');
  });

  test('does not redact a key that merely CONTAINS the sensitive name as a substring', () => {
    expect(redactUrl('/x?notinviteTokenish=keepme')).toBe('/x?notinviteTokenish=keepme');
  });

  test('is tolerant of falsy / non-string input', () => {
    expect(redactUrl('')).toBe('');
    expect(redactUrl(undefined)).toBeUndefined();
    expect(redactUrl(null)).toBeNull();
  });

  test('exports inviteToken as a sensitive key', () => {
    expect(SENSITIVE_QUERY_KEYS).toContain('inviteToken');
  });
});
