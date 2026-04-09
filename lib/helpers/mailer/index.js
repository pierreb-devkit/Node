import path from 'path';
import handlebars from 'handlebars';

import config from '../../../config/index.js';
import logger from '../../services/logger.js';
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
 * @returns {Promise<Object|null>} The send result or null if not configured
 */
const sendMail = async (mail) => {
  if (!isConfigured()) return null;
  validateAttachments(mail.attachments);
  // Sanitize template name to prevent path traversal
  const sanitizedTemplate = path.basename(mail.template);
  const file = await files.readFile(path.resolve(`./config/templates/${sanitizedTemplate}.html`));
  const template = handlebars.compile(file);
  const html = template(mail.params);
  try {
    const result = await getProvider().send({
      from: config.mailer.from,
      to: mail.to,
      subject: mail.subject,
      html,
      attachments: mail.attachments,
    });
    if (!Array.isArray(result?.accepted)) return { ...result, accepted: [mail.to], rejected: [] };
    return result;
  } catch (err) {
    logger.error(`Mail send error: ${err.message}`);
    return null;
  }
};

export default { sendMail, isConfigured };
