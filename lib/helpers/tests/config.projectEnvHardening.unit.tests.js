/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Unit tests for the config loader under a downstream project env.
 *
 * Downstream apps run as NODE_ENV={projectName}. `isProd()` is true there, so the
 * secure cookie and the trusted proxy hop from `production.config.js` must apply even
 * though that file is only loaded for NODE_ENV=production. Rate limits are not taken
 * from it: they keep the development values unless the project config sets them.
 *
 * `config/index.js` is a top-level-await singleton already loaded under `test`, so
 * each case loads it in a fresh Node process with its own env.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MARK = '__CONFIG_JSON__';

/**
 * @desc Load config/index.js in a child process and return the picked keys.
 * @param {string} nodeEnv - NODE_ENV for the child
 * @param {Object<string,string>} [extraEnv] - extra env vars
 * @returns {{trust: object, cookie: object, rateLimit: object}} picked config
 */
const loadConfig = (nodeEnv, extraEnv = {}) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DEVKIT_NODE_') && k !== 'NODE_OPTIONS'));
  Object.assign(env, {
    NODE_ENV: nodeEnv,
    DEVKIT_NODE_jwt_secret: 'unit-test-strong-secret-0123456789abcdef',
    DEVKIT_NODE_domain: 'https://example.com',
    ...extraEnv,
  });
  const script = `const { default: c } = await import('./config/index.js');
process.stdout.write('${MARK}' + JSON.stringify({ trust: c.trust, cookie: c.cookie, rateLimit: c.rateLimit }) + '\\n');
process.exit(0);`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith(MARK));
  if (!line) throw new Error(`config load failed (status ${res.status}): ${res.stderr}`);
  return JSON.parse(line.slice(MARK.length));
};

describe('config loader — production hardening under a project env:', () => {
  test('NODE_ENV=myproject gets a secure cookie and one trusted proxy hop, rate limits unchanged', () => {
    const c = loadConfig('myproject');
    expect(c.cookie.secure).toBe(true);
    expect(c.cookie.sameSite).toBe('strict');
    expect(c.trust.proxy).toBe(1);
    expect(c.rateLimit.auth.max).toBe(200);
    expect(c.rateLimit.api.max).toBe(1000);
  });

  test('a DEVKIT_NODE_* env var still overrides the hardened default', () => {
    const c = loadConfig('myproject', { DEVKIT_NODE_cookie_secure: 'false' });
    expect(c.cookie.secure).toBe(false);
  });

  test('NODE_ENV=development keeps the development defaults', () => {
    const c = loadConfig('development');
    expect(c.cookie.secure).toBe(false);
    expect(c.trust.proxy).toBe(false);
    expect(c.rateLimit.auth.max).toBe(200);
    expect(c.rateLimit.api.max).toBe(1000);
  });
});
