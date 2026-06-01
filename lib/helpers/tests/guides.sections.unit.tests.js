/**
 * Unit tests for mergeGuidesIntoSpec — sections option.
 *
 * Covers flat (backward-compat) mode and sectioned mode where guides
 * are grouped under H1 dividers (each guide rendered as H2) using
 * filename numeric prefix ranges.
 */
import GuidesHelper from '../guides.js';

const { mergeGuidesIntoSpec } = GuidesHelper;

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
});
