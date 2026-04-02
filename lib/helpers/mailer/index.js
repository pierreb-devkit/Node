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
    console.error(`Mail send error: ${err.message}`);
    return null;
  }
};

export default { sendMail, isConfigured };
