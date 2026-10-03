/**
 * Unit tests for `getApiBaseUrl()` — the API's own origin + base path
 * (`config.api.*`), as opposed to `getBaseUrl()` (the frontend origin,
 * `config.cors.origin`). Epic-audit follow-up on #4160/#4127: a link built
 * from the wrong one 404s whenever the frontend and the API are served from
 * different hosts.
 */
import { jest, describe, test, expect } from '@jest/globals';

const mockConfig = {
  api: { protocol: 'http', host: '127.0.0.1', port: 3000, base: 'api' },
};

jest.unstable_mockModule('../../../config/index.js', () => ({
  default: mockConfig,
}));

const { default: getApiBaseUrl } = await import('../getApiBaseUrl.js');

describe('getApiBaseUrl', () => {
  test('builds protocol://host:port/base when a port is configured', () => {
    mockConfig.api = { protocol: 'http', host: '127.0.0.1', port: 3000, base: 'api' };
    expect(getApiBaseUrl()).toBe('http://127.0.0.1:3000/api');
  });

  test('omits the port entirely when config.api.port is falsy (e.g. a reverse proxy on 80/443)', () => {
    mockConfig.api = { protocol: 'https', host: 'api.acme.test', port: 0, base: 'api' };
    expect(getApiBaseUrl()).toBe('https://api.acme.test/api');
  });

  test('is independent of config.cors.origin — proven by resolving to a different host than the frontend origin would', () => {
    mockConfig.api = { protocol: 'http', host: '127.0.0.1', port: 3000, base: 'api' };
    mockConfig.cors = { origin: ['http://localhost:8080'] };
    const result = getApiBaseUrl();
    expect(result).toBe('http://127.0.0.1:3000/api');
    expect(new URL(result).host).not.toBe(new URL(mockConfig.cors.origin[0]).host);
  });

  test('matches the exact string the OAuth strategies built inline before the extraction (behavior-identical)', () => {
    mockConfig.api = { protocol: 'http', host: '127.0.0.1', port: 3000, base: 'api' };
    const legacyInline = `${mockConfig.api.protocol}://${mockConfig.api.host}${mockConfig.api.port ? ':' : ''}${mockConfig.api.port ? mockConfig.api.port : ''}/${mockConfig.api.base}`;
    expect(getApiBaseUrl()).toBe(legacyInline);
  });
});
