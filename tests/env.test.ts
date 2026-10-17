import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env.js'

const valid = { NODE_ENV: 'development', DATABASE_URL: 'postgres://app:pw@localhost:5432/shreeram_dev', CORS_ORIGINS: 'http://localhost:3000, http://localhost:3002' }

describe('environment', () => {
  it('applies safe defaults and splits CORS origins', () => {
    const env = loadEnv({})
    expect([env.NODE_ENV, env.PORT, env.HOST, env.DB_SSL, env.CORS_ORIGINS, env.RATE_LIMIT_PER_MINUTE]).toEqual(['development', 4000, '0.0.0.0', 'require', [], 300])
    expect(loadEnv(valid).CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3002'])
  })
  it('rejects a wildcard or malformed CORS origin', () => {
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: '*' })).toThrow(/no wildcard/)
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: 'localhost:3000' })).toThrow(/not an allowed origin/)
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: 'http://localhost:3000/admin' })).toThrow(/not an allowed origin/)
  })
  it('rejects a database URL that is not postgres and a bad port', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow(/postgres/)
    expect(() => loadEnv({ PORT: '70000' })).toThrow(/PORT/)
  })
  it('takes PhonePe settings all together or not at all, and defaults to the sandbox', () => {
    expect(loadEnv(valid).PHONEPE_ENV).toBe('sandbox')
    expect(loadEnv({ ...valid, PHONEPE_CLIENT_ID: 'id', PHONEPE_CLIENT_SECRET: 's', PHONEPE_MERCHANT_ID: 'M1' }).PHONEPE_CLIENT_VERSION).toBe(1)
    expect(() => loadEnv({ ...valid, PHONEPE_CLIENT_ID: 'id' })).toThrow(/must be set together/)
    expect(() => loadEnv({ ...valid, PHONEPE_WEBHOOK_USERNAME: 'only-one' })).toThrow(/PHONEPE_WEBHOOK_PASSWORD/)
    expect(() => loadEnv({ ...valid, PHONEPE_ENV: 'live' })).toThrow(/PHONEPE_ENV/)
  })
  it('needs a long enough secret when one is given', () => {
    expect(() => loadEnv({ AUTH_SECRET: 'too-short' })).toThrow(/AUTH_SECRET/)
    expect(loadEnv({ AUTH_SECRET: 'x'.repeat(32) }).MAIL_MODE).toBe('console')
  })
  it('needs every email setting when email mode is smtp, and rejects an unknown mode', () => {
    expect(() => loadEnv({ MAIL_MODE: 'smtp' })).toThrow(/SMTP_HOST: is required when MAIL_MODE=smtp/)
    expect(loadEnv({ MAIL_MODE: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'f' }).SMTP_PORT).toBe(587)
    expect(() => loadEnv({ MAIL_MODE: 'ses' })).toThrow(/MAIL_MODE/)
  })
  it('takes the store reviewer demo account as an email plus a 6-digit code, together', () => {
    expect(loadEnv({ REVIEW_ACCOUNT_EMAIL: 'Reviewer@Example.com', REVIEW_ACCOUNT_CODE: '424242' }).REVIEW_ACCOUNT_EMAIL).toBe('reviewer@example.com')
    expect(() => loadEnv({ REVIEW_ACCOUNT_EMAIL: 'r@example.com' })).toThrow(/must be set together/)
    expect(() => loadEnv({ REVIEW_ACCOUNT_EMAIL: 'r@example.com', REVIEW_ACCOUNT_CODE: '12' })).toThrow(/6 digits/)
    expect(() => loadEnv({ REVIEW_ACCOUNT_EMAIL: 'nope', REVIEW_ACCOUNT_CODE: '123456' })).toThrow(/email address/)
  })
  it('keeps the rate limit within a sensible range', () => {
    expect(loadEnv({ RATE_LIMIT_PER_MINUTE: '600' }).RATE_LIMIT_PER_MINUTE).toBe(600)
    expect(() => loadEnv({ RATE_LIMIT_PER_MINUTE: '1' })).toThrow(/RATE_LIMIT_PER_MINUTE/)
    expect(() => loadEnv({ RATE_LIMIT_PER_MINUTE: '999999' })).toThrow(/RATE_LIMIT_PER_MINUTE/)
  })
  it('is stricter in production: needs a database, forbids disabling TLS, and wants https origins', () => {
    const production = { ...valid, NODE_ENV: 'production', CORS_ORIGINS: 'https://admin.example.com', AUTH_SECRET: 'x'.repeat(40), PUSH_MODE: 'fcm', FIREBASE_SERVICE_ACCOUNT_FILE: '/run/secrets/firebase.json', MAIL_MODE: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'ShreeRam <a@b.co>', AWS_REGION: 'ap-south-1', S3_MEDIA_BUCKET: 'media-bucket', PHONEPE_ENV: 'production', PHONEPE_CLIENT_ID: 'id', PHONEPE_CLIENT_SECRET: 'secret', PHONEPE_MERCHANT_ID: 'M1', PHONEPE_WEBHOOK_USERNAME: 'hook', PHONEPE_WEBHOOK_PASSWORD: 'pass' }
    expect(loadEnv(production).NODE_ENV).toBe('production')
    // Real money: PhonePe and its webhook must be set, and the sandbox is refused.
    expect(() => loadEnv({ ...production, PHONEPE_CLIENT_ID: undefined, PHONEPE_CLIENT_SECRET: undefined, PHONEPE_MERCHANT_ID: undefined })).toThrow(/PHONEPE_CLIENT_ID: is required/)
    expect(() => loadEnv({ ...production, PHONEPE_WEBHOOK_USERNAME: undefined, PHONEPE_WEBHOOK_PASSWORD: undefined })).toThrow(/PHONEPE_WEBHOOK_USERNAME: is required/)
    expect(() => loadEnv({ ...production, PHONEPE_ENV: 'sandbox' })).toThrow(/PHONEPE_ENV/)
    expect(() => loadEnv({ ...production, S3_MEDIA_BUCKET: undefined })).toThrow(/S3_MEDIA_BUCKET/)
    expect(() => loadEnv({ AWS_REGION: 'ap-south-1' })).toThrow(/must be set together/)
    expect(() => loadEnv({ ...production, DATABASE_URL: undefined })).toThrow(/DATABASE_URL: is required/)
    expect(() => loadEnv({ ...production, DB_SSL: 'disable' })).toThrow(/cannot be disabled/)
    expect(() => loadEnv({ ...production, AUTH_SECRET: undefined })).toThrow(/AUTH_SECRET: is required/)
    expect(() => loadEnv({ ...production, MAIL_MODE: 'console' })).toThrow(/cannot be "console"/)
    // Notifications go through Firebase in production, with the key file or secret supplied.
    expect(() => loadEnv({ ...production, PUSH_MODE: 'console' })).toThrow(/PUSH_MODE: cannot be "console"/)
    expect(() => loadEnv({ ...production, FIREBASE_SERVICE_ACCOUNT_FILE: undefined })).toThrow(/FIREBASE_SERVICE_ACCOUNT_FILE/)
    expect(() => loadEnv({ ...production, CORS_ORIGINS: 'http://admin.example.com' })).toThrow(/https/)
  })
  it('lists every problem at once and never prints the connection string', () => {
    try { loadEnv({ PORT: '0', DATABASE_URL: 'mysql://user:secret@host/db' }); expect.unreachable() }
    catch (error) { const message = String(error); expect(message).toMatch(/PORT/); expect(message).toMatch(/DATABASE_URL/); expect(message).not.toMatch(/secret/) }
  })
})
