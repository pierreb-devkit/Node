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
 *
 * Both checks are stage-aware: the Dockerfile is split on every top-level
 * `FROM` into per-stage blocks, and each check walks every stage instead of
 * only the first. A single-occurrence check would miss a multi-stage build
 * where an earlier stage (e.g. a build stage) is correct but a later one
 * (e.g. the runtime stage that actually ships) drifts.
 *
 * Scope, decided deliberately for #4060's review:
 *  - A `FROM` whose image is not `node:...` (a distroless/scratch runtime,
 *    or `FROM <previous-stage-name>`) has no Node major to check, so it's
 *    skipped by the major-pin test — but if that stage runs `npm ci`, it's
 *    still held to the .npmrc-before-npm-ci rule.
 *  - The .npmrc check is stage-local only: it does not trace whether a
 *    stage that `FROM`s a previous *named* stage inherits an already-copied
 *    `.npmrc` from that parent. Resolving that means walking the FROM
 *    graph, which is a Dockerfile parser, not a drift guard for one file.
 *    A stage that runs `npm ci` is expected to COPY `.npmrc` itself; widen
 *    this if that inheritance pattern shows up for real.
 *  - A digest-pinned image (`node:24-slim@sha256:...`) is accepted the
 *    same as its tag-only form for the major check.
 *  - Stage boundaries are detected separately from image-token parsing: any
 *    line starting with `FROM` opens a new stage, but if its shape can't be
 *    parsed (e.g. a `--platform=...` flag, which this guard doesn't
 *    support) the test throws instead of silently merging it into the
 *    previous stage — a strict-regex-as-splitter would make an
 *    unrecognized `FROM` vanish rather than fail, which is the same class
 *    of blind spot #4060's review flagged in the first place.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');

/**
 * Splits the Dockerfile into per-stage blocks. A new stage starts at every
 * top-level `FROM` line; each block runs from its `FROM` up to (but not
 * including) the next `FROM`, or end of file for the last stage.
 *
 * Boundary detection (which lines start a stage) is intentionally separate
 * from image-token extraction (what the stage's image is): matching both
 * in one strict regex would make a `FROM` line the regex doesn't recognize
 * silently disappear into the previous stage's block instead of failing —
 * exactly the kind of miss this guard exists to prevent. So any line that
 * starts with `FROM` opens a stage; if its shape can't then be parsed, the
 * test throws rather than guessing.
 */
function getStages(text) {
  const fromLineRe = /^FROM\b[^\n]*$/gim;
  const imageRe = /^FROM[ \t]+(\S+)(?:[ \t]+AS[ \t]+\S+)?[ \t]*$/i;

  const froms = [];
  let match;
  while ((match = fromLineRe.exec(text)) !== null) {
    const line = match[0];
    const imageMatch = line.match(imageRe);
    if (!imageMatch) {
      throw new Error(
        `Dockerfile has a FROM line the stage-splitter can't parse (e.g. a --platform flag ` +
          `isn't supported) — extend getStages() in dockerfileToolchain.unit.tests.js or ` +
          `simplify the line: "${line}"`,
      );
    }
    froms.push({ index: match.index, image: imageMatch[1] });
  }

  return froms.map((from, i) => ({
    image: from.image,
    block: text.slice(from.index, i + 1 < froms.length ? froms[i + 1].index : text.length),
  }));
}

describe('Dockerfile toolchain pin (#4060)', () => {
  test('every FROM node:<major>-slim stage matches the major pinned in .nvmrc', () => {
    const nvmrcMajor = readFileSync(path.join(rootDir, '.nvmrc'), 'utf8')
      .trim()
      .replace(/^v/, '')
      .split('.')[0];

    const stages = getStages(dockerfile);
    const nodeStages = stages.filter((stage) => /^node:/.test(stage.image));
    expect(nodeStages.length).toBeGreaterThan(0);

    for (const stage of nodeStages) {
      const majorMatch = stage.image.match(/^node:(\d+)(?:\.\d+)*-slim(?:@sha256:[0-9a-f]{64})?$/);
      if (!majorMatch) {
        throw new Error(
          `FROM ${stage.image} is a node image but not a pinned "node:<major>-slim" form ` +
            `(.nvmrc pins major ${nvmrcMajor}) — a floating tag like "node:lts-slim" defeats the pin`,
        );
      }
      expect(majorMatch[1]).toBe(nvmrcMajor);
    }
  });

  test('.npmrc is copied before npm ci runs, in every stage that runs npm ci', () => {
    const npmCiRe = /^RUN[^\n]*npm ci/m;
    const npmrcCopyRe = /^COPY[^\n]*\.npmrc[^\n]*$/m;

    const stages = getStages(dockerfile);
    const npmCiStages = stages.filter((stage) => npmCiRe.test(stage.block));
    expect(npmCiStages.length).toBeGreaterThan(0);

    for (const stage of npmCiStages) {
      const npmCiIndex = stage.block.search(npmCiRe);
      const copyIndex = stage.block.search(npmrcCopyRe);
      if (copyIndex === -1 || copyIndex > npmCiIndex) {
        throw new Error(
          `Stage "FROM ${stage.image}" runs npm ci without copying .npmrc first in that same ` +
            'stage (engine-strict from .npmrc must be in place before npm ci runs)',
        );
      }
    }
  });
});
