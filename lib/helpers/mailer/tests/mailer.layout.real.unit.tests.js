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
      // A downstream's own full document (#4133: none of the 15 shared
      // Devkit templates are full documents any more, so the legacy
      // passthrough path needs its own fixture to stay exercised against
      // real, unmocked files).
      'legacy-full-document': 'lib/helpers/mailer/tests/fixtures/legacy-full-document.html',
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

    // The `{{#each brand.links}}` loop changes context to each link's own
    // value — `../brand.primaryColor` must still reach the parent's brand,
    // proving the depth-1 lookup inside the each/if nesting actually works.
    expect(html).toContain('<a href="https://acme.test/pricing" style="color: #112233;">Pricing</a>');
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

  test('the real footer renders an Email settings link when params.emailSettingsUrl is present (epic-audit follow-up on #4160/#4127)', async () => {
    const html = await mailer.render(
      'layout-smoke-fragment',
      { name: 'Alice', url: 'https://acme.test/dashboard', emailSettingsUrl: 'https://acme.test/users/profile' },
      { subject: 'Welcome aboard' },
    );

    expect(html).toContain('<a href="https://acme.test/users/profile" style="color: #112233;">Email settings</a>');
  });

  test('the real footer renders no Email settings link when params.emailSettingsUrl is absent', async () => {
    const html = await mailer.render(
      'layout-smoke-fragment',
      { name: 'Alice', url: 'https://acme.test/dashboard' },
      { subject: 'Welcome aboard' },
    );

    expect(html).not.toContain('Email settings');
  });

  test('a quoted, multi-word brand.fontFamily is only ever emitted inside an HTML attribute, never inside <style>', async () => {
    // `<style>` is a raw-text element: handlebars' HTML-escaped `'` -> `&#x27;`
    // is NOT decoded there, so a quoted font name would render broken CSS
    // text. An attribute value IS entity-decoded by the HTML parser, so the
    // same escaped output is safe (and correct) there.
    mockConfig.mailer.brand = { ...FULL_BRAND, fontFamily: "'Segoe UI', Arial, sans-serif" };

    const html = await mailer.render(
      'layout-smoke-fragment',
      { name: 'Alice', url: 'https://acme.test/dashboard' },
      { subject: 'Welcome aboard' },
    );

    expect(html).toContain('style="font-family: &#x27;Segoe UI&#x27;, Arial, sans-serif; color: #1a1a1a;"');

    const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)[0];
    expect(styleBlock).not.toContain('Segoe');
    expect(styleBlock).not.toContain('&#x27;');
    expect(styleBlock).not.toContain('#112233'); // brand.primaryColor — also left <style> entirely
  });

  test('a real full-document fixture (a downstream template) stays on the legacy passthrough path, byte-identical, with no layout/brand applied (#4133)', async () => {
    const html = await mailer.render('legacy-full-document', { name: 'Alice' });

    expect(html).toBe(`<!doctype html>
<html lang="en">
  <head>
    <title>Legacy document</title>
  </head>
  <body>
    <p>Hi Alice, this is a full document a downstream project ships on its own, outside the shared layout.</p>
  </body>
</html>
`);
    // None of the brand/layout machinery leaked in: no header/footer
    // partials, no brand.logoUrl, no Email settings/Questions? links.
    expect(html).not.toContain(FULL_BRAND.logoUrl);
    expect(html).not.toContain('Questions?');
  });
});
