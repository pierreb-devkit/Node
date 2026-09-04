/**
 * Unit tests for the Dockerfile ↔ toolchain consistency guarded by #4060.
 *
 * `FROM` cannot read `.nvmrc` at build time, so the Node major is restated
 * as a literal in the Dockerfile instead of derived. These tests are the
 * drift guard: if the Dockerfile's major and `.nvmrc` are ever edited
 * independently, this fails instead of the drift going unnoticed until a
 * Node LTS rollover changes what `FROM node:lts-slim` resolves to.
 *
 * The second test guards the sibling defect from the same issue: `.npmrc`
 * (carrying `engine-strict=true`) must be copied into the build context
 * before `npm ci` runs, or the engines fail-fast never reaches the
 * Docker build.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');

describe('Dockerfile toolchain pin (#4060)', () => {
  test('FROM node:<major>-slim matches the major pinned in .nvmrc', () => {
    const nvmrcMajor = readFileSync(path.join(rootDir, '.nvmrc'), 'utf8')
      .trim()
      .replace(/^v/, '')
      .split('.')[0];

    const match = dockerfile.match(/^FROM node:(\d+)(?:\.\d+)*-slim/m);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(nvmrcMajor);
  });

  test('.npmrc is copied into the build context before npm ci runs', () => {
    const copyIndex = dockerfile.search(/^COPY[^\n]*\.npmrc[^\n]*$/m);
    const npmCiIndex = dockerfile.search(/^RUN[^\n]*npm ci/m);

    expect(copyIndex).toBeGreaterThan(-1);
    expect(npmCiIndex).toBeGreaterThan(-1);
    expect(copyIndex).toBeLessThan(npmCiIndex);
  });
});
