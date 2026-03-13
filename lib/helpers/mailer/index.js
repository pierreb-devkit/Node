import path from 'path';
import handlebars from 'handlebars';

import config from '../../../config/index.js';
import files from '../files.js';
import NodemailerProvider from './provider.nodemailer.js';

const providers = { nodemailer: NodemailerProvider };

/**
 * @desc Create a mail provider instance based on config
 * @returns {Object} A mail provider with a send method
 */
const createProvider = () => {
  const providerName = config.mailer?.provider || 'nodemailer';
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
 * @returns {Promise<Object|null>} The send result or null if not configured
 */
const sendMail = async (mail) => {
  if (!isConfigured()) return null;
  const file = await files.readFile(path.resolve(`./config/templates/${mail.template}.html`));
  const template = handlebars.compile(file);
  const html = template(mail.params);
  try {
    return await getProvider().send({
      from: config.mailer.from,
      to: mail.to,
      subject: mail.subject,
      html,
    });
  } catch (err) {
    console.error(`Mail send error: ${err.message}`);
    return null;
  }
};

export default { sendMail, isConfigured };
