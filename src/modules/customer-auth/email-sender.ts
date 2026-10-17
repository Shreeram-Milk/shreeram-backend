import nodemailer, { type Transporter } from 'nodemailer'
import type { SmtpSettings } from '../auth/mailer.js'
import type { CustomerCodeSender } from './service.js'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string)

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
        text: `Your sign-in code is ${code}.\n\nIt works once and expires in 10 minutes. If you did not ask for it, you can ignore this email.`,
        html: `<p>Your sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p><p>It works once and expires in 10 minutes. If you did not ask for it, you can ignore this email.</p>`,
      })
    },
  }
}
