import nodemailer from 'nodemailer';

export default class NodemailerProvider {
  constructor(options) {
    this.transport = nodemailer.createTransport(options);
  }

  async send({ from, to, subject, html, attachments }) {
    const payload = { from, to, subject, html };
    if (attachments?.length) payload.attachments = attachments;
    return this.transport.sendMail(payload);
  }
}
