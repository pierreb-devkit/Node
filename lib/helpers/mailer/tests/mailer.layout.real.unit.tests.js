/**
 * Unmocked smoke test for the real shipped `config/templates/_layout/*.html`
 * files (#4132). `files.js` is left unmocked (like
 * mailer.templates.unit.tests.js) so this reads the ACTUAL Devkit layout
 * and partials from disk, not a synthetic stand-in — proving the shipped
 * defaults compile and render for a body-only fragment with a fully
 * configured brand.
 *
 * The rendered template itself is a throwaway fixture inside this test
 * directory (not under config/templates/, which is Devkit's reserved
 * namespace) mapped in via `mailer.templates`.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const FULL_BRAND = {
  name: 'Acme',
  url: 'https://acme.test',
  contact: 'help@example.com',
  logoUrl: 'https://acme.test/logo.png',
  primaryColor: '#112233',
  textColor: '#1a1a1a',
  mutedColor: '#777777',
  fontFamily: 'Arial, sans-serif',
  signature: 'The Acme Team',
  footerText: 'Acme Inc.',
  links: { Pricing: 'https://acme.test/pricing' },
};

const mockConfig = {
  app: { title: 'Acme', contact: 'help@example.com' },
  mailer: {
    templates: {
      'layout-smoke-fragment': 'lib/helpers/mailer/tests/fixtures/layout-smoke-fragment.html',
    },
    layout: undefined,
    partials: {},
    brand: FULL_BRAND,
  },
};

jest.unstable_mockModule('../../../../config/index.js', () => ({
  default: mockConfig,
}));

const { default: mailer } = await import('../index.js');

describe('mailer layout — real shipped defaults (unmocked files):', () => {
  beforeEach(() => {
    mockConfig.mailer.brand = FULL_BRAND;
  });

  test('renders a body-only fragment through the real _layout/*.html files without throwing', async () => {
    const html = await mailer.render(
      'layout-smoke-fragment',
      { name: 'Alice', url: 'https://acme.test/dashboard' },
      { subject: 'Welcome aboard' },
    );

    expect(html).toContain('<title>Welcome aboard</title>');
    expect(html).toContain('https://acme.test/logo.png');
    expect(html).toContain('The Acme Team');
    expect(html).toContain('Acme Inc.');
    expect(html).toContain('mailto:help@example.com');
    expect(html).toContain('>Pricing<');
    expect(html).toContain('https://acme.test/pricing');
    expect(html).toContain('Hi Alice');
    expect(html).toContain('href="https://acme.test/dashboard"');
    expect(html).toContain('>Go to dashboard</a>');
  });

  test('with an empty mailer.brand ({}), the button still has a visible background and the header falls back to app.title', async () => {
    mockConfig.mailer.brand = {};

    const html = await mailer.render(
      'layout-smoke-fragment',
      { name: 'Alice', url: 'https://acme.test/dashboard' },
      { subject: 'Welcome aboard' },
    );

    // Regression: brand.primaryColor is undefined by default (no fallback
    // in getBrand()) — the button partial must not render
    // `background-color: ;` (dropped by the CSS parser), which paired with
    // the button's hardcoded white text left the CTA invisible.
    expect(html).toContain('background-color: #2563eb');
    expect(html).toContain('>Acme</span>');
    expect(html).not.toContain('<p></p>');
  });
});
