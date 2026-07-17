import { jest, describe, test, expect } from '@jest/globals';
import redactUrl, { SENSITIVE_QUERY_KEYS, SENSITIVE_PATH_MARKERS, redactPathSecrets } from '../redactUrl.js';
import developmentConfig from '../../../config/defaults/development.config.js';

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

  test('redacts an OAuth callback code and state, preserving the path', () => {
    expect(redactUrl('/api/auth/google/callback?code=SECRET&state=xyz')).toBe('/api/auth/google/callback?code=REDACTED&state=REDACTED');
  });

  test('redacts an OAuth callback code among other query params, leaving the rest intact', () => {
    expect(redactUrl('/api/auth/google/callback?state=xyz&scope=email&code=SECRET')).toBe('/api/auth/google/callback?state=REDACTED&scope=email&code=REDACTED');
  });

  test('exports code and state as sensitive keys', () => {
    expect(SENSITIVE_QUERY_KEYS).toContain('code');
    expect(SENSITIVE_QUERY_KEYS).toContain('state');
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

/**
 * `SENSITIVE_QUERY_KEYS` / `SENSITIVE_PATH_MARKERS` are read from
 * `config.log.*` once, at module-evaluation time (#3953), and UNIONED with
 * the built-in `DEFAULT_SENSITIVE_*` lists — config is extension-only, it can
 * never shrink or clobber the built-ins (deepMerge replaces arrays wholesale,
 * so a naive fallback would let a module-level config array silently clobber
 * the global default instead of extending it; union sidesteps that entirely).
 * These tests mock `config/index.js` and re-import the module fresh (via
 * `jest.resetModules()` + dynamic `import()` — see
 * `posthog-context.middleware.unit.tests.js` for the same pattern) to
 * exercise the union, the empty-array no-op, and the absent-config fallback,
 * without disturbing the static-import tests above (which exercise the real
 * config's current defaults, unchanged).
 */
describe('redactUrl config sourcing (#3953)', () => {
  /**
   * Load a fresh instance of the module under a given mocked config.
   * @param {Object|undefined} mockConfig - the value `config/index.js` default-exports
   * @returns {Promise<Object>} the freshly-loaded module exports
   */
  const loadWithConfig = async (mockConfig) => {
    jest.resetModules();
    jest.unstable_mockModule('../../../config/index.js', () => ({ default: mockConfig }));
    return import('../redactUrl.js');
  };

  test('unions a module-extended path marker from config with the built-in defaults', async () => {
    const mod = await loadWithConfig({
      log: { sensitivePathMarkers: ['unsubscribe'] },
    });
    expect(mod.SENSITIVE_PATH_MARKERS).toEqual(expect.arrayContaining(['reset', 'verify', 'verify-email', 'unsubscribe']));
    // built-in marker still redacts — extension never clobbers it
    expect(mod.redactPathSecrets('/api/auth/reset/SECRETTOKEN')).toBe('/api/auth/reset/REDACTED');
    // config-added marker redacts too
    expect(mod.redactPathSecrets('/api/newsletter/unsubscribe/SECRETTOKEN')).toBe('/api/newsletter/unsubscribe/REDACTED');
  });

  test('unions a module-extended query key from config with the built-in defaults', async () => {
    const mod = await loadWithConfig({
      log: { sensitiveQueryKeys: ['magicToken'] },
    });
    expect(mod.SENSITIVE_QUERY_KEYS).toEqual(expect.arrayContaining(['inviteToken', 'magicToken']));
    // built-in key still redacts — extension never clobbers it
    expect(mod.default('/x?inviteToken=secret')).toBe('/x?inviteToken=REDACTED');
    // config-added key redacts too
    expect(mod.default('/x?magicToken=secret')).toBe('/x?magicToken=REDACTED');
  });

  test('an explicit empty array in config is a no-op — built-in defaults still apply', async () => {
    const mod = await loadWithConfig({
      log: { sensitivePathMarkers: [], sensitiveQueryKeys: [] },
    });
    expect(mod.SENSITIVE_PATH_MARKERS).toEqual(['reset', 'verify', 'verify-email']);
    expect(mod.SENSITIVE_QUERY_KEYS).toEqual(['inviteToken', 'code', 'state']);
    expect(mod.redactPathSecrets('/api/auth/reset/SECRETTOKEN')).toBe('/api/auth/reset/REDACTED');
    expect(mod.default('/x?inviteToken=secret')).toBe('/x?inviteToken=REDACTED');
  });

  test('falls back to the built-in defaults when config.log is missing', async () => {
    const mod = await loadWithConfig({});
    expect(mod.SENSITIVE_PATH_MARKERS).toEqual(['reset', 'verify', 'verify-email']);
    expect(mod.SENSITIVE_QUERY_KEYS).toEqual(['inviteToken', 'code', 'state']);
    expect(mod.redactPathSecrets('/api/auth/reset/SECRETTOKEN')).toBe('/api/auth/reset/REDACTED');
    expect(mod.default('/x?inviteToken=secret')).toBe('/x?inviteToken=REDACTED');
  });

  test('falls back to the built-in defaults when config itself is undefined', async () => {
    const mod = await loadWithConfig(undefined);
    expect(mod.SENSITIVE_PATH_MARKERS).toEqual(['reset', 'verify', 'verify-email']);
    expect(mod.SENSITIVE_QUERY_KEYS).toEqual(['inviteToken', 'code', 'state']);
  });

  /**
   * A shape mismatch on the config value (e.g. a typo'd object instead of an
   * array) must degrade the same way an absent/empty value does — never throw
   * at module-eval time (`[...{}]` is not iterable, which would crash the
   * whole app on boot) and never silently spread a string char-by-char
   * (`[...'oops']` → `['o','o','p','s']`, which would over-redact app-wide).
   */
  test('an object value for sensitivePathMarkers is ignored — defaults still apply, no throw, warns', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mod = await loadWithConfig({
        log: { sensitivePathMarkers: { notAnArray: true } },
      });
      expect(mod.SENSITIVE_PATH_MARKERS).toEqual(['reset', 'verify', 'verify-email']);
      expect(mod.redactPathSecrets('/api/auth/reset/SECRETTOKEN')).toBe('/api/auth/reset/REDACTED');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('log.sensitivePathMarkers'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a string value for sensitiveQueryKeys is ignored (not spread char-by-char) — defaults still apply, no throw, warns', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mod = await loadWithConfig({
        log: { sensitiveQueryKeys: 'oops' },
      });
      expect(mod.SENSITIVE_QUERY_KEYS).toEqual(['inviteToken', 'code', 'state']);
      expect(mod.default('/x?inviteToken=secret')).toBe('/x?inviteToken=REDACTED');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('log.sensitiveQueryKeys'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * Lockstep guard (#3953): `config/defaults/development.config.js` must never
 * declare `log.sensitivePathMarkers` / `log.sensitiveQueryKeys` again, not
 * even as `[]`. `deepMerge` (config/index.js) replaces arrays wholesale
 * instead of merging them, so a Layer-2 (global defaults) value — including
 * an explicit empty array — would silently clobber a Layer-1 (module config)
 * extension of the same key. Omitting the key entirely is what lets a
 * module's value pass through untouched to `lib/helpers/redactUrl.js`. This
 * test pins that fix against regression.
 */
describe('development.config.js lockstep guard (#3953)', () => {
  test('does not declare log.sensitivePathMarkers', () => {
    expect(Object.prototype.hasOwnProperty.call(developmentConfig.log, 'sensitivePathMarkers')).toBe(false);
  });

  test('does not declare log.sensitiveQueryKeys', () => {
    expect(Object.prototype.hasOwnProperty.call(developmentConfig.log, 'sensitiveQueryKeys')).toBe(false);
  });
});
