import { describe, test, expect } from '@jest/globals';
import redactUrl, { SENSITIVE_QUERY_KEYS, SENSITIVE_PATH_MARKERS, redactPathSecrets } from '../redactUrl.js';

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

  test('leaves a non-sensitive URL without a query string unchanged', () => {
    expect(redactUrl('/api/auth/signup')).toBe('/api/auth/signup');
  });

  test('leaves a URL whose query has no sensitive key unchanged', () => {
    expect(redactUrl('/api/users?page=2&perPage=10')).toBe('/api/users?page=2&perPage=10');
  });

  test('redacts a reset-token path with no query string', () => {
    expect(redactUrl('/api/auth/reset/SECRETTOKEN')).toBe('/api/auth/reset/REDACTED');
  });

  test('redacts a verify-email-token path with no query string', () => {
    expect(redactUrl('/api/auth/verify-email/SECRETTOKEN')).toBe('/api/auth/verify-email/REDACTED');
  });

  test('redacts an invitation verify-token path with no query string', () => {
    expect(redactUrl('/api/auth/invitations/verify/SECRETTOKEN')).toBe('/api/auth/invitations/verify/REDACTED');
    expect(redactUrl('/api/invitations/verify/SECRETTOKEN')).toBe('/api/invitations/verify/REDACTED');
  });

  test('redacts a reset-token path when a query string is also present', () => {
    expect(redactUrl('/api/auth/reset/SECRETTOKEN?foo=1')).toBe('/api/auth/reset/REDACTED?foo=1');
  });

  test('redacts a verify-email-token path when a query string is also present', () => {
    expect(redactUrl('/api/auth/verify-email/SECRETTOKEN?foo=1')).toBe('/api/auth/verify-email/REDACTED?foo=1');
  });

  test('redacts an invitation verify-token path when a query string is also present', () => {
    expect(redactUrl('/api/auth/invitations/verify/SECRETTOKEN?foo=1')).toBe('/api/auth/invitations/verify/REDACTED?foo=1');
  });

  test('redacts both a path secret and a query secret in the same URL', () => {
    expect(redactUrl('/api/auth/reset/SECRETTOKEN?inviteToken=abc123')).toBe('/api/auth/reset/REDACTED?inviteToken=REDACTED');
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

describe('redactPathSecrets', () => {
  test('redacts the segment following /reset/', () => {
    expect(redactPathSecrets('/api/auth/reset/SECRETTOKEN')).toBe('/api/auth/reset/REDACTED');
  });

  test('redacts the segment following /verify-email/', () => {
    expect(redactPathSecrets('/api/auth/verify-email/SECRETTOKEN')).toBe('/api/auth/verify-email/REDACTED');
  });

  test('redacts the segment following /verify/ (invitation verify routes)', () => {
    expect(redactPathSecrets('/api/auth/invitations/verify/SECRETTOKEN')).toBe('/api/auth/invitations/verify/REDACTED');
    expect(redactPathSecrets('/api/invitations/verify/SECRETTOKEN')).toBe('/api/invitations/verify/REDACTED');
  });

  test('leaves a path with no sensitive marker unchanged', () => {
    expect(redactPathSecrets('/api/tasks/123')).toBe('/api/tasks/123');
  });

  test('does not append REDACTED when the marker is the trailing segment', () => {
    expect(redactPathSecrets('/api/auth/reset')).toBe('/api/auth/reset');
    expect(redactPathSecrets('/api/auth/reset/')).toBe('/api/auth/reset/');
  });

  test('only redacts the single segment immediately after the marker', () => {
    expect(redactPathSecrets('/api/auth/reset/SECRETTOKEN/extra')).toBe('/api/auth/reset/REDACTED/extra');
  });

  test('does not redact a segment that merely contains the marker as a substring', () => {
    expect(redactPathSecrets('/api/auth/resetish/keepme')).toBe('/api/auth/resetish/keepme');
  });

  test('is tolerant of falsy / non-string input', () => {
    expect(redactPathSecrets('')).toBe('');
    expect(redactPathSecrets(undefined)).toBeUndefined();
    expect(redactPathSecrets(null)).toBeNull();
  });

  test('exports the sensitive path markers', () => {
    expect(SENSITIVE_PATH_MARKERS).toEqual(expect.arrayContaining(['reset', 'verify', 'verify-email']));
  });
});
