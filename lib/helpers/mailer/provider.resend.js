import { Resend } from 'resend';

export default class ResendProvider {
  /**
   * Create a Resend mail provider instance.
   * @param {Object} options - Resend provider options
   * @param {string} options.apiKey - Resend API key
   * @returns {void}
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
   * @param {Array} [mail.attachments] - Optional attachments
   * @param {string} mail.attachments[].filename - Filename
   * @param {string|Buffer} mail.attachments[].content - Content (string or Buffer)
   * @returns {Promise<Object>} Resend API response data
   */
  async send({ from, to, subject, html, attachments }) {
    const payload = { from, to, subject, html };
    if (attachments?.length) {
      payload.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content).toString('base64'),
      }));
    }
    const { data, error } = await this.client.emails.send(payload);
    if (error) throw new Error(error.message || 'Resend API error');
    return data;
  }
}
