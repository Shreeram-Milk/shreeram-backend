import type { CustomerCodeSender } from './service.js'

/**
 * Development only: prints the customer's sign-in code in the backend window instead of emailing it, so the phone app can
 * be tested without an email account. The environment check refuses this mode in production.
 */
export const consoleCustomerCodeSender: CustomerCodeSender = {
  channel: 'console',
  async sendCode(email, code) {
    console.log(`\n[DEV ONLY] Customer sign-in code for ${email}: ${code}\n`)
  },
}
