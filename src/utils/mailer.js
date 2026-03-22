const nodemailer = require('nodemailer');
const config = require('../config/env');

class Mailer {
  constructor() {
    this.transporter = null;
  }

  isEnabled() {
    return Boolean(config.mail.enabled);
  }

  _createTransporter() {
    const transportOptions = {
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
    };

    if (config.mail.user && config.mail.pass) {
      transportOptions.auth = {
        user: config.mail.user,
        pass: config.mail.pass,
      };
    }

    return nodemailer.createTransport(transportOptions);
  }

  _getTransporter() {
    if (!this.transporter) {
      this.transporter = this._createTransporter();
    }

    return this.transporter;
  }

  async sendMail({ to, subject, text, html }) {
    if (!this.isEnabled()) {
      throw new Error('SMTP mailer is disabled.');
    }

    const transporter = this._getTransporter();
    return transporter.sendMail({
      from: config.mail.from,
      to,
      subject,
      text,
      html,
    });
  }
}

module.exports = new Mailer();
