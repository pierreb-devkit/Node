/**
 * Unit tests for mergeGuidesIntoSpec — sections option — and prefixFromPath.
 *
 * Covers flat (backward-compat) mode and sectioned mode where guides
 * are grouped under H1 dividers (each guide rendered as H2) using
 * filename numeric prefix ranges. Also covers prefixFromPath edge cases
 * (exported helper, must handle all separator / no-prefix variants).
 */
import GuidesHelper from '../guides.js';

const { mergeGuidesIntoSpec, prefixFromPath } = GuidesHelper;

describe('mergeGuidesIntoSpec — sections option:', () => {
  const makeGuide = (filePath, body = 'guide body') => ({
    title: filePath.replace(/.*\//, '').replace(/\.md$/, '').replace(/^\d+[-_]/, '').replace(/[-_]/g, ' '),
    body,
    path: filePath,
  });

  const loginGuide = makeGuide('/docs/01-login.md', 'Login content');
  const signupGuide = makeGuide('/docs/02-signup.md', 'Signup content');
  const subscribeGuide = makeGuide('/docs/10-subscribe.md', 'Subscribe content');

  const baseSpec = () => ({ info: { description: 'overview' } });

  test('without sections option: guides flatten into info.description as H1 entries', () => {
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide, signupGuide]);
    expect(out.info.description).toContain('login');
    expect(out.info.description).toContain('signup');
    // Flat mode → H1 headings, no section grouping
    expect(out.info.description).not.toMatch(/^# auth$/m);
    expect(out.info.description).not.toMatch(/^# billing$/m);
    // Flat mode → each guide is a top-level H1
    expect(out.info.description).toMatch(/^# /m);
  });

  test('without sections option: existing description is preserved', () => {
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide]);
    expect(out.info.description).toContain('overview');
  });

  test('with sections array: guides nest under H1 section dividers as H2', () => {
    const sections = [
      { title: 'auth', prefixMin: 1, prefixMax: 9 },
      { title: 'billing', prefixMin: 10, prefixMax: 19 },
    ];
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide, signupGuide, subscribeGuide], { sections });
    // H1 section headers present
    expect(out.info.description).toMatch(/^# auth$/m);
    expect(out.info.description).toMatch(/^# billing$/m);
    // Guides appear as H2 under their section
    expect(out.info.description).toMatch(/^## /m);
    // login and signup under auth (prefixes 1,2 → prefixMin:1 prefixMax:9)
    expect(out.info.description).toContain('Login content');
    expect(out.info.description).toContain('Signup content');
    // subscribe under billing (prefix 10 → prefixMin:10 prefixMax:19)
    expect(out.info.description).toContain('Subscribe content');
  });

  test('with sections: auth H1 appears before billing H1', () => {
    const sections = [
      { title: 'auth', prefixMin: 1, prefixMax: 9 },
      { title: 'billing', prefixMin: 10, prefixMax: 19 },
    ];
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide, signupGuide, subscribeGuide], { sections });
    const authIdx = out.info.description.indexOf('# auth');
    const billingIdx = out.info.description.indexOf('# billing');
    expect(authIdx).toBeLessThan(billingIdx);
  });

  test('with sections: guides without matching prefix range become orphan H2 entries (never silently dropped)', () => {
    const sections = [{ title: 'auth', prefixMin: 1, prefixMax: 9 }];
    // subscribeGuide has prefix 10, outside the only section range
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide, subscribeGuide], { sections });
    // The orphan is still present (not dropped)
    expect(out.info.description).toContain('Subscribe content');
  });

  test('with sections: sections with no matched guides are omitted from output', () => {
    const sections = [
      { title: 'auth', prefixMin: 1, prefixMax: 9 },
      { title: 'billing', prefixMin: 10, prefixMax: 19 },
    ];
    // Only auth-range guides
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide, signupGuide], { sections });
    expect(out.info.description).toMatch(/^# auth$/m);
    // billing section has no guides → should NOT appear
    expect(out.info.description).not.toMatch(/^# billing$/m);
  });

  test('returns spec unchanged when guides array is empty', () => {
    const spec = baseSpec();
    const out = mergeGuidesIntoSpec(spec, []);
    expect(out.info.description).toBe('overview');
  });

  test('returns spec unchanged when spec is falsy', () => {
    expect(mergeGuidesIntoSpec(null, [loginGuide])).toBeNull();
    expect(mergeGuidesIntoSpec(undefined, [loginGuide])).toBeUndefined();
  });

  test('null options does not throw — falls back to flat mode', () => {
    // Passing null explicitly as third arg must not throw (null-safe options guard)
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide], null);
    expect(out.info.description).toContain('Login content');
    expect(out.info.description).toMatch(/^# /m);
  });

  test('with sections: orphan appears after section markdown (appended at end, not before)', () => {
    const sections = [{ title: 'auth', prefixMin: 1, prefixMax: 9 }];
    // subscribeGuide (prefix 10) is an orphan — should appear after the auth section
    const out = mergeGuidesIntoSpec(baseSpec(), [loginGuide, subscribeGuide], { sections });
    const authIdx = out.info.description.indexOf('# auth');
    const orphanIdx = out.info.description.indexOf('Subscribe content');
    expect(authIdx).toBeGreaterThan(-1);
    expect(orphanIdx).toBeGreaterThan(authIdx);
  });
});

describe('prefixFromPath:', () => {
  test('extracts numeric prefix with dash separator', () => {
    expect(prefixFromPath('/foo/07-scheduling.md')).toBe(7);
    expect(prefixFromPath('/foo/14-cli.md')).toBe(14);
    expect(prefixFromPath('/foo/01-getting-started.md')).toBe(1);
  });

  test('extracts numeric prefix with underscore separator', () => {
    expect(prefixFromPath('/foo/03_intro.md')).toBe(3);
    expect(prefixFromPath('/foo/20_advanced.md')).toBe(20);
  });

  test('returns null when no numeric prefix present', () => {
    expect(prefixFromPath('/foo/welcome.md')).toBeNull();
    expect(prefixFromPath('/foo/getting-started.md')).toBeNull();
  });

  test('returns null for pure-digit basename (no separator after digits)', () => {
    // "42.md" has no dash or underscore after digits — not a prefix pattern
    expect(prefixFromPath('/foo/42.md')).toBeNull();
  });

  test('handles octal-looking prefix correctly (parseInt radix 10)', () => {
    // "08-" would be invalid octal — must parse as decimal 8
    expect(prefixFromPath('/foo/08-webhooks.md')).toBe(8);
    expect(prefixFromPath('/foo/09-billing.md')).toBe(9);
  });

  test('handles empty-ish inputs without throwing', () => {
    expect(prefixFromPath('')).toBeNull();
    expect(prefixFromPath('/foo/.md')).toBeNull();
  });
});
