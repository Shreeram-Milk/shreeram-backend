import nodemailer, { type Transporter } from 'nodemailer'
import type { SmtpSettings } from '../auth/mailer.js'
import type { CustomerCodeSender } from './service.js'
import { createCodeEmail } from '../auth/code-email.js'

/**
 * Emails the customer's sign-in code through the same SMTP server the admin login uses (the MAIL_* settings). Port 465 uses TLS
 * from the start; any other port must upgrade to TLS before the password is sent. `transport` is only for tests.
 */
export function createSmtpCustomerCodeSender(settings: SmtpSettings, transport?: Transporter): CustomerCodeSender {
  const transporter = transport ?? nodemailer.createTransport({ host: settings.host, port: settings.port, secure: settings.port === 465, requireTLS: settings.port !== 465, auth: { user: settings.user, pass: settings.pass } })
  return {
    channel: 'email',
    async sendCode(email, code) {
      await transporter.sendMail({
        from: settings.from,
        to: email,
        subject: 'Your ShreeRam Milks sign-in code',
        ...createCodeEmail(code, 'customer'),
      })
    },
  }
}
