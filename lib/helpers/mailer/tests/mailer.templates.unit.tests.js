/**
 * Baseline render coverage for all shared `config/templates/*.html` files.
 *
 * `files.js` is left unmocked so `mailer.render()` reads the real templates
 * from disk — this is the "today's behavior" baseline that a future
 * fragments-on-layout conversion (#4133) diffs against via the snapshot
 * below. Only `config/index.js` is mocked, matching the rest of this suite.
 */
import { jest, describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

jest.unstable_mockModule('../../../../config/index.js', () => ({
  default: {
    mailer: { templates: {} },
  },
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
 *   including the subject of a `{{#if x}}` / `{{#unless x}}` block.
 *   Skips closers (`{{/if}}`), `{{else}}` and partials (`{{> x}}`) — this
 *   corpus has no `{{#each}}` or triple-stash `{{{x}}}` yet.
 * @param {string} source - Raw handlebars template text
 * @returns {Set<string>} Variable names referenced by the template
 */
const extractVariables = (source) => {
  const tokens = source.match(/{{[^}]*}}/g) || [];
  const vars = new Set();
  for (const raw of tokens) {
    const inner = raw.slice(2, -2).trim();
    if (inner === 'else' || inner.startsWith('/') || inner.startsWith('!') || inner.startsWith('>')) continue;
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
 * @desc Normalize rendered HTML for snapshot comparison: strip tags,
 *   collapse whitespace. Insensitive to markup changes, sensitive to copy —
 *   #4133 (body-fragment conversion) diffs its output against this.
 * @param {string} html
 * @returns {string} Normalized text
 */
const normalize = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const TEMPLATE_KEYS = Object.keys(FIXTURES);

describe('mailer baseline render — all shared templates:', () => {
  test('every config/templates/*.html file has exactly one fixture (none left unexercised)', () => {
    const files = fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith('.html'))
      .map((f) => f.replace(/\.html$/, ''))
      .sort();
    expect([...TEMPLATE_KEYS].sort()).toEqual(files);
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
