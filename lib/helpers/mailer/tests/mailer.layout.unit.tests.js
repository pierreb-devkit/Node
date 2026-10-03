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
    // `clearAllMocks()` resets call history but NOT a custom `mockImplementation` —
    // restore the default path-aware behavior explicitly so a test that swaps it in
    // (e.g. to simulate an unreadable _layout directory) can't leak into the next test.
    mockReadFile.mockImplementation((filePath) => Promise.resolve(templateFixturesByPath[filePath] ?? ''));
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

  test('a legacy full document is sent unwrapped, byte-identical, and the layout/partials are never read (epic-audit follow-up on #4160/#4127)', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '<!doctype html><html><body>Hi {{name}}</body></html>';

    const html = await mailer.render('welcome', { name: 'Alice' }, { subject: 'ignored' });

    expect(html).toBe('<!doctype html><html><body>Hi Alice</body></html>');
    expect(mockReadFile).not.toHaveBeenCalledWith(LAYOUT_PATH);
    expect(mockReadFile).not.toHaveBeenCalledWith(PARTIAL_PATH.header);
    expect(mockReadFile).not.toHaveBeenCalledWith(PARTIAL_PATH.footer);
    expect(mockReadFile).not.toHaveBeenCalledWith(PARTIAL_PATH.button);
    expect(mockReadFile).not.toHaveBeenCalledWith(PARTIAL_PATH.styles);
    // Only the template itself was read.
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  test('a legacy full document renders fine even when the entire _layout directory is unreadable (proves it never depends on it)', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '<!doctype html><html><body>Hi {{name}}</body></html>';
    const unreadable = new Set(Object.values(PARTIAL_PATH).concat(LAYOUT_PATH));
    mockReadFile.mockImplementation((filePath) => (unreadable.has(filePath) ? Promise.reject(new Error('ENOENT: partials directory missing')) : Promise.resolve(templateFixturesByPath[filePath] ?? '')));

    const html = await mailer.render('welcome', { name: 'Alice' }, { subject: 'ignored' });

    expect(html).toBe('<!doctype html><html><body>Hi Alice</body></html>');
  });

  test('{{> button}} is available to a body fragment', async () => {
    templateFixturesByPath[TEMPLATE_PATH] = '{{> button url="https://acme.test" label="Go"}}';

    const html = await mailer.render('welcome', {});

    expect(html).toContain('<a href="https://acme.test">Go</a>');
  });

  test('{{> partial}} inside a legacy full document now throws — partials are reserved for fragment templates, resolved on a pristine handlebars instance so a legacy document can never inherit a registration left over from a prior render', async () => {
    const customFragmentPath = path.resolve('config/templates/other-fragment.html');
    templateFixturesByPath[customFragmentPath] = '{{> button url="https://acme.test" label="Go"}}';
    mockConfig.mailer.templates = { 'other-fragment': 'config/templates/other-fragment.html' };
    // Prime the isolated `hbs` singleton with the `button` partial via an
    // unrelated fragment render first — if the legacy path below reused
    // that singleton instead of a pristine instance, the assertion would
    // pass by render-order accident instead of by design.
    await mailer.render('other-fragment', {});

    templateFixturesByPath[TEMPLATE_PATH] = '<!doctype html><html><body>{{> button url="https://acme.test" label="Go"}}</body></html>';

    await expect(mailer.render('welcome', {})).rejects.toThrow();
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

  describe('layout context link allow-list (epic-audit follow-up on #4160/#4127):', () => {
    test('emailSettingsUrl and unsubscribeUrl from params reach the layout/partials context', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = 'BODY';
      templateFixturesByPath[LAYOUT_PATH] = '{{{body}}}{{#if emailSettingsUrl}}<a href="{{emailSettingsUrl}}">settings</a>{{/if}}{{#if unsubscribeUrl}}<a href="{{unsubscribeUrl}}">unsub</a>{{/if}}';

      const html = await mailer.render('welcome', { emailSettingsUrl: 'https://acme.test/users/profile', unsubscribeUrl: 'https://api.acme.test/api/users/unsubscribe/tok' });

      expect(html).toContain('<a href="https://acme.test/users/profile">settings</a>');
      expect(html).toContain('<a href="https://api.acme.test/api/users/unsubscribe/tok">unsub</a>');
    });

    test('the default footer partial renders an Email settings link only when emailSettingsUrl is present', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = 'BODY';
      templateFixturesByPath[LAYOUT_PATH] = '{{{body}}}{{> footer}}';
      templateFixturesByPath[PARTIAL_PATH.footer] = '{{#if emailSettingsUrl}}<a href="{{emailSettingsUrl}}">Email settings</a>{{/if}}';

      const withLink = await mailer.render('welcome', { emailSettingsUrl: 'https://acme.test/users/profile' });
      expect(withLink).toContain('<a href="https://acme.test/users/profile">Email settings</a>');

      const withoutLink = await mailer.render('welcome', {});
      expect(withoutLink).not.toContain('Email settings');
    });

    test('a non-allow-listed param does NOT reach the layout context, even though it reaches the body template', async () => {
      templateFixturesByPath[TEMPLATE_PATH] = '{{secret}}';
      templateFixturesByPath[LAYOUT_PATH] = '{{{body}}}|layout-secret:{{secret}}|';

      const html = await mailer.render('welcome', { secret: 'topsecret' });

      // The body template itself still sees every param (unchanged behavior) ...
      expect(html).toContain('topsecret');
      // ... but the layout's OWN context does not — only the allow-listed
      // link params (plus body/brand/subject) are passed to it.
      expect(html).toContain('|layout-secret:|');
    });
  });
});
