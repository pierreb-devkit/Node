/**
 * `resolveContainedPath` (#4132 CodeRabbit finding): a symlink planted
 * inside the project root but pointing outside it must still be rejected —
 * the syntactic check alone (`path.relative` on the unresolved path) can't
 * see that. Uses the real filesystem (no mocks): a temp directory outside
 * the project root stands in for "outside", a real symlink under
 * `config/templates/` (cleaned up in afterEach) stands in for the escape
 * attempt.
 */
import { describe, test, expect, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveContainedPath } from '../paths.js';

const PROJECT_ROOT = process.cwd();
const SYMLINK_RELATIVE_PATH = 'config/templates/__test-symlink-escape__.html';
const SYMLINK_ABSOLUTE_PATH = path.resolve(PROJECT_ROOT, SYMLINK_RELATIVE_PATH);

describe('resolveContainedPath — symlink containment:', () => {
  afterEach(() => {
    fs.rmSync(SYMLINK_ABSOLUTE_PATH, { force: true });
  });

  test('rejects a symlink inside the root whose target resolves outside it', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-paths-test-'));
    const outsideFile = path.join(outsideDir, 'secret.html');
    fs.writeFileSync(outsideFile, 'outside');
    fs.symlinkSync(outsideFile, SYMLINK_ABSOLUTE_PATH);

    expect(() => resolveContainedPath(SYMLINK_RELATIVE_PATH, 'mailer.layout')).toThrow(/mailer\.layout.*inside the project root/);
  });

  test('a symlink inside the root whose target also resolves inside it still resolves (canonicalized)', () => {
    const insideTarget = path.resolve(PROJECT_ROOT, 'config/templates/welcome.html');
    fs.symlinkSync(insideTarget, SYMLINK_ABSOLUTE_PATH);

    expect(resolveContainedPath(SYMLINK_RELATIVE_PATH, 'mailer.layout')).toBe(fs.realpathSync(insideTarget));
  });

  test('a path that does not exist yet is unaffected (nothing to canonicalize)', () => {
    expect(resolveContainedPath('config/templates/__does-not-exist__.html', 'mailer.layout')).toBe(
      path.resolve(PROJECT_ROOT, 'config/templates/__does-not-exist__.html'),
    );
  });
});
