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
   * @param {string|string[]} [mail.replyTo] - Reply-to address(es); omitted from the
   *   payload (not sent as an empty/undefined field) when absent
   * @param {Object<string,string>} [mail.headers] - Custom headers; omitted from the
   *   payload when absent
   * @param {Array} [mail.attachments] - Optional attachments
   * @param {string} mail.attachments[].filename - Filename
   * @param {string|Buffer} mail.attachments[].content - Attachment content (string or Buffer)
   * @returns {Promise<Object>} Nodemailer send result
   */
  async send({ from, to, subject, html, attachments, replyTo, headers }) {
    const payload = { from, to, subject, html };
    if (attachments?.length) payload.attachments = attachments;
    if (replyTo) payload.replyTo = replyTo;
    if (headers) payload.headers = headers;
    return this.transport.sendMail(payload);
  }
}
