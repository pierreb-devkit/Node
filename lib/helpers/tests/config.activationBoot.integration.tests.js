/**
 * Module dependencies.
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import configHelper from '../config.js';
import config from '../../../config/index.js';

/**
 * Boot test for module activation.
 *
 * A module outside `CORE_MODULES` whose merged config declares an `activated`
 * key promises it can be switched off with `activated: false`. A module that never
 * declares it is never switched off by `filterByActivation` either, so it is
 * always on and out of this test. Reading the filter alone cannot prove that: an always-on
 * module importing a switched-off one crashes the boot. So each optional module
 * is switched off in a fresh Node process that runs the real `bootstrap()`
 * (models, migrations, Express) against its own database, then drops it.
 *
 * The module list is read from `modules/`, so a new module is covered as soon
 * as it declares `activated` in its config.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MARK = '__BOOT_OK__';

const optionalModules = fs
  .readdirSync(path.join(ROOT, 'modules'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !configHelper.CORE_MODULES.has(entry.name) && Object.hasOwn(config[entry.name] ?? {}, 'activated'))
  .map((entry) => entry.name)
  .sort();

/**
 * @desc Boot the app in a child process with one module switched off.
 * @param {string} moduleName - module to switch off
 * @returns {{ok: boolean, output: string, enabled: unknown}} boot result
 */
const bootWithModuleOff = (moduleName) => {
  // Keep DEVKIT_NODE_db_uri (the test database); drop what belongs to this jest process only.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !['NODE_OPTIONS', 'DEVKIT_MIGRATIONS_RAN', 'JEST_WORKER_ID'].includes(k) && !k.endsWith('_activated')),
  );
  env.NODE_ENV = 'test';
  env[`DEVKIT_NODE_${moduleName}_activated`] = 'false';
  const script = `const app = await import('./lib/app.js');
const { default: config } = await import('./config/index.js');
const { default: mongoose } = await import('mongoose');
await app.bootstrap();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.stdout.write('${MARK}' + JSON.stringify({ enabled: config[${JSON.stringify(moduleName)}]?.enabled ?? null }) + '\\n');
process.exit(0);`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith(MARK));
  return { ok: res.status === 0 && Boolean(line), output, enabled: line ? JSON.parse(line.slice(MARK.length)).enabled : undefined };
};

describe('module activation — every optional module can be switched off:', () => {
  test('there is at least one optional module to check', () => {
    expect(optionalModules.length).toBeGreaterThan(0);
  });

  test.each(optionalModules)('the app boots with %s activated:false, and reports it disabled', (moduleName) => {
    const { ok, output, enabled } = bootWithModuleOff(moduleName);
    if (!ok) throw new Error(`boot failed with ${moduleName} off:\n${output.slice(-4000)}`);
    // syncEnabledWithActivation: a module that is off is never reported on
    expect(enabled).toBe(false);
  }, 150000);
});
