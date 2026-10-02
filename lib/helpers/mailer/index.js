import path from 'path';
import handlebars from 'handlebars';

import config from '../../../config/index.js';
import files from '../files.js';
import NodemailerProvider from './provider.nodemailer.js';
import ResendProvider from './provider.resend.js';

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

// Containment boundary for resolved template paths — matches the project
// root used by the previous hardcoded `./config/templates/<name>.html` read.
const PROJECT_ROOT = process.cwd();

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

  if (path.isAbsolute(relativePath) || path.extname(relativePath) !== '.html') {
    throw new Error(`mailer.templates["${key}"] must be a relative path ending in .html`);
  }

  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const relativeToRoot = path.relative(PROJECT_ROOT, absolutePath);
  const escapesRoot =
    relativeToRoot === '' ||
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot);
  if (escapesRoot) {
    throw new Error(`mailer.templates["${key}"] must resolve inside the project root`);
  }

  return absolutePath;
};

/**
 * @desc Render a mail template to HTML. Resolution order: a
 *   `config.mailer.templates` map hit, then the flat `config/templates/`
 *   fallback.
 * @param {string} key - Template key (sanitized via path.basename to
 *   prevent path traversal)
 * @param {Object} params - Template parameters
 * @param {Object} [options]
 * @param {string} [options.subject] - Reserved for the brand/layout levels
 *   (#4130, #4132); not used by this resolver.
 * @returns {Promise<string>} The rendered HTML
 * @throws {Error} If the resolved template path is invalid (see resolveTemplatePath)
 */
// eslint-disable-next-line no-unused-vars -- subject threads through for the brand/layout levels (#4130, #4132); not consumed by this resolver
const render = async (key, params, { subject } = {}) => {
  const sanitizedKey = path.basename(key);
  const templatePath = resolveTemplatePath(sanitizedKey);
  const file = await files.readFile(templatePath);
  const template = handlebars.compile(file);
  return template(params);
};

/**
 * @desc Send an email using a handlebars template
 * @param {Object} mail - Mail configuration
 * @param {string} mail.to - Recipient email
 * @param {string} mail.subject - Email subject
 * @param {string} mail.template - Template name (without .html)
 * @param {Object} mail.params - Template parameters
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
    from: config.mailer.from,
    to: mail.to,
    subject: mail.subject,
    html,
    attachments: mail.attachments,
  });
  if (!Array.isArray(result?.accepted)) return { ...result, accepted: [mail.to], rejected: [] };
  return result;
};

export default { sendMail, isConfigured, render };
