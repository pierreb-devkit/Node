/**
 * Baseline render coverage for all shared `config/templates/*.html` files.
 *
 * `files.js` is left unmocked so `mailer.render()` reads the real templates
 * (and the real `_layout/*.html` partials/layout they render through,
 * post-#4133) from disk. Only `config/index.js` is mocked, matching the
 * rest of this suite. The snapshot below is the current baseline — a body
 * fragment wrapped in the default layout, not the pre-#4133 full-document
 * output, so it no longer carries each template's old `<title>` text or
 * its old hardcoded sign-off ("The Acme Team."/"Support Team.", gone with
 * no `brand.signature` configured) — see the brand-colors test further
 * down for the config-driven replacements (signature, logo, link).
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// Mutable mock config (like mailer.brand.unit.tests.js /
// mailer.layout.unit.tests.js): the brand-colors-and-logo test below
// reassigns `mockConfig.mailer.brand` per test without re-mocking the
// module.
const mockConfig = {
  // app.title/app.contact match every fixture's appName/appContact below —
  // render() injects brand.name/brand.contact (falling back to these) as
  // the legacy appName/appContact keys, so the baseline stays unchanged
  // with no mailer.brand configured (#4130).
  app: { title: 'Acme', contact: 'help@example.com' },
  // Resolves `brand.url` (via getBaseUrl()) to a real link for the
  // baseline — every template is now a body fragment wrapped in the
  // default footer, which renders a `brand.url` link when it's truthy.
  cors: { origin: ['https://acme.test'] },
  mailer: { templates: {}, brand: {} },
};

jest.unstable_mockModule('../../../../config/index.js', () => ({
  default: mockConfig,
}));

const { default: mailer } = await import('../index.js');

const TEMPLATES_DIR = path.resolve('config/templates');

// One fixture per shared template, covering every `{{variable}}` that
// template references (see extractVariables below, asserted per test).
const FIXTURES = {
  'billing-credit-exhausted': {
    appContact: 'help@example.com',
    appName: 'Acme',
    billingUrl: 'https://acme.test/billing',
  },
  'billing-credit-warning': {
    appContact: 'help@example.com',
    appName: 'Acme',
    billingUrl: 'https://acme.test/billing',
    remaining: '12',
  },
  'billing-payment-failed': {
    appContact: 'help@example.com',
    appName: 'Acme',
    billingPortalUrl: 'https://acme.test/portal',
  },
  'billing-quota-reached-100': {
    appContact: 'help@example.com',
    appName: 'Acme',
    billingUrl: 'https://acme.test/billing',
    meterQuota: '1000',
    meterUsed: '1000',
  },
  'billing-quota-warning-80': {
    appContact: 'help@example.com',
    appName: 'Acme',
    billingUrl: 'https://acme.test/billing',
    meterQuota: '1000',
    meterUsed: '800',
    threshold: '80',
  },
  'org-member-added': {
    appName: 'Acme',
    displayName: 'Alice',
    orgName: 'Acme Org',
    url: 'https://acme.test/org',
  },
  'org-request-approved': {
    appName: 'Acme',
    displayName: 'Alice',
    orgName: 'Acme Org',
  },
  'org-request-new': {
    appName: 'Acme',
    orgName: 'Acme Org',
    requesterEmail: 'bob@example.com',
    requesterName: 'Bob',
    url: 'https://acme.test/request',
  },
  'org-request-rejected': {
    appName: 'Acme',
    displayName: 'Alice',
    orgName: 'Acme Org',
  },
  'referral-reward-earned': {
    appName: 'Acme',
    displayName: 'Alice',
    units: '5',
  },
  'reset-password-confirm-email': {
    appContact: 'help@example.com',
    appName: 'Acme',
    displayName: 'Alice',
  },
  'reset-password-email': {
    appContact: 'help@example.com',
    appName: 'Acme',
    displayName: 'Alice',
    url: 'https://acme.test/reset',
  },
  'signup-invite': {
    appContact: 'help@example.com',
    appName: 'Acme',
    url: 'https://acme.test/invite',
  },
  'verify-email': {
    appContact: 'help@example.com',
    appName: 'Acme',
    displayName: 'Alice',
    url: 'https://acme.test/verify',
  },
  welcome: {
    appContact: 'help@example.com',
    appName: 'Acme',
    displayName: 'Alice',
    orgName: 'Acme Org',
    url: 'https://acme.test/dashboard',
  },
};

/**
 * @desc Extract every plain variable a handlebars source references,
 *   including the subject of a `{{#if x}}` / `{{#unless x}}` block and a
 *   bare-identifier hash arg on a partial call (e.g. `{{> button url=url
 *   label="Go"}}` yields `url` — `label` is a quoted string literal, not
 *   a variable, so it's skipped; needed since #4133's CTA templates
 *   reference `url` only inside `{{> button}}`, never as a bare `{{url}}`
 *   any more). Skips closers (`{{/if}}`) and `{{else}}` — this corpus has
 *   no `{{#each}}` or triple-stash `{{{x}}}` yet.
 * @param {string} source - Raw handlebars template text
 * @returns {Set<string>} Variable names referenced by the template
 */
const extractVariables = (source) => {
  const tokens = source.match(/{{[^}]*}}/g) || [];
  const vars = new Set();
  for (const raw of tokens) {
    const inner = raw.slice(2, -2).trim();
    if (inner === 'else' || inner.startsWith('/') || inner.startsWith('!')) continue;
    if (inner.startsWith('>')) {
      const parts = inner.slice(1).trim().match(/[^\s"]+="[^"]*"|\S+/g) || [];
      for (const part of parts.slice(1)) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const value = part.slice(eq + 1);
        if (!value.startsWith('"')) vars.add(value);
      }
      continue;
    }
    if (inner.startsWith('#')) {
      const subject = inner.slice(1).trim().split(/\s+/)[1];
      if (subject) vars.add(subject);
      continue;
    }
    vars.add(inner);
  }
  return vars;
};

/**
 * @desc Normalize rendered HTML for snapshot comparison: drop the
 *   `<style>` block entirely (its CSS text is shared layout markup, not
 *   per-template copy, and `<style>` is a raw-text element whose content
 *   would otherwise survive a plain tag strip), strip the remaining tags,
 *   collapse whitespace. Insensitive to markup changes, sensitive to copy.
 * @param {string} html
 * @returns {string} Normalized text
 */
const normalize = (html) => html
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const TEMPLATE_KEYS = Object.keys(FIXTURES);

describe('mailer baseline render — all shared templates:', () => {
  beforeEach(() => {
    mockConfig.mailer.brand = {};
  });

  // Subset, not equality: this stack test file ships byte-identical to every
  // downstream via update-stack, and a downstream legitimately has flat
  // templates of its own in config/templates/ (the fallback finds them —
  // epic #4127's backward-compat section). Equality would fail on a
  // consumer's own template and force an edit to a shared test file, the
  // #4020/#4135 failure this project already fixed once.
  test('every shared template fixture has a matching file on disk', () => {
    const files = fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith('.html'))
      .map((f) => f.replace(/\.html$/, ''));
    expect(files).toEqual(expect.arrayContaining(TEMPLATE_KEYS));
  });

  test.each(TEMPLATE_KEYS)('renders %s with every referenced variable present in its fixture', async (key) => {
    const source = fs.readFileSync(path.join(TEMPLATES_DIR, `${key}.html`), 'utf8');
    const variables = extractVariables(source);
    const fixture = FIXTURES[key];
    for (const variable of variables) {
      expect(fixture).toHaveProperty(variable);
    }

    const html = await mailer.render(key, fixture);
    expect(normalize(html)).toMatchSnapshot();
  });
});

// #4133: every shared template is now a body fragment wrapped in the
// default layout, so a configured brand (colors + logo) must reach every
// one of them via the shared header/footer/button partials — not just the
// 6 that carry a `{{> button}}` CTA. `brand.logoUrl` is rendered by the
// header partial on every mail; `brand.primaryColor` colors the footer's
// contact link on every mail (present here on all 15 since the fixture
// brand sets `contact`) and, additionally, the button background on the
// 6 CTA mails.
describe('mailer brand coverage — brand colors and logo reach every shared template (#4133):', () => {
  const BRAND = {
    name: 'Acme',
    contact: 'help@example.com',
    logoUrl: 'https://acme.test/logo.png',
    primaryColor: '#112233',
  };

  beforeEach(() => {
    mockConfig.mailer.brand = BRAND;
  });

  test.each(TEMPLATE_KEYS)('%s renders brand.logoUrl and brand.primaryColor from config.mailer.brand', async (key) => {
    const html = await mailer.render(key, FIXTURES[key]);

    expect(html).toContain(BRAND.logoUrl);
    expect(html).toContain(BRAND.primaryColor);
  });
});
