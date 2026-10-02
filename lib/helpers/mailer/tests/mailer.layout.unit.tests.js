/**
 * Layout + partials (#4132): legacy-document vs. body-fragment resolution,
 * the layout/partials config override + containment, the `{{> button}}`
 * partial reaching every template, escaping/injection rules, and the
 * isolated-handlebars-instance rule the epic (#4127) sets.
 *
 * `files.js` is mocked (like mailer.unit.tests.js), path-aware so a test
 * can prove which file backed a given render() without coupling to the
 * real shipped `_layout/*.html` markup — that's covered separately by
 * mailer.layout.real.unit.tests.js, which leaves `files.js` unmocked.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import path from 'path';
import handlebars from 'handlebars';

const mockConfig = {
  app: { title: 'Acme', contact: 'help@example.com' },
  mailer: { templates: {}, layout: undefined, partials: {}, brand: {} },
};

jest.unstable_mockModule('../../../../config/index.js', () => ({
  default: mockConfig,
}));

const templateFixturesByPath = {};
const mockReadFile = jest.fn((filePath) => Promise.resolve(templateFixturesByPath[filePath] ?? ''));
jest.unstable_mockModule('../../files.js', () => ({
  default: {
    readFile: mockReadFile,
  },
}));

const { default: mailer } = await import('../index.js');

const TEMPLATE_PATH = path.resolve('config/templates/welcome.html');
const LAYOUT_PATH = path.resolve('config/templates/_layout/layout.html');
const PARTIAL_PATH = {
  header: path.resolve('config/templates/_layout/header.html'),
  footer: path.resolve('config/templates/_layout/footer.html'),
  button: path.resolve('config/templates/_layout/button.html'),
  styles: path.resolve('config/templates/_layout/styles.html'),
};

// The devkit default layout/partials, standing in for the real markup —
// just enough to prove the mechanism (wrap, title, partial lookup).
const seedDefaults = () => {
  templateFixturesByPath[LAYOUT_PATH] = '<title>{{subject}}</title>{{{body}}}';
  templateFixturesByPath[PARTIAL_PATH.header] = '';
  templateFixturesByPath[PARTIAL_PATH.footer] = '';
  templateFixturesByPath[PARTIAL_PATH.button] = '<a href="{{url}}">{{label}}</a>';
  templateFixturesByPath[PARTIAL_PATH.styles] = '';
};

describe('mailer layout unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(templateFixturesByPath).forEach((key) => delete templateFixturesByPath[key]);
    mockConfig.mailer = { templates: {}, layout: undefined, partials: {}, brand: {} };
    seedDefaults();
  });

  describe('legacy full-document vs. body-fragment detection:', () => {
    test.each([
      ['<!doctype html><html><body>X</body></html>', true],
      ['  \n\t<!doctype html><html><body>X</body></html>', true], // leading whitespace
      ['<!DOCTYPE HTML><html><body>X</body></html>', true], // uppercase
      ['<HTML><body>X</body></HTML>', true], // bare <html>, no doctype
      ['<p>X</p>', false], // body fragment
      ['{{appName}} X', false], // fragment with no markup at all
    ])('source %j is treated as legacy=%s', async (source, legacy) => {
      templateFixturesByPath[TEMPLATE_PATH] = source;

      const html = await mailer.render('welcome', {}, { subject: 'S' });

      // Legacy -> sent unwrapped (no layout's <title>). Fragment -> wrapped.
      expect(html.includes('<title>S</title>')).toBe(!legacy);
      expect(html).toContain('X');
    });
  });

  test('wraps a body fragment in the layout: subject fills <title>, brand/body reach the layout context', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '<p>Hi {{name}}</p>';

    const html = await mailer.render('welcome', { name: 'Alice' }, { subject: 'Welcome!' });

    expect(html).toBe('<title>Welcome!</title><p>Hi Alice</p>');
  });

  test('escapes subject and params, and injects the body exactly once', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '<p>{{greeting}}</p>';

    const html = await mailer.render('welcome', { greeting: '<script>alert(1)</script>' }, { subject: '<b>Hi</b>' });

    expect(html).toBe('<title>&lt;b&gt;Hi&lt;/b&gt;</title><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toContain('<script>');
    expect((html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) || []).length).toBe(1);
  });

  test('a legacy full document is sent unwrapped, byte-identical, and the layout is never read', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '<!doctype html><html><body>Hi {{name}}</body></html>';

    const html = await mailer.render('welcome', { name: 'Alice' }, { subject: 'ignored' });

    expect(html).toBe('<!doctype html><html><body>Hi Alice</body></html>');
    expect(mockReadFile).not.toHaveBeenCalledWith(LAYOUT_PATH);
  });

  test('{{> button}} is available to a body fragment', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '{{> button url="https://acme.test" label="Go"}}';

    const html = await mailer.render('welcome', {});

    expect(html).toContain('<a href="https://acme.test">Go</a>');
  });

  test('{{> button}} is also available to a legacy full document', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '<!doctype html><html><body>{{> button url="https://acme.test" label="Go"}}</body></html>';

    const html = await mailer.render('welcome', {});

    expect(html).toBe('<!doctype html><html><body><a href="https://acme.test">Go</a></body></html>');
  });

  test('a mailer.partials override wins for that partial; an unset one still falls back to the Devkit default', async () => {
    const customHeaderPath = path.resolve('config/templates/myproject/header.html');
    templateFixturesByPath[customHeaderPath] = '[CUSTOM HEADER]';
    templateFixturesByPath[PARTIAL_PATH.footer] = '[DEFAULT FOOTER]';
    templateFixturesByPath[TEMPLATE_PATH] = 'BODY';
    templateFixturesByPath[LAYOUT_PATH] = '{{> header}}{{{body}}}{{> footer}}';
    mockConfig.mailer.partials = { header: 'config/templates/myproject/header.html' };

    const html = await mailer.render('welcome', {});

    expect(html).toBe('[CUSTOM HEADER]BODY[DEFAULT FOOTER]');
  });

  test('a mailer.layout override replaces the whole layout', async () => {
    const customLayoutPath = path.resolve('config/templates/myproject/layout.html');
    templateFixturesByPath[customLayoutPath] = '[CUSTOM LAYOUT]{{{body}}}';
    templateFixturesByPath[TEMPLATE_PATH] = 'BODY';
    mockConfig.mailer.layout = 'config/templates/myproject/layout.html';

    const html = await mailer.render('welcome', {});

    expect(html).toBe('[CUSTOM LAYOUT]BODY');
  });

  describe('containment:', () => {
    test('rejects an absolute mailer.layout path, naming the key, before reading it', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = '<p>fragment</p>';
      mockConfig.mailer.layout = '/etc/passwd.html';

      await expect(mailer.render('welcome', {})).rejects.toThrow(/mailer\.layout/);
      expect(mockReadFile).not.toHaveBeenCalledWith('/etc/passwd.html');
    });

    test('rejects a mailer.layout path that escapes the project root via ..', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = '<p>fragment</p>';
      mockConfig.mailer.layout = '../../../etc/passwd.html';

      await expect(mailer.render('welcome', {})).rejects.toThrow(/mailer\.layout/);
    });

    test('rejects a mailer.layout path with the wrong extension', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = '<p>fragment</p>';
      mockConfig.mailer.layout = 'config/templates/myproject/layout.txt';

      await expect(mailer.render('welcome', {})).rejects.toThrow(/mailer\.layout/);
    });

    test('rejects an absolute mailer.partials["header"] path, naming the key', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = '<p>fragment</p>';
      mockConfig.mailer.partials = { header: '/etc/passwd.html' };

      await expect(mailer.render('welcome', {})).rejects.toThrow(/mailer\.partials\["header"\]/);
    });

    test('rejects a mailer.partials["footer"] path that escapes the project root', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = '<p>fragment</p>';
      mockConfig.mailer.partials = { footer: '../../../etc/passwd.html' };

      await expect(mailer.render('welcome', {})).rejects.toThrow(/mailer\.partials\["footer"\]/);
    });
  });

  test('nothing is registered on the global handlebars instance', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '{{> button url="https://acme.test" label="Go"}}';

    await mailer.render('welcome', {});

    expect(handlebars.partials.button).toBeUndefined();
    expect(handlebars.partials.header).toBeUndefined();
  });
});
