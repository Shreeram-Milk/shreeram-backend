import { z } from 'zod'

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// connection string')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Browser origins allowed to call the API (the admin). The mobile app sends no Origin header. */
  CORS_ORIGINS: z.string().default('').transform(value => value.split(',').map(origin => origin.trim()).filter(Boolean)),
  /** Requests one client address may make per minute across the API. Sign-in and OTP get stricter limits of their own. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
  /** Signs and protects login codes and sessions. At least 32 random characters; never share or commit it. */
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  /** How admin login codes are delivered. `console` prints them in this window (development only); `smtp` emails them. */
  MAIL_MODE: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().optional().transform(value => value || undefined),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional().transform(value => value || undefined),
  SMTP_PASS: z.string().optional().transform(value => value || undefined),
  /** The "From" line on emails, like `ShreeRam Milks <no-reply@example.com>`. */
  MAIL_FROM: z.string().optional().transform(value => value || undefined),
  /** Notifications to phones. `console` only prints that a push would go (development); `fcm` sends through Firebase Cloud Messaging. */
  PUSH_MODE: z.enum(['console', 'fcm']).default('console'),
  /**
   * A demo sign-in for the Google Play reviewer, who cannot receive our emails. Both or neither: this email always signs in with this
   * fixed 6-digit code. Leave both empty unless the store asks for it, and remove them once the review is over.
   */
  REVIEW_ACCOUNT_EMAIL: z.string().trim().toLowerCase().optional().transform(value => value || undefined),
  REVIEW_ACCOUNT_CODE: z.string().trim().optional().transform(value => value || undefined),
  /** Where the Firebase service account key file is (kept outside the code), or its contents as a secret value. Never logged. */
  FIREBASE_SERVICE_ACCOUNT_FILE: z.string().optional().transform(value => value || undefined),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional().transform(value => value || undefined),
  /** File storage. The bucket stays private. The AWS access keys (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are read by the AWS library itself and never pass through this app. */
  AWS_REGION: z.string().optional().transform(value => value || undefined),
  S3_MEDIA_BUCKET: z.string().optional().transform(value => value || undefined),
  DATABASE_URL: postgresUrl.optional(),
  MIGRATION_DATABASE_URL: postgresUrl.optional(),
  DB_SSL: z.enum(['require', 'disable']).default('require'),
  DB_SSL_CA_PATH: z.string().optional().transform(value => value || undefined),
  DB_TLS_SERVERNAME: z.string().optional().transform(value => value || undefined),
  /**
   * PhonePe (online payments). Leave all empty in development to use the built-in test payment, which never moves money and is
   * refused in production. The client id, secret and version come from the PhonePe Business Dashboard (Developer Settings);
   * the merchant id is what the phone app gives PhonePe's SDK.
   */
  PHONEPE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  /**
   * Lets a server running with NODE_ENV=production (error handling, secure cookies, strict checks) take PhonePe SANDBOX payments, for
   * testing on AWS before PhonePe approves live access. Off by default. It only allows PHONEPE_ENV=sandbox; remove it when going live.
   */
  ALLOW_SANDBOX_PAYMENTS: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PHONEPE_CLIENT_ID: z.string().optional().transform(value => value || undefined),
  PHONEPE_CLIENT_SECRET: z.string().optional().transform(value => value || undefined),
  PHONEPE_CLIENT_VERSION: z.coerce.number().int().min(1).default(1),
  PHONEPE_MERCHANT_ID: z.string().optional().transform(value => value || undefined),
  /** The username and password typed into PhonePe's webhook settings. PhonePe sends SHA256(username:password) with every webhook. */
  PHONEPE_WEBHOOK_USERNAME: z.string().optional().transform(value => value || undefined),
  PHONEPE_WEBHOOK_PASSWORD: z.string().optional().transform(value => value || undefined),
}).superRefine((value, context) => {
  for (const origin of value.CORS_ORIGINS) {
    if (origin === '*' || !/^https?:\/\/[^\s/]+$/.test(origin)) context.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: `"${origin}" is not an allowed origin. List exact origins like http://localhost:3000, with no wildcard or path.` })
  }
  if (value.MAIL_MODE === 'smtp') {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'] as const) {
      if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: 'is required when MAIL_MODE=smtp.' })
    }
  }
  if (value.PUSH_MODE === 'fcm' && !value.FIREBASE_SERVICE_ACCOUNT_FILE && !value.FIREBASE_SERVICE_ACCOUNT_JSON) {
    context.addIssue({ code: 'custom', path: ['FIREBASE_SERVICE_ACCOUNT_FILE'], message: 'FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_SERVICE_ACCOUNT_JSON is required when PUSH_MODE=fcm.' })
  }
  if ((value.REVIEW_ACCOUNT_EMAIL === undefined) !== (value.REVIEW_ACCOUNT_CODE === undefined)) context.addIssue({ code: 'custom', path: ['REVIEW_ACCOUNT_CODE'], message: 'REVIEW_ACCOUNT_EMAIL and REVIEW_ACCOUNT_CODE must be set together.' })
  if (value.REVIEW_ACCOUNT_EMAIL !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.REVIEW_ACCOUNT_EMAIL)) context.addIssue({ code: 'custom', path: ['REVIEW_ACCOUNT_EMAIL'], message: 'must be an email address.' })
  if (value.REVIEW_ACCOUNT_CODE !== undefined && !/^\d{6}$/.test(value.REVIEW_ACCOUNT_CODE)) context.addIssue({ code: 'custom', path: ['REVIEW_ACCOUNT_CODE'], message: 'must be exactly 6 digits.' })
  if (value.ALLOW_SANDBOX_PAYMENTS && value.PHONEPE_ENV === 'production') context.addIssue({ code: 'custom', path: ['ALLOW_SANDBOX_PAYMENTS'], message: 'must be removed (or false) when PHONEPE_ENV=production, so a live server cannot be left in test mode by mistake.' })
  const phonePe = [value.PHONEPE_CLIENT_ID, value.PHONEPE_CLIENT_SECRET, value.PHONEPE_MERCHANT_ID]
  if (phonePe.some(Boolean) && !phonePe.every(Boolean)) context.addIssue({ code: 'custom', path: ['PHONEPE_CLIENT_ID'], message: 'PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET and PHONEPE_MERCHANT_ID must be set together.' })
  if ((value.PHONEPE_WEBHOOK_USERNAME === undefined) !== (value.PHONEPE_WEBHOOK_PASSWORD === undefined)) context.addIssue({ code: 'custom', path: ['PHONEPE_WEBHOOK_PASSWORD'], message: 'PHONEPE_WEBHOOK_USERNAME and PHONEPE_WEBHOOK_PASSWORD must be set together.' })
  if ((value.AWS_REGION === undefined) !== (value.S3_MEDIA_BUCKET === undefined)) context.addIssue({ code: 'custom', path: ['S3_MEDIA_BUCKET'], message: 'AWS_REGION and S3_MEDIA_BUCKET must be set together.' })
  if (value.NODE_ENV === 'production') {
    if (!value.S3_MEDIA_BUCKET) context.addIssue({ code: 'custom', path: ['S3_MEDIA_BUCKET'], message: 'is required in production.' })
    if (!value.DATABASE_URL) context.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'is required in production.' })
    if (!value.AUTH_SECRET) context.addIssue({ code: 'custom', path: ['AUTH_SECRET'], message: 'is required in production.' })
    if (value.PUSH_MODE === 'console') context.addIssue({ code: 'custom', path: ['PUSH_MODE'], message: 'cannot be "console" in production; notifications must be sent through Firebase (PUSH_MODE=fcm).' })
    if (value.MAIL_MODE === 'console') context.addIssue({ code: 'custom', path: ['MAIL_MODE'], message: 'cannot be "console" in production; login codes must be emailed.' })
    // Production takes real money: PhonePe and its webhook must be configured, and the sandbox is refused.
    for (const key of ['PHONEPE_CLIENT_ID', 'PHONEPE_WEBHOOK_USERNAME'] as const) {
      if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: 'is required in production.' })
    }
    // Real money needs the live PhonePe. The sandbox is allowed only when ALLOW_SANDBOX_PAYMENTS=true says so on purpose (testing before approval).
    if (value.PHONEPE_ENV !== 'production' && !value.ALLOW_SANDBOX_PAYMENTS) context.addIssue({ code: 'custom', path: ['PHONEPE_ENV'], message: 'must be "production" in production (or set ALLOW_SANDBOX_PAYMENTS=true to test with the PhonePe sandbox).' })
    if (value.DB_SSL === 'disable') context.addIssue({ code: 'custom', path: ['DB_SSL'], message: 'cannot be disabled in production.' })
    if (value.CORS_ORIGINS.some(origin => origin.startsWith('http://'))) context.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'must use https:// in production.' })
  }
})

export type Env = z.infer<typeof schema>

/** Reads and checks the environment once at start-up, so a missing or unsafe setting fails clearly instead of at the first request. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues.map(issue => `  - ${issue.path.join('.') || 'environment'}: ${issue.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  return result.data
}
