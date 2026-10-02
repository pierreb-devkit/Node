/**
 * `getBrand()` fallback/override resolution, plus the `render()` integration
 * that merges the resolved brand into every template's params (#4130).
 *
 * `files.js` is mocked here (unlike mailer.templates.unit.tests.js) so a
 * render test can feed a synthetic template that references `{{brand.*}}`
 * fields no shared template uses yet — needed to prove handlebars escapes
 * them like any other value.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mutable mock config — tests reassign `mockConfig.mailer.brand` /
// `mockConfig.app` / `mockConfig.cors` to cover fallback vs. override shapes
// without re-mocking the module.
const mockConfig = {
  app: { title: 'Acme', contact: 'help@example.com' },
  cors: { origin: ['https://acme.test'] },
  mailer: { templates: {}, brand: {} },
};

jest.unstable_mockModule('../../../../config/index.js', () => ({
  default: mockConfig,
}));

const DEFAULT_TEMPLATE_CONTENT = '{{appName}} / {{brand.name}} / {{brand.signature}}';
const mockReadFile = jest.fn(() => Promise.resolve(DEFAULT_TEMPLATE_CONTENT));
jest.unstable_mockModule('../../files.js', () => ({
  default: {
    readFile: mockReadFile,
  },
}));

const { default: getBrand } = await import('../brand.js');
const { default: mailer } = await import('../index.js');

describe('mailer brand unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.app = { title: 'Acme', contact: 'help@example.com' };
    mockConfig.cors = { origin: ['https://acme.test'] };
    mockConfig.mailer = { templates: {}, brand: {} };
  });

  test('falls back to app.title/app.contact/getBaseUrl with an empty brand', () => {
    expect(getBrand()).toEqual({
      name: 'Acme',
      url: 'https://acme.test',
      contact: 'help@example.com',
      logoUrl: undefined,
      primaryColor: undefined,
      textColor: undefined,
      mutedColor: undefined,
      fontFamily: undefined,
      signature: undefined,
      footerText: undefined,
      links: {},
    });
  });

  test('a downstream-shaped brand override wins field-by-field', () => {
    mockConfig.mailer.brand = {
      name: 'Rocket',
      url: 'https://rocket.example',
      contact: 'support@rocket.example',
      logoUrl: 'https://rocket.example/logo.png',
      primaryColor: '#112233',
      textColor: '#ffffff',
      mutedColor: '#999999',
      fontFamily: 'Helvetica, sans-serif',
      signature: 'The Rocket Team',
      footerText: 'Rocket Inc.',
      links: { Pricing: 'https://rocket.example/pricing' },
    };

    expect(getBrand()).toEqual(mockConfig.mailer.brand);
  });

  test('a partial brand override keeps the other fields on their fallback', () => {
    mockConfig.mailer.brand = { primaryColor: '#112233' };

    const brand = getBrand();
    expect(brand.primaryColor).toBe('#112233');
    expect(brand.name).toBe('Acme');
    expect(brand.contact).toBe('help@example.com');
    expect(brand.url).toBe('https://acme.test');
    expect(brand.textColor).toBeUndefined();
  });

  test('an explicit empty string overrides the fallback instead of being treated as unset', () => {
    mockConfig.mailer.brand = { name: '', url: '', contact: '' };

    expect(getBrand()).toEqual(
      expect.objectContaining({ name: '', url: '', contact: '' }),
    );
  });

  test('render() lets brand win over a caller-passed appName and HTML-escapes brand values', async () => {
    mockConfig.mailer.brand = { name: '<b>Rocket</b>', signature: 'Bye & thanks' };

    const html = await mailer.render('welcome', { appName: 'Caller-Supplied' });

    expect(html).toContain('&lt;b&gt;Rocket&lt;/b&gt;');
    expect(html).toContain('Bye &amp; thanks');
    expect(html).not.toContain('Caller-Supplied');
    expect(html).not.toContain('<b>Rocket</b>');
  });
});
