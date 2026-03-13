import nodemailer from 'nodemailer';

export default class NodemailerProvider {
  constructor(options) {
    this.transport = nodemailer.createTransport(options);
  }

  async send({ from, to, subject, html }) {
    return this.transport.sendMail({ from, to, subject, html });
  }
}
