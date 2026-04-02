import nodemailer from 'nodemailer';

export default class NodemailerProvider {
  constructor(options) {
    this.transport = nodemailer.createTransport(options);
  }

  /**
   * @desc Send an email via Nodemailer
   * @param {Object} mail - Mail envelope
   * @param {string} mail.from - Sender address
   * @param {string} mail.to - Recipient address
   * @param {string} mail.subject - Email subject
   * @param {string} mail.html - HTML body
   * @param {Array} [mail.attachments] - Optional attachments
   * @param {string} mail.attachments[].filename - Filename
   * @param {string|Buffer} mail.attachments[].content - Attachment content (string or Buffer)
   * @returns {Promise<Object>} Nodemailer send result
   */
  async send({ from, to, subject, html, attachments }) {
    const payload = { from, to, subject, html };
    if (attachments?.length) payload.attachments = attachments;
    return this.transport.sendMail(payload);
  }
}
