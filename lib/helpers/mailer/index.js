import path from 'path';
import handlebars from 'handlebars';

import config from '../../../config/index.js';
import files from '../files.js';
import NodemailerProvider from './provider.nodemailer.js';
import ResendProvider from './provider.resend.js';
import getBrand from './brand.js';
import { resolveContainedPath } from './paths.js';
import { PARTIAL_NAMES, isLegacyFullDocument, resolveLayoutPath, resolvePartialPath } from './layout.js';

const providers = { nodemailer: NodemailerProvider, resend: ResendProvider };

/**
 * @desc Create a mail provider instance based on config
 * @returns {Object} A mail provider with a send method
 */
const createProvider = () => {
  const raw = config.mailer?.provider;
  const providerName = raw && !String(raw).startsWith('DEVKIT_NODE_') ? raw : 'nodemailer';
  const Provider = providers[providerName];
  if (!Provider) throw new Error(`Unknown mail provider: ${providerName}`);
  return new Provider(config.mailer.options);
};

let provider;

/**
 * @desc Get or create the singleton mail provider
 * @returns {Object} The mail provider instance
 */
const getProvider = () => {
  if (!provider) provider = createProvider();
  return provider;
};

/**
 * @desc Check whether mailer is properly configured
 * @returns {boolean} True if mailer config has a valid from address
 */
const isConfigured = () => !!(config.mailer && config.mailer.from && !String(config.mailer.from).startsWith('DEVKIT_NODE_'));

/**
 * @desc Resolve the `from` address for a send: a per-send `mail.from`
 *   override wins, but only when it's a real value — falsy or the stack's
 *   unreplaced `DEVKIT_NODE_` placeholder (same guard as `isConfigured()`
 *   and `createProvider()`) falls back to `config.mailer.from`.
 * @param {string} [from] - Per-send `from` override
 * @returns {string} The resolved from address
 */
const resolveFrom = (from) => (from && !String(from).startsWith('DEVKIT_NODE_') ? from : config.mailer.from);

/**
 * @desc Validate attachment list before sending.
 * Throws if any attachment is malformed or exceeds the 25 MB size limit.
 * @param {Array} [attachments] - Optional array of attachment objects
 * @throws {Error} If any attachment is invalid
 */
const validateAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return;
  const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
  for (const att of attachments) {
    if (!att.filename || typeof att.filename !== 'string') {
      throw new Error('Attachment filename must be a non-empty string');
    }
    if (!att.content) {
      throw new Error('Attachment content is required');
    }
    const size = typeof att.content === 'string'
      ? Buffer.byteLength(att.content)
      : att.content.length;
    if (size > MAX_SIZE) {
      throw new Error(`Attachment "${att.filename}" exceeds 25 MB limit`);
    }
  }
};

/**
 * @desc Resolve a sanitized template key to an absolute, in-root .html path.
 *   A `config.mailer.templates` map entry wins over the flat Devkit folder;
 *   any other key falls back to `config/templates/<key>.html` (today's
 *   behavior), so templates that exist only in a downstream keep working.
 * @param {string} key - Template key, already sanitized via path.basename
 * @returns {string} Absolute path to the template file
 * @throws {Error} If the resolved path is absolute, isn't .html, or escapes
 *   the project root — the error names the key
 */
const resolveTemplatePath = (key) => {
  const templates = config.mailer?.templates || {};
  const relativePath = Object.hasOwn(templates, key) ? templates[key] : `config/templates/${key}.html`;
  return resolveContainedPath(relativePath, `mailer.templates["${key}"]`);
};

// Isolated handlebars environment (epic #4127): partials registered below
// never reach the global `handlebars` module import.
const hbs = handlebars.create();

/**
 * @desc Register every layout partial (header, footer, button, styles) on
 *   the isolated handlebars instance, so `{{> button url=url label="..."}}`
 *   is available to every template — fragment or legacy full document. The
 *   4 reads are independent, so they run in parallel. Re-read and
 *   re-registered on every render, same no-cache behavior as the
 *   template/layout file reads below.
 * @returns {Promise<void>}
 * @throws {Error} If a configured partial path fails containment — the
 *   error names `mailer.partials["<name>"]`
 */
const registerPartials = async () => {
  await Promise.all(
    PARTIAL_NAMES.map(async (name) => {
      const source = await files.readFile(resolvePartialPath(name));
      hbs.registerPartial(name, source);
    }),
  );
};

/**
 * @desc Render a mail template to HTML. Resolution order: a
 *   `config.mailer.templates` map hit, then the flat `config/templates/`
 *   fallback. Every template is rendered with the resolved brand (see
 *   `getBrand()`) merged into its params: the `brand` object itself, plus
 *   the legacy `appName` (= `brand.name`) and `appContact` (= `brand.contact`)
 *   keys. Brand wins over a caller-passed `appName`/`appContact`/`brand` —
 *   those three keys only, every other caller-passed param is untouched. With no
 *   `mailer.brand` config, `brand.name`/`brand.contact` fall back to
 *   `config.app.title`/`config.app.contact` — the same values callers pass
 *   today — so output is unchanged.
 *
 *   A template whose trimmed source starts with `<!doctype` or `<html`
 *   (case-insensitive) is a legacy full document and is returned unwrapped,
 *   byte-identical to before — checked and compiled BEFORE the layout/partials
 *   are ever touched, so a legacy full document never depends on `_layout/*.html`
 *   existing or being readable (epic-audit follow-up on #4160/#4127), and is
 *   compiled on its own pristine `handlebars.create()` instance so it can never
 *   inherit a `{{> partial}}` registration left over from a prior fragment
 *   render in the same process — a legacy document that references a partial
 *   now always throws, deterministically, instead of sometimes resolving
 *   depending on render order. None of the 15 shipped legacy templates
 *   reference a partial today.
 *
 *   Every other template is a body fragment: it is wrapped in `mailer.layout`
 *   (or the Devkit default), which receives `{{{body}}}` (the only unescaped
 *   slot), `brand`, `subject` (fills the layout's `<title>`), and an explicit
 *   allow-list of link params — `emailSettingsUrl`, `unsubscribeUrl` — lifted
 *   from the caller's `params`, never the whole `params` object, so a footer
 *   partial can render one of those links without every template param
 *   leaking into the layout/partials context. Rendering uses an isolated
 *   `handlebars.create()` instance; nothing is registered on the global one.
 * @param {string} key - Template key (sanitized via path.basename to
 *   prevent path traversal)
 * @param {Object} params - Template parameters
 * @param {Object} [options]
 * @param {string} [options.subject] - Used by the layout's `<title>` when
 *   the template is a body fragment; ignored for a legacy full document.
 * @returns {Promise<string>} The rendered HTML
 * @throws {Error} If a resolved template, layout, or partial path is
 *   invalid (see resolveContainedPath)
 */
const render = async (key, params, { subject } = {}) => {
  const sanitizedKey = path.basename(key);
  const templatePath = resolveTemplatePath(sanitizedKey);
  const file = await files.readFile(templatePath);
  const brand = getBrand();
  const brandedParams = { ...params, brand, appName: brand.name, appContact: brand.contact };

  if (isLegacyFullDocument(file)) {
    const legacyTemplate = handlebars.create().compile(file);
    return legacyTemplate(brandedParams);
  }

  await registerPartials();
  const bodyTemplate = hbs.compile(file);
  const body = bodyTemplate(brandedParams);

  const layoutSource = await files.readFile(resolveLayoutPath());
  const layoutTemplate = hbs.compile(layoutSource);
  return layoutTemplate({
    body,
    brand,
    subject,
    emailSettingsUrl: params?.emailSettingsUrl,
    unsubscribeUrl: params?.unsubscribeUrl,
  });
};

/**
 * @desc Send an email using a handlebars template
 * @param {Object} mail - Mail configuration
 * @param {string} mail.to - Recipient email
 * @param {string} mail.subject - Email subject
 * @param {string} mail.template - Template name (without .html)
 * @param {Object} mail.params - Template parameters
 * @param {string} [mail.from] - Sender address override; falls back to
 *   `config.mailer.from` when absent, falsy, or the unreplaced
 *   `DEVKIT_NODE_` placeholder (see `resolveFrom()`).
 * @param {string|string[]} [mail.replyTo] - Reply-to address(es), forwarded
 *   to the provider as-is; absent means today's behavior (no reply-to on
 *   the payload).
 * @param {Object<string,string>} [mail.headers] - Custom headers (e.g.
 *   `List-Unsubscribe`), forwarded to the provider as-is; absent means
 *   today's behavior (no headers on the payload).
 * @param {Array} [mail.attachments] - Optional attachments array
 * @param {string} mail.attachments[].filename - Attachment filename
 * @param {string|Buffer} mail.attachments[].content - Attachment content (string or Buffer)
 * @returns {Promise<Object|null>} The send result, or null if not configured
 * @throws {Error} If the provider's send() call fails — propagated so each
 *   caller's own `.catch()` can log with its flow-specific context
 *   (action, userId, orgId, ...). Callers that must never let a mail failure
 *   break their main flow are responsible for attaching that `.catch()`
 *   themselves; this helper does not swallow errors centrally.
 */
const sendMail = async (mail) => {
  if (!isConfigured()) return null;
  validateAttachments(mail.attachments);
  const html = await render(mail.template, mail.params, { subject: mail.subject });
  const result = await getProvider().send({
    from: resolveFrom(mail.from),
    to: mail.to,
    subject: mail.subject,
    html,
    attachments: mail.attachments,
    replyTo: mail.replyTo,
    headers: mail.headers,
  });
  if (!Array.isArray(result?.accepted)) return { ...result, accepted: [mail.to], rejected: [] };
  return result;
};

export default { sendMail, isConfigured, render, getBrand };
