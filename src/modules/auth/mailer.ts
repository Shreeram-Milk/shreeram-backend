import nodemailer, { type Transporter } from 'nodemailer'
import type { CodeSender } from './service.js'

/**
 * Development only: prints the login code in the backend window instead of emailing it, so sign-in can be tested
 * without an email account. The environment check refuses this mode in production.
 */
export const consoleCodeSender: CodeSender = {
  async sendLoginCode(email, code) {
    console.log(`\n[DEV ONLY] Admin login code for ${email}: ${code}\n`)
  },
}

export type SmtpSettings = { host: string; port: number; user: string; pass: string; from: string }

/** Escapes text for the HTML part of an email. The code is digits, but the habit keeps future templates safe. */
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string)

/**
 * Emails the login code through any SMTP server (Gmail, or AWS SES's SMTP endpoint in production).
 * Port 465 uses TLS from the start; any other port must upgrade to TLS before the password is sent.
 * `transport` is only for tests.
 */
export function createSmtpCodeSender(settings: SmtpSettings, transport?: Transporter): CodeSender {
  const transporter = transport ?? nodemailer.createTransport({ host: settings.host, port: settings.port, secure: settings.port === 465, requireTLS: settings.port !== 465, auth: { user: settings.user, pass: settings.pass }, connectionTimeout: 10_000, socketTimeout: 15_000 })
  return {
    async sendLoginCode(email, code) {
      await transporter.sendMail({
        from: settings.from,
        to: email,
        subject: 'Your ShreeRam Milks admin login code',
        text: `Your login code is ${code}.\n\nIt works once and expires in 10 minutes. If you did not try to sign in, ignore this email and change your password.`,
        html: `<p>Your login code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p><p>It works once and expires in 10 minutes. If you did not try to sign in, ignore this email and change your password.</p>`,
      })
    },
  }
}
