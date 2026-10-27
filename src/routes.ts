import type { Express } from 'express'
import type { Env } from './config/env.js'
import type { Database } from './db/pool.js'
import { createFcmSender } from './integrations/push/fcm.js'
import { consolePushSender, type PushSender } from './integrations/push/push.js'
import { createS3Storage } from './integrations/storage/s3.js'
import { unconfiguredStorage, type ObjectStorage } from './integrations/storage/storage.js'
import { createAppSettingsRepository } from './modules/app-settings/repository.js'
import { createAdminAppSettingsRouter, createPublicAppSettingsRouter } from './modules/app-settings/routes.js'
import { createAppSettingsService } from './modules/app-settings/service.js'
import { createWebsiteHomeRepository } from './modules/website/repository.js'
import { createAdminWebsiteRouter, createPublicWebsiteRouter } from './modules/website/routes.js'
import { createWebsiteHomeService } from './modules/website/service.js'
import { createCutoffRuleRepository } from './modules/cutoff-rules/repository.js'
import { createAdminCutoffRuleRouter } from './modules/cutoff-rules/routes.js'
import { createCutoffRuleService } from './modules/cutoff-rules/service.js'
import { createServiceAreaRepository } from './modules/service-areas/repository.js'
import { createAdminServiceAreaRouter } from './modules/service-areas/routes.js'
import { createServiceAreaService } from './modules/service-areas/service.js'
import { createCategoryRepository } from './modules/categories/repository.js'
import { createAdminCategoryRouter, createCategoryService, createPublicCategoryRouter } from './modules/categories/routes.js'
import { createSubscriptionRuleRepository } from './modules/subscription-rules/repository.js'
import { createAdminSubscriptionRuleRouter, createSubscriptionRuleService } from './modules/subscription-rules/routes.js'
import { createTrialPlanRepository } from './modules/trial-plans/repository.js'
import { createAdminTrialPlanRouter, createTrialPlanService } from './modules/trial-plans/routes.js'
import { createProductionPlanRepository } from './modules/production-planning/repository.js'
import { createAdminProductionPlanRouter } from './modules/production-planning/routes.js'
import { createProductionPlanService } from './modules/production-planning/service.js'
import { createAdjustmentRepository } from './modules/prepaid-adjustments/repository.js'
import { createAdminAdjustmentRouter } from './modules/prepaid-adjustments/routes.js'
import { createAdjustmentService } from './modules/prepaid-adjustments/service.js'
import { createCreditRepository } from './modules/credit/repository.js'
import { createAdminCreditRouter, createCustomerCreditRouter } from './modules/credit/routes.js'
import { createCreditService } from './modules/credit/service.js'
import { createOfferRepository } from './modules/offers/repository.js'
import { createAdminOfferRouter, createPublicOfferRouter } from './modules/offers/routes.js'
import { createOfferService } from './modules/offers/service.js'
import { createOrderRepository } from './modules/orders/repository.js'
import { createAdminOrderRouter, createCustomerOrderRouter } from './modules/orders/routes.js'
import { createOrderService } from './modules/orders/service.js'
import { createDeliveryBrainRepository } from './modules/delivery-brain/repository.js'
import { createPublicDeliveryRouter } from './modules/delivery-brain/routes.js'
import { createDeliveryBrainService } from './modules/delivery-brain/service.js'
import { createProductRepository } from './modules/products/repository.js'
import { createAdminProductRouter, createPublicProductRouter } from './modules/products/routes.js'
import { createProductService } from './modules/products/service.js'
import { createPinDirectoryRepository } from './modules/pin-directory/repository.js'
import { createAdminPinDirectoryRouter } from './modules/pin-directory/routes.js'
import { createDeliverySlotRepository } from './modules/delivery-slots/repository.js'
import { createAdminDeliverySlotRouter } from './modules/delivery-slots/routes.js'
import { createDeliverySlotService } from './modules/delivery-slots/service.js'
import { createHelpRepository } from './modules/help/repository.js'
import { createAdminHelpRouter, createPublicHelpRouter } from './modules/help/routes.js'
import { createHelpService } from './modules/help/service.js'
import { createPolicyRepository } from './modules/policies/repository.js'
import { createAdminPolicyRouter, createLegalPageRouter, createPublicPolicyRouter } from './modules/policies/routes.js'
import { createPolicyService } from './modules/policies/service.js'
import { createAuditWriter } from './modules/audit/audit.js'
import { createDashboardRepository } from './modules/dashboard/repository.js'
import { createAdminDashboardRouter } from './modules/dashboard/routes.js'
import { createDashboardService } from './modules/dashboard/service.js'
import { createNotificationRepository } from './modules/notifications/repository.js'
import { createAdminNotificationRouter, createCustomerNotificationRouter } from './modules/notifications/routes.js'
import { createNotificationService } from './modules/notifications/service.js'
import { consoleCodeSender, createSmtpCodeSender } from './modules/auth/mailer.js'
import { createAuthRepository } from './modules/auth/repository.js'
import { createAuthRouter } from './modules/auth/routes.js'
import { createAuthService, type CodeSender } from './modules/auth/service.js'
import { consoleCustomerCodeSender } from './modules/customer-auth/console-sender.js'
import { createSmtpCustomerCodeSender } from './modules/customer-auth/email-sender.js'
import { createCustomerAuthRepository } from './modules/customer-auth/repository.js'
import { createCustomerAuthRouter } from './modules/customer-auth/routes.js'
import { createCustomerAuthService, type CustomerCodeSender } from './modules/customer-auth/service.js'
import type { PaymentGateway } from './integrations/payments/gateway.js'
import { createPhonePeGateway } from './integrations/payments/phonepe.js'
import { createTestGateway } from './integrations/payments/test-gateway.js'
import { createPaymentRepository } from './modules/payments/repository.js'
import { createAdminPaymentRouter, createCustomerPaymentRouter, createPhonePeWebhookRouter } from './modules/payments/routes.js'
import { createPaymentService } from './modules/payments/service.js'
import { createSubscriptionRepository } from './modules/subscriptions/repository.js'
import { createAdminSubscriptionRouter, createCustomerSubscriptionRouter } from './modules/subscriptions/routes.js'
import { createSubscriptionService, HORIZON_DAYS } from './modules/subscriptions/service.js'
import { createCustomerAddressRepository } from './modules/customer-addresses/repository.js'
import { createCustomerAddressRouter } from './modules/customer-addresses/routes.js'
import { createCustomerAddressService } from './modules/customer-addresses/service.js'
import { createSupportTicketRepository } from './modules/support-tickets/repository.js'
import { createAdminSupportRouter, createCustomerSupportRouter } from './modules/support-tickets/routes.js'
import { createSupportTicketService } from './modules/support-tickets/service.js'
import { createCustomerRepository } from './modules/customers/repository.js'
import { createAdminCustomerRouter } from './modules/customers/routes.js'
import { createCustomerService } from './modules/customers/service.js'
import { createBannerRepository } from './modules/banners/repository.js'
import { createAdminBannerRouter, createPublicBannerRouter } from './modules/banners/routes.js'
import { createBannerService } from './modules/banners/service.js'
import { createOnboardingRepository } from './modules/onboarding/repository.js'
import { createAdminOnboardingRouter, createPublicOnboardingRouter } from './modules/onboarding/routes.js'
import { createOnboardingService } from './modules/onboarding/service.js'
import { createMediaRepository } from './modules/media/repository.js'
import { createAdminMediaRouter } from './modules/media/routes.js'
import { createMediaService } from './modules/media/service.js'

type Dependencies = { env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGINS' | 'AUTH_SECRET' | 'MAIL_MODE' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'MAIL_FROM' | 'AWS_REGION' | 'S3_MEDIA_BUCKET' | 'PHONEPE_ENV' | 'PHONEPE_CLIENT_ID' | 'PHONEPE_CLIENT_SECRET' | 'PHONEPE_CLIENT_VERSION' | 'PHONEPE_MERCHANT_ID' | 'PHONEPE_WEBHOOK_USERNAME' | 'PHONEPE_WEBHOOK_PASSWORD' | 'PUSH_MODE' | 'FIREBASE_SERVICE_ACCOUNT_FILE' | 'FIREBASE_SERVICE_ACCOUNT_JSON' | 'REVIEW_ACCOUNT_EMAIL' | 'REVIEW_ACCOUNT_CODE'>; database: Database; sender?: CodeSender; customerSender?: CustomerCodeSender; storage?: ObjectStorage; pushSender?: PushSender }

/**
 * Emails the customer's sign-in code through the same SMTP settings as the admin login; otherwise prints it in the backend window
 * (the environment check allows that only in development).
 */
function chooseCustomerSender(env: Dependencies['env']): CustomerCodeSender {
  if (env.MAIL_MODE !== 'smtp') return consoleCustomerCodeSender
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.MAIL_FROM) throw new Error('MAIL_MODE=smtp needs SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM.')
  return createSmtpCustomerCodeSender({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM })
}

/** Emails the login code when SMTP is configured; otherwise prints it (the environment check allows that only in development). */
function chooseSender(env: Dependencies['env']): CodeSender {
  if (env.MAIL_MODE !== 'smtp') return consoleCodeSender
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.MAIL_FROM) throw new Error('MAIL_MODE=smtp needs SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM.')
  return createSmtpCodeSender({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM })
}

/**
 * Wires every feature to the database and mounts its routes. This is the only place that knows how the pieces
 * fit together; each feature stays testable on its own.
 */
/** Firebase when PUSH_MODE=fcm; otherwise the stand-in that only prints that a push would go (the environment check refuses it in production). */
function choosePushSender(env: Dependencies['env']): PushSender {
  if (env.PUSH_MODE !== 'fcm') return consolePushSender
  return createFcmSender({ serviceAccountFile: env.FIREBASE_SERVICE_ACCOUNT_FILE, serviceAccountJson: env.FIREBASE_SERVICE_ACCOUNT_JSON })
}

/** The real bucket when one is configured; otherwise uploads report that storage is not set up. */
function chooseStorage(env: Dependencies['env']): ObjectStorage {
  return env.AWS_REGION && env.S3_MEDIA_BUCKET ? createS3Storage({ region: env.AWS_REGION, bucket: env.S3_MEDIA_BUCKET }) : unconfiguredStorage
}

/**
 * PhonePe when its settings are present; otherwise the test gateway, which is development-only (the environment check already
 * refuses a production start without PhonePe settings, and this refuses it again).
 */
function choosePaymentGateway(env: Dependencies['env']): PaymentGateway {
  if (env.PHONEPE_CLIENT_ID && env.PHONEPE_CLIENT_SECRET && env.PHONEPE_MERCHANT_ID) {
    return createPhonePeGateway({
      environment: env.PHONEPE_ENV, clientId: env.PHONEPE_CLIENT_ID, clientSecret: env.PHONEPE_CLIENT_SECRET, clientVersion: env.PHONEPE_CLIENT_VERSION, merchantId: env.PHONEPE_MERCHANT_ID,
      webhook: env.PHONEPE_WEBHOOK_USERNAME && env.PHONEPE_WEBHOOK_PASSWORD ? { username: env.PHONEPE_WEBHOOK_USERNAME, password: env.PHONEPE_WEBHOOK_PASSWORD } : undefined,
    })
  }
  if (env.NODE_ENV === 'production') throw new Error('Online payments need PhonePe settings in production.')
  return createTestGateway()
}

/** Short structured lines for payment problems. Only ids and reasons: never tokens, secrets or customer details. */
const paymentLogger = {
  warn: (data: object, message: string) => console.warn(JSON.stringify({ level: 'warn', message, ...data })),
  error: (data: object, message: string) => console.error(JSON.stringify({ level: 'error', message, ...data, err: 'err' in data && data.err instanceof Error ? data.err.message : undefined })),
}

export type MountRoutes = ((app: Express) => void) & {
  reconcilePayments: () => Promise<{ checked: number; failures: number }>
  /** The subscription delivery job: makes the coming days' orders for active subscriptions. */
  generateDeliveries: () => Promise<{ checked: number; failures: number }>
}

export function createRoutes({ env, database, sender, customerSender, storage, pushSender }: Dependencies): MountRoutes {
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET is not set. Add 32+ random characters to Backend/.env.local.')
  const codeSender = sender ?? chooseSender(env)
  const audit = createAuditWriter(database)
  const notifications = createNotificationService({ repository: createNotificationRepository(database), sender: pushSender ?? choosePushSender(env), audit, logger: paymentLogger })
  const notifier = notifications.notifier
  const auth = createAuthService({ repository: createAuthRepository(database), sender: codeSender, audit, secret: env.AUTH_SECRET })
  const objectStorage = storage ?? chooseStorage(env)
  const media = createMediaService({ repository: createMediaRepository(database), storage: objectStorage, audit })
  const banners = createBannerService({ repository: createBannerRepository(database), audit, storage: objectStorage, media })
  const onboarding = createOnboardingService({ repository: createOnboardingRepository(database), audit, storage: objectStorage, media })
  const appSettings = createAppSettingsService({ repository: createAppSettingsRepository(database), audit })
  const websiteHome = createWebsiteHomeService({ repository: createWebsiteHomeRepository(database), audit })
  const help = createHelpService({ repository: createHelpRepository(database), audit })
  const policies = createPolicyService({ repository: createPolicyRepository(database), audit })
  const deliverySlots = createDeliverySlotService({ repository: createDeliverySlotRepository(database), audit })
  const cutoffRules = createCutoffRuleService({ repository: createCutoffRuleRepository(database), audit })
  const serviceAreas = createServiceAreaService({ repository: createServiceAreaRepository(database), audit })
  const categories = createCategoryService({ repository: createCategoryRepository(database), audit })
  const trialPlans = createTrialPlanService({ repository: createTrialPlanRepository(database), audit })
  const subscriptionRules = createSubscriptionRuleService({ repository: createSubscriptionRuleRepository(database), audit })
  const delivery = createDeliveryBrainService({ repository: createDeliveryBrainRepository(database) })
  const products = createProductService({ repository: createProductRepository(database), audit, storage: objectStorage })
  // Customer sign-in codes are emailed through the same SMTP settings as the admin login (printed in the backend window in development).
  const customerAuth = createCustomerAuthService({ repository: createCustomerAuthRepository(database), sender: customerSender ?? chooseCustomerSender(env), secret: env.AUTH_SECRET, ...(env.REVIEW_ACCOUNT_EMAIL && env.REVIEW_ACCOUNT_CODE ? { reviewAccount: { email: env.REVIEW_ACCOUNT_EMAIL, code: env.REVIEW_ACCOUNT_CODE } } : {}) })
  const orderRepository = createOrderRepository(database)
  // The subscription service needs payments and payments call back into it, so the callback looks it up when it runs.
  const payments = createPaymentService({
    repository: createPaymentRepository(database), gateway: choosePaymentGateway(env), orders: orderRepository, logger: paymentLogger,
    onSubscriptionStarted: id => subscriptions.syncNow(id),
    onOrdersPlaced: (customerId, placed) => orders.announcePlaced(customerId, placed),
  })
  const offers = createOfferService({ repository: createOfferRepository(database), audit })
  const orders = createOrderService({ repository: orderRepository, addresses: createCustomerAddressRepository(database), delivery, audit, payments, offers, notifier })
  const subscriptions = createSubscriptionService({
    repository: createSubscriptionRepository(database), orders: orderRepository, addresses: createCustomerAddressRepository(database), delivery, payments, offers, audit, logger: paymentLogger, notifier,
  })
  const credit = createCreditService({ repository: createCreditRepository(database), audit, payments, notifier })
  const adjustments = createAdjustmentService({ repository: createAdjustmentRepository(database), audit, notifier })
  const productionPlans = createProductionPlanService({ repository: createProductionPlanRepository(database), horizonDays: HORIZON_DAYS, jobStatus: () => subscriptions.jobStatus() })
  const customerAddresses = createCustomerAddressService({ repository: createCustomerAddressRepository(database), delivery })
  const supportTickets = createSupportTicketService({ repository: createSupportTicketRepository(database), audit })
  const customers = createCustomerService({ repository: createCustomerRepository(database), addresses: createCustomerAddressRepository(database), audit })
  const dashboard = createDashboardService({ repository: createDashboardRepository(database) })
  const secureCookie = env.NODE_ENV === 'production'

  const mount = (app: Express) => {
    app.use('/admin/auth', createAuthRouter({ auth, allowedOrigins: env.CORS_ORIGINS, secureCookie }))
    app.use('/webhooks/phonepe', createPhonePeWebhookRouter({ payments }))
    app.use('/customer/payments', createCustomerPaymentRouter({ auth: customerAuth, payments }))
    app.use('/admin/payments', createAdminPaymentRouter({ auth, payments, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/customer', createCustomerAuthRouter({ auth: customerAuth }))
    app.use('/customer', createCustomerAddressRouter({ auth: customerAuth, addresses: customerAddresses }))
    app.use('/customer', createCustomerOrderRouter({ auth: customerAuth, orders }))
    app.use('/customer', createCustomerSubscriptionRouter({ auth: customerAuth, subscriptions }))
    app.use('/customer', createCustomerNotificationRouter({ auth: customerAuth, notifications }))
    app.use('/admin/dashboard', createAdminDashboardRouter({ auth, dashboard, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/notifications', createAdminNotificationRouter({ auth, notifications, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/subscriptions', createAdminSubscriptionRouter({ auth, subscriptions, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/production-planning', createAdminProductionPlanRouter({ auth, plans: productionPlans, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/customer', createCustomerCreditRouter({ auth: customerAuth, credit }))
    app.use('/admin/credit-accounts', createAdminCreditRouter({ auth, credit, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/prepaid-adjustments', createAdminAdjustmentRouter({ auth, adjustments, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/orders', createAdminOrderRouter({ auth, orders, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/customer/support', createCustomerSupportRouter({ auth: customerAuth, tickets: supportTickets }))
    app.use('/admin/support-tickets', createAdminSupportRouter({ auth, tickets: supportTickets, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/customers', createAdminCustomerRouter({ auth, customers, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/media', createAdminMediaRouter({ auth, media, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/app-settings', createAdminAppSettingsRouter({ auth, settings: appSettings, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/app-settings', createPublicAppSettingsRouter({ settings: appSettings }))
    app.use('/admin/website', createAdminWebsiteRouter({ auth, home: websiteHome, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/website', createPublicWebsiteRouter({ home: websiteHome }))
    app.use('/admin/help', createAdminHelpRouter({ auth, help, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/help', createPublicHelpRouter({ help }))
    app.use('/admin/policies', createAdminPolicyRouter({ auth, policies, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/policies', createPublicPolicyRouter({ policies }))
    app.use('/legal', createLegalPageRouter({ policies }))
    app.use('/admin/delivery-slots', createAdminDeliverySlotRouter({ auth, slots: deliverySlots, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/cutoff-rules', createAdminCutoffRuleRouter({ auth, rules: cutoffRules, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/service-areas', createAdminServiceAreaRouter({ auth, areas: serviceAreas, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/products', createAdminProductRouter({ auth, products, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/products', createPublicProductRouter({ products }))
    app.use('/public/categories', createPublicCategoryRouter({ categories }))
    app.use('/admin/categories', createAdminCategoryRouter({ auth, categories, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/trial-plans', createAdminTrialPlanRouter({ auth, trialPlans, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/subscription-rules', createAdminSubscriptionRuleRouter({ auth, subscriptionRules, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/delivery', createPublicDeliveryRouter({ delivery }))
    app.use('/admin/pin-directory', createAdminPinDirectoryRouter({ auth, directory: createPinDirectoryRepository(database), allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/banners', createAdminBannerRouter({ auth, banners, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/admin/offers', createAdminOfferRouter({ auth, offers, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/offers', createPublicOfferRouter({ offers }))
    app.use('/admin/onboarding', createAdminOnboardingRouter({ auth, onboarding, allowedOrigins: env.CORS_ORIGINS }))
    app.use('/public/onboarding', createPublicOnboardingRouter({ onboarding }))
    app.use('/public/banners', createPublicBannerRouter({ banners }))
  }
  return Object.assign(mount, { reconcilePayments: () => payments.reconcile(), generateDeliveries: () => subscriptions.generate() })
}
