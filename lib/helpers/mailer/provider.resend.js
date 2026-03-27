import { Resend } from 'resend';

export default class ResendProvider {
  /**
   * @param {Object} options - Resend provider options
   * @param {string} options.apiKey - Resend API key
   */
  constructor(options) {
    if (!options?.apiKey) throw new Error('Resend provider requires an apiKey');
    this.client = new Resend(options.apiKey);
  }

  /**
   * @desc Send an email via Resend
   * @param {Object} mail - Mail envelope
   * @param {string} mail.from - Sender address
   * @param {string} mail.to - Recipient address
   * @param {string} mail.subject - Email subject
   * @param {string} mail.html - HTML body
   * @returns {Promise<Object>} Resend API response data
   */
  async send({ from, to, subject, html }) {
    const { data, error } = await this.client.emails.send({ from, to, subject, html });
    if (error) throw new Error(error.message);
    return data;
  }
}
