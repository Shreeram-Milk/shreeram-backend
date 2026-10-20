import nodemailer from 'nodemailer'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createSmtpCodeSender } from '../src/modules/auth/mailer.js'
import { createCodeEmail } from '../src/modules/auth/code-email.js'
import { createSmtpCustomerCodeSender } from '../src/modules/customer-auth/email-sender.js'
import { createAuthRouter } from '../src/modules/auth/routes.js'
import { createAuthService, type CodeSender } from '../src/modules/auth/service.js'
import { ADMIN_ORIGIN, PASSWORD, SECRET, createClock, createFakeAuthRepository } from './fakes.js'

const settings = { host: 'smtp.example.com', port: 587, user: 'sender@example.com', pass: 'app-password', from: 'ShreeRam Milks <sender@example.com>' }

describe('emailing the login code', () => {
  it('sends customers a selectable code with leading zeroes preserved in HTML and plain text', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMail = vi.spyOn(transport, 'sendMail')
    await createSmtpCustomerCodeSender(settings, transport).sendCode('customer@example.com', '012345')
    const mail = sendMail.mock.calls[0]?.[0] as { to: string; subject: string; html: string; text: string }
    expect(mail.to).toBe('customer@example.com')
    expect(mail.subject).toBe('Your ShreeRam Milks sign-in code')
    expect(mail.html.match(/<code\b[^>]*>([^<]*)<\/code>/)?.[1]).toBe('012345')
    expect(mail.text).toContain('\n\n012345\n\n')
    expect(mail.html).toContain('10 minutes')
    expect(mail.html).not.toMatch(/<script|<button|onclick=|<img/i)
  })
  it('escapes values in the HTML and keeps the admin security advice', () => {
    const mail = createCodeEmail('<img src=x onerror="alert(1)">', 'admin')
    expect(mail.html).not.toContain('<img')
    expect(mail.html).toContain('&lt;img')
    expect(mail.text).toContain('change your password')
    expect(mail.html).toContain('change your password')
  })

  it('sends one email to the admin with the code, the right sender and a plain explanation', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sender = createSmtpCodeSender(settings, transport)
    const sendMail = vi.spyOn(transport, 'sendMail')
    await sender.sendLoginCode('owner@example.com', '482913')
    expect(sendMail).toHaveBeenCalledTimes(1)
    const mail = sendMail.mock.calls[0]?.[0] as { from: string; to: string; subject: string; text: string; html: string }
    expect(mail.to).toBe('owner@example.com')
    expect(mail.from).toBe(settings.from)
    expect(mail.subject).toMatch(/login code/i)
    expect(mail.text).toContain('482913')
    expect(mail.text).toMatch(/10 minutes/)
    expect(mail.html).toContain('482913')
  })
  it('never includes the mail password in the message', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMail = vi.spyOn(transport, 'sendMail')
    await createSmtpCodeSender(settings, transport).sendLoginCode('owner@example.com', '123456')
    expect(JSON.stringify(sendMail.mock.calls)).not.toContain(settings.pass)
  })
})

describe('when the email cannot be sent', () => {
  async function build(sender: CodeSender) {
    const auth = createFakeAuthRepository()
    await auth.addAdmin()
    const audit: string[] = []
    const service = createAuthService({ repository: auth.repository, sender, audit: async entry => { audit.push(entry.action) }, secret: SECRET, now: createClock().now })
    const app = createApp({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', CORS_ORIGINS: [ADMIN_ORIGIN], RATE_LIMIT_PER_MINUTE: 1000 }, routes: router => { router.use('/admin/auth', createAuthRouter({ auth: service, allowedOrigins: [ADMIN_ORIGIN], secureCookie: false })) } })
    return { app, audit }
  }

  it('tells the admin plainly, hides the reason, and records that it failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { app, audit } = await build({ sendLoginCode: async () => { throw new Error('Invalid login: 535 Username and Password not accepted for smtp.gmail.com') } })
    const response = await request(app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
    expect([response.status, response.body.error.code]).toEqual([503, 'EMAIL_FAILED'])
    expect(JSON.stringify(response.body)).not.toMatch(/535|smtp|Username|gmail/i)
    expect(audit).toContain('login_code_failed')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
