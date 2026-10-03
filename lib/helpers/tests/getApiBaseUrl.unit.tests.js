/**
 * Unit tests for `getApiBaseUrl()` — the API's own PUBLIC origin + base
 * path, as opposed to `getBaseUrl()` (the frontend origin,
 * `config.cors.origin`). Epic-audit follow-up on #4160/#4127.
 *
 * `config.domain` (the stack's one documented public domain — see
 * `lib/helpers/config.js`'s `validateDomainIsSet` and
 * `lib/services/express.js#computeOpenApiServerUrl`) is the primary source;
 * `config.api.{protocol,host,port}` — the server's own BIND settings, e.g.
 * `0.0.0.0:3010` behind a reverse proxy — are a fallback used ONLY when
 * `config.domain` is empty, never the primary source (a real downstream can
 * bind `0.0.0.0` while its public origin is `https://api.acme.com`).
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockConfig = {
  domain: '',
  api: { protocol: 'http', host: '127.0.0.1', port: 3000, base: 'api' },
};

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: mockConfig,
}));

const { default: getApiBaseUrl } = await import('../getApiBaseUrl.js');

describe('getApiBaseUrl', () => {
  beforeEach(() => {
    mockConfig.domain = '';
    mockConfig.api = { protocol: 'http', host: '127.0.0.1', port: 3000, base: 'api' };
  });

  describe('config.domain set — used instead of config.api.* (fixes the bind-settings bug)', () => {
    test('a bare domain (no scheme) gets the https://api. subdomain convention prepended, mirroring computeOpenApiServerUrl', () => {
      mockConfig.domain = 'acme.com';
      expect(getApiBaseUrl()).toBe('https://api.acme.com/api');
    });

    test('a domain that already carries a scheme is used verbatim (no https://api. prepended)', () => {
      mockConfig.domain = 'https://api.acme.com';
      expect(getApiBaseUrl()).toBe('https://api.acme.com/api');
    });

    test('an http (non-https) domain with an explicit scheme is also used verbatim', () => {
      mockConfig.domain = 'http://api.acme.test';
      expect(getApiBaseUrl()).toBe('http://api.acme.test/api');
    });

    test('a trailing slash on config.domain is trimmed before the base path is appended (no double slash)', () => {
      mockConfig.domain = 'https://api.acme.com/';
      expect(getApiBaseUrl()).toBe('https://api.acme.com/api');
    });

    test('config.domain wins even when config.api.* is also set to unrelated bind settings (0.0.0.0, a non-public host)', () => {
      mockConfig.domain = 'acme.com';
      mockConfig.api = { protocol: 'http', host: '0.0.0.0', port: 3010, base: 'api' };
      const result = getApiBaseUrl();
      expect(result).toBe('https://api.acme.com/api');
      expect(result).not.toContain('0.0.0.0');
    });
  });

  describe('config.domain empty — falls back to the config.api.* composition', () => {
    test('builds protocol://host:port/base when a port is configured', () => {
      mockConfig.domain = '';
      mockConfig.api = { protocol: 'http', host: '127.0.0.1', port: 3000, base: 'api' };
      expect(getApiBaseUrl()).toBe('http://127.0.0.1:3000/api');
    });

    test('omits the port entirely when config.api.port is falsy (e.g. a reverse proxy on 80/443)', () => {
      mockConfig.domain = '';
      mockConfig.api = { protocol: 'https', host: 'api.acme.test', port: 0, base: 'api' };
      expect(getApiBaseUrl()).toBe('https://api.acme.test/api');
    });
  });
});
