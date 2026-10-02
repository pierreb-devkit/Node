/**
 * Module dependencies.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import path from 'path';

// Mutable mock config — tests reassign `mockConfig.mailer.templates` to
// cover resolution order / containment without re-mocking the module.
const mockConfig = {
  mailer: {
    provider: 'resend',
    from: 'test@example.com',
    options: { apiKey: 're_test_123' },
    templates: {},
  },
};

// Mock config, files, and providers before importing mailer
jest.unstable_mockModule('../../../../config/index.js', () => ({
  default: mockConfig,
}));

// Path-aware readFile: content depends on the resolved path requested, so a
// test can prove resolveTemplatePath() picked the mapped file vs. the flat
// fallback by what got read, not just by a global canned response.
const DEFAULT_TEMPLATE_CONTENT = '<p>{{name}}</p>';
const templateFixturesByPath = {};
const mockReadFile = jest.fn((filePath) => Promise.resolve(templateFixturesByPath[filePath] ?? DEFAULT_TEMPLATE_CONTENT));
jest.unstable_mockModule('../../files.js', () => ({
  default: {
    readFile: mockReadFile,
  },
}));

const mockSend = jest.fn().mockResolvedValue({ id: 'email_123', accepted: ['user@example.com'], rejected: [] });
jest.unstable_mockModule('../provider.resend.js', () => ({
  default: jest.fn().mockImplementation(() => ({ send: mockSend })),
}));

jest.unstable_mockModule('../provider.nodemailer.js', () => ({
  default: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
}));

const { default: mailer } = await import('../index.js');

// None of this file's fixtures are a full HTML document, so every render()
// goes through the layout (#4132). Seed it as a transparent `{{{body}}}`
// passthrough and the 4 partials as empty, so this file's pre-#4132
// assertions (exact `html` values) stay byte-identical — only the layout
// mechanics get a dedicated test file (mailer.layout.unit.tests.js).
const LAYOUT_PATH = path.resolve('config/templates/_layout/layout.html');
const PARTIAL_PATHS = ['header', 'footer', 'button', 'styles'].map((name) => path.resolve(`config/templates/_layout/${name}.html`));
const seedTransparentLayout = () => {
  templateFixturesByPath[LAYOUT_PATH] = '{{{body}}}';
  PARTIAL_PATHS.forEach((partialPath) => {
    templateFixturesByPath[partialPath] = '';
  });
};

describe('mailer index with resend provider unit tests:', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(templateFixturesByPath).forEach((key) => delete templateFixturesByPath[key]);
    mockConfig.mailer.templates = {};
    seedTransparentLayout();
  });

  test('should report as configured when from is set', () => {
    expect(mailer.isConfigured()).toBe(true);
  });

  test('should send mail using the resend provider and normalize response', async () => {
    mockSend.mockResolvedValue({ id: 'email_456' });

    const result = await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Welcome',
      template: 'welcome',
      params: { name: 'Alice' },
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'test@example.com',
        to: 'user@example.com',
        subject: 'Welcome',
        html: '<p>Alice</p>',
      }),
    );
    expect(result).toEqual({ id: 'email_456', accepted: ['user@example.com'], rejected: [] });
  });

  test('should pass through response unchanged when accepted is already an array', async () => {
    mockSend.mockResolvedValue({ id: 'email_789', accepted: ['user@example.com'], rejected: [] });

    const result = await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Welcome',
      template: 'welcome',
      params: { name: 'Charlie' },
    });

    expect(result).toEqual({ id: 'email_789', accepted: ['user@example.com'], rejected: [] });
  });

  test('should forward attachments to the provider', async () => {
    mockSend.mockResolvedValue({ id: 'email_attach', accepted: ['user@example.com'], rejected: [] });

    const attachments = [{ filename: 'report.csv', content: 'a,b\n1,2' }];
    await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Report',
      template: 'welcome',
      params: { name: 'Carol' },
      attachments,
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments,
      }),
    );
  });

  test('should forward replyTo and headers to the provider when provided', async () => {
    mockSend.mockResolvedValue({ id: 'email_overrides', accepted: ['user@example.com'], rejected: [] });

    await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Welcome',
      template: 'welcome',
      params: { name: 'Dana' },
      replyTo: 'support@example.com',
      headers: { 'List-Unsubscribe': '<mailto:unsub@example.com>' },
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: 'support@example.com',
        headers: { 'List-Unsubscribe': '<mailto:unsub@example.com>' },
      }),
    );
  });

  test('should use mail.from when provided, overriding config.mailer.from', async () => {
    mockSend.mockResolvedValue({ id: 'email_from', accepted: ['user@example.com'], rejected: [] });

    await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Welcome',
      template: 'welcome',
      params: { name: 'Eve' },
      from: 'override@example.com',
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'override@example.com' }),
    );
  });

  test('should fall back to config.mailer.from when mail.from is absent', async () => {
    mockSend.mockResolvedValue({ id: 'email_default_from', accepted: ['user@example.com'], rejected: [] });

    await mailer.sendMail({
      to: 'user@example.com',
      subject: 'Welcome',
      template: 'welcome',
      params: { name: 'Frank' },
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'test@example.com' }),
    );
  });

  test('should propagate (reject) when the provider send fails, instead of swallowing to null', async () => {
    mockSend.mockRejectedValue(new Error('API failure'));

    await expect(
      mailer.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        template: 'welcome',
        params: { name: 'Bob' },
      }),
    ).rejects.toThrow('API failure');
  });

  test('should let a provider rejection reach a caller-attached .catch() with its own context', async () => {
    mockSend.mockRejectedValue(new Error('API failure'));
    const callerLogger = { warn: jest.fn() };

    // Mirrors the call-site pattern used across the codebase: fire-and-forget
    // sendMail() with a local .catch() that logs flow-specific context.
    await mailer
      .sendMail({
        to: 'user@example.com',
        subject: 'Test',
        template: 'welcome',
        params: { name: 'Bob' },
      })
      .catch((err) => callerLogger.warn('caller: mail failed', { message: err?.message, userId: 'u1' }));

    expect(callerLogger.warn).toHaveBeenCalledWith('caller: mail failed', { message: 'API failure', userId: 'u1' });
  });

  test('should throw when attachment is missing content', async () => {
    await expect(
      mailer.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        template: 'welcome',
        params: { name: 'Bob' },
        attachments: [{ filename: 'file.txt' }],
      }),
    ).rejects.toThrow('Attachment content is required');
  });

  test('should throw when attachment exceeds 25 MB', async () => {
    const largeContent = Buffer.alloc(26 * 1024 * 1024); // 26 MB
    await expect(
      mailer.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        template: 'welcome',
        params: { name: 'Bob' },
        attachments: [{ filename: 'large.bin', content: largeContent }],
      }),
    ).rejects.toThrow('exceeds 25 MB limit');
  });

  test('should throw when attachment filename is an empty string', async () => {
    await expect(
      mailer.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        template: 'welcome',
        params: { name: 'Bob' },
        attachments: [{ filename: '', content: 'data' }],
      }),
    ).rejects.toThrow('Attachment filename must be a non-empty string');
  });

  test('should throw when attachment filename is not a string', async () => {
    await expect(
      mailer.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        template: 'welcome',
        params: { name: 'Bob' },
        attachments: [{ filename: 123, content: 'data' }],
      }),
    ).rejects.toThrow('Attachment filename must be a non-empty string');
  });

  test('should not throw for a valid attachment', async () => {
    mockSend.mockResolvedValue({ id: 'ok', accepted: ['user@example.com'], rejected: [] });
    await expect(
      mailer.sendMail({
        to: 'user@example.com',
        subject: 'Test',
        template: 'welcome',
        params: { name: 'Bob' },
        attachments: [{ filename: 'doc.pdf', content: 'PDF content here' }],
      }),
    ).resolves.not.toThrow();
  });

  describe('render() template resolution order:', () => {
    test('falls back to config/templates/<key>.html when the key is not in the map', async () => {
      await mailer.render('welcome', { name: 'A' });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/welcome.html'));
    });

    test('a map entry wins over the flat file', async () => {
      mockConfig.mailer.templates = { welcome: 'config/templates/myproject/welcome.html' };
      await mailer.render('welcome', { name: 'A' });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/myproject/welcome.html'));
    });

    test('a key not in the map still resolves from the flat folder', async () => {
      mockConfig.mailer.templates = { welcome: 'config/templates/myproject/welcome.html' };
      await mailer.render('verify-email', { name: 'A' });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/verify-email.html'));
    });

    test('a map hit renders the mapped file content (not the flat file, proven by path-aware readFile)', async () => {
      mockConfig.mailer.templates = { welcome: 'config/templates/myproject/welcome.html' };
      templateFixturesByPath[path.resolve('config/templates/myproject/welcome.html')] = '<h1>{{name}}</h1>';
      templateFixturesByPath[path.resolve('config/templates/welcome.html')] = '<p>SHOULD NOT BE READ {{name}}</p>';

      const html = await mailer.render('welcome', { name: 'Zoe' });

      expect(html).toBe('<h1>Zoe</h1>');
    });

    test('sanitizes the key through path.basename before any lookup (traversal attempt, no map)', async () => {
      await mailer.render('../../../etc/passwd', { name: 'A' });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/passwd.html'));
    });

    test('a traversal attempt in the caller key still gets basenamed away before the map lookup', async () => {
      mockConfig.mailer.templates = { passwd: 'config/templates/myproject/passwd.html' };
      await mailer.render('../../../etc/passwd', { name: 'A' });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/myproject/passwd.html'));
    });

    test('ignores inherited/prototype keys in the templates map (no own property)', async () => {
      mockConfig.mailer.templates = {};
      await mailer.render('constructor', { name: 'A' });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/constructor.html'));
    });

    test('treats an undefined mailer.templates as an empty map', async () => {
      mockConfig.mailer.templates = undefined;
      await mailer.render('welcome', { name: 'A' });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/welcome.html'));
    });

    test('sendMail still calls through render and callers are unchanged', async () => {
      mockConfig.mailer.templates = { welcome: 'config/templates/myproject/welcome.html' };
      await mailer.sendMail({
        to: 'user@example.com',
        subject: 'Welcome',
        template: 'welcome',
        params: { name: 'Dana' },
      });
      expect(mockReadFile).toHaveBeenCalledWith(path.resolve('config/templates/myproject/welcome.html'));
    });
  });

  describe('render() containment:', () => {
    test('rejects an absolute mapped path, naming the key', async () => {
      mockConfig.mailer.templates = { welcome: '/etc/passwd.html' };
      await expect(mailer.render('welcome', {})).rejects.toThrow(/welcome/);
    });

    test('rejects a mapped path that escapes the project root via ..', async () => {
      mockConfig.mailer.templates = { welcome: '../../../etc/passwd.html' };
      await expect(mailer.render('welcome', {})).rejects.toThrow(/welcome/);
    });

    test('rejects a mapped path with the wrong extension', async () => {
      mockConfig.mailer.templates = { welcome: 'config/templates/myproject/welcome.txt' };
      await expect(mailer.render('welcome', {})).rejects.toThrow(/welcome/);
    });

    test('does not read any file once containment rejects the path', async () => {
      mockConfig.mailer.templates = { welcome: '/etc/passwd.html' };
      await expect(mailer.render('welcome', {})).rejects.toThrow();
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });
});
