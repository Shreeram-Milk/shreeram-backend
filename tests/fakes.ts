import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import { createApp } from '../src/app.js'
import type { SlotRules } from '../src/modules/delivery-brain/service.js'
import type { SubscriptionSnapshot } from '../src/modules/payments/repository.js'
import { createAdminSubscriptionRouter, createCustomerSubscriptionRouter } from '../src/modules/subscriptions/routes.js'
import { createAdminDashboardRouter } from '../src/modules/dashboard/routes.js'
import { createDashboardService } from '../src/modules/dashboard/service.js'
import type { DashboardRepository } from '../src/modules/dashboard/repository.js'
import { createNotificationService } from '../src/modules/notifications/service.js'
import { createAdminNotificationRouter, createCustomerNotificationRouter } from '../src/modules/notifications/routes.js'
import { createFakeNotificationStore } from './fake-notifications.js'
import { createSubscriptionService } from '../src/modules/subscriptions/service.js'
import { createFakeSubscriptionRepository } from './fake-subscriptions.js'
import type { ObjectStorage, StoredObject } from '../src/integrations/storage/storage.js'
import type { AuditEntry } from '../src/modules/audit/audit.js'
import { hashPassword } from '../src/modules/auth/crypto.js'
import type { AdminUser, AuthRepository, NewSession, StoredLoginCode, StoredSession } from '../src/modules/auth/repository.js'
import { createAuthRouter } from '../src/modules/auth/routes.js'
import { createAuthService, type CodeSender } from '../src/modules/auth/service.js'
import type { SupportTicket, SupportTicketRepository, TicketMessage } from '../src/modules/support-tickets/repository.js'
import { createAdminSupportRouter, createCustomerSupportRouter } from '../src/modules/support-tickets/routes.js'
import { createSupportTicketService } from '../src/modules/support-tickets/service.js'
import type { CustomerAddress, CustomerAddressRepository } from '../src/modules/customer-addresses/repository.js'
import { createCustomerAddressRouter } from '../src/modules/customer-addresses/routes.js'
import { createCustomerAddressService } from '../src/modules/customer-addresses/service.js'
import { DEFAULT_DOORSTEP_INSTRUCTIONS, type DoorstepInstructions } from '../src/modules/customer-addresses/schema.js'
import type { CustomerRepository } from '../src/modules/customers/repository.js'
import { createAdminCustomerRouter } from '../src/modules/customers/routes.js'
import { createCustomerService } from '../src/modules/customers/service.js'
import type { Customer, CustomerAuthRepository } from '../src/modules/customer-auth/repository.js'
import { createCustomerAuthRouter } from '../src/modules/customer-auth/routes.js'
import { createCustomerAuthService, type CustomerCodeSender } from '../src/modules/customer-auth/service.js'
import type { Banner, BannerRepository } from '../src/modules/banners/repository.js'
import { createAdminBannerRouter, createPublicBannerRouter } from '../src/modules/banners/routes.js'
import { createBannerService } from '../src/modules/banners/service.js'
import type { MediaAsset, MediaRepository } from '../src/modules/media/repository.js'
import type { OnboardingRepository, Slide } from '../src/modules/onboarding/repository.js'
import type { AppSettingsRepository, StoredAppSettings } from '../src/modules/app-settings/repository.js'
import type { Product, ProductRepository, ProductSummary, ProductVariant, PublicProduct, StoredImage } from '../src/modules/products/repository.js'
import { createAdminProductRouter, createPublicProductRouter } from '../src/modules/products/routes.js'
import type { ProductInput } from '../src/modules/products/schema.js'
import { createProductService } from '../src/modules/products/service.js'
import type { PinDirectoryRepository } from '../src/modules/pin-directory/repository.js'
import { createAdminPinDirectoryRouter } from '../src/modules/pin-directory/routes.js'
import type { Category } from '../src/modules/categories/repository.js'
import { createAdminCategoryRouter, createCategoryService, createPublicCategoryRouter } from '../src/modules/categories/routes.js'
import type { CategoryInput } from '../src/modules/categories/schema.js'
import type { RecordStatus } from '../src/modules/master-data/shared.js'
import type { SimpleRecordRepository } from '../src/modules/master-data/simple-records.js'
import type { SubscriptionRule } from '../src/modules/subscription-rules/repository.js'
import { createAdminSubscriptionRuleRouter, createSubscriptionRuleService } from '../src/modules/subscription-rules/routes.js'
import type { SubscriptionRuleInput } from '../src/modules/subscription-rules/schema.js'
import type { TrialPlan } from '../src/modules/trial-plans/repository.js'
import { createAdminTrialPlanRouter, createTrialPlanService } from '../src/modules/trial-plans/routes.js'
import type { TrialPlanInput } from '../src/modules/trial-plans/schema.js'
import type { Pin, ServiceArea, ServiceAreaRepository } from '../src/modules/service-areas/repository.js'
import { createAdminServiceAreaRouter } from '../src/modules/service-areas/routes.js'
import type { CoverageType, ServiceAreaInput } from '../src/modules/service-areas/schema.js'
import { createServiceAreaService } from '../src/modules/service-areas/service.js'
import type { CutoffRule, CutoffRuleRepository } from '../src/modules/cutoff-rules/repository.js'
import { createAdminCutoffRuleRouter } from '../src/modules/cutoff-rules/routes.js'
import { createCutoffRuleService } from '../src/modules/cutoff-rules/service.js'
import type { DeliverySlot, DeliverySlotRepository } from '../src/modules/delivery-slots/repository.js'
import { createAdminDeliverySlotRouter } from '../src/modules/delivery-slots/routes.js'
import { createDeliverySlotService } from '../src/modules/delivery-slots/service.js'
import type { Faq, HelpRepository, HelpTopic } from '../src/modules/help/repository.js'
import { createAdminHelpRouter, createPublicHelpRouter } from '../src/modules/help/routes.js'
import { createHelpService } from '../src/modules/help/service.js'
import type { Policy, PolicyRepository } from '../src/modules/policies/repository.js'
import { createAdminPolicyRouter, createLegalPageRouter, createPublicPolicyRouter } from '../src/modules/policies/routes.js'
import { createPolicyService } from '../src/modules/policies/service.js'
import { createAdminAppSettingsRouter, createPublicAppSettingsRouter } from '../src/modules/app-settings/routes.js'
import { createAppSettingsService } from '../src/modules/app-settings/service.js'
import { createAdminOnboardingRouter, createPublicOnboardingRouter } from '../src/modules/onboarding/routes.js'
import { createOnboardingService } from '../src/modules/onboarding/service.js'
import { createAdminMediaRouter } from '../src/modules/media/routes.js'
import { createMediaService } from '../src/modules/media/service.js'
import { createAdminOrderRouter, createCustomerOrderRouter } from '../src/modules/orders/routes.js'
import { createOrderService } from '../src/modules/orders/service.js'
import { createAdminOfferRouter, createPublicOfferRouter } from '../src/modules/offers/routes.js'
import { createOfferService } from '../src/modules/offers/service.js'
import { createFakeOfferRepository, type FakeRedemption } from './fake-offers.js'
import { createAdminAdjustmentRouter } from '../src/modules/prepaid-adjustments/routes.js'
import { createAdjustmentService } from '../src/modules/prepaid-adjustments/service.js'
import type { Adjustment, AdjustmentRepository } from '../src/modules/prepaid-adjustments/repository.js'
import { createAdminCreditRouter, createCustomerCreditRouter } from '../src/modules/credit/routes.js'
import { createCreditService } from '../src/modules/credit/service.js'
import type { CreditAccount, CreditRepository, LedgerEntry, PaymentRequest } from '../src/modules/credit/repository.js'
import { createAdminProductionPlanRouter } from '../src/modules/production-planning/routes.js'
import { createProductionPlanService } from '../src/modules/production-planning/service.js'
import type { DemandRow, SlotClosing } from '../src/modules/production-planning/rules.js'
import { canReturnMoney, canTransition, customerCanCancel, releasesMoney, withinCreditLimit, type CheckoutVariant, type OrderStatus } from '../src/modules/orders/rules.js'
import type { AdminOrderView, NewOrder, OrderRepository, OrderView } from '../src/modules/orders/repository.js'
import { AppError } from '../src/http/errors.js'
import type { DeliveryCheck } from '../src/modules/delivery-brain/service.js'
import { PaymentGatewayError, type GatewayState, type PaymentGateway } from '../src/integrations/payments/gateway.js'
import type { ActivityKind, AdminPaymentRow, OnlinePayment, OrderSnapshot, PaymentRepository } from '../src/modules/payments/repository.js'
import { createAdminPaymentRouter, createCustomerPaymentRouter, createPhonePeWebhookRouter } from '../src/modules/payments/routes.js'
import { createPaymentService } from '../src/modules/payments/service.js'

export const ADMIN_ORIGIN = 'http://localhost:3002'
export const SECRET = 'test-secret-test-secret-test-secret-1234'
export const PASSWORD = 'correct horse battery'

/** A movable clock, so tests can jump forward past a lockout, a code's expiry or a session's end. */
export function createClock(start = '2026-10-10T06:00:00.000Z') {
  let current = new Date(start)
  return { now: () => new Date(current), advanceMinutes: (minutes: number) => { current = new Date(current.getTime() + minutes * 60_000) }, set: (iso: string) => { current = new Date(iso) } }
}

type StoredCode = StoredLoginCode & { adminId: string; expiresAt: Date; consumed: boolean }
type StoredSessionRow = NewSession & { id: string; revoked: boolean }

export function createFakeAuthRepository() {
  const admins = new Map<string, AdminUser>()
  const codes: StoredCode[] = []
  const sessions: StoredSessionRow[] = []
  const repository: AuthRepository = {
    async findAdminByEmail(email) { return [...admins.values()].find(admin => admin.email === email) ?? null },
    async recordFailedLogin(adminId, lockAfter, lockedUntil) {
      const admin = admins.get(adminId)
      if (!admin) return
      admin.failedLoginCount += 1
      if (admin.failedLoginCount >= lockAfter) admin.lockedUntil = lockedUntil
    },
    async recordSuccessfulLogin(adminId) { const admin = admins.get(adminId); if (admin) { admin.failedLoginCount = 0; admin.lockedUntil = null } },
    async replaceLoginCode(adminId, codeHash, expiresAt) {
      for (const code of codes) if (code.adminId === adminId) code.consumed = true
      codes.push({ id: randomUUID(), adminId, codeHash, expiresAt, attempts: 0, consumed: false })
    },
    async findActiveLoginCode(adminId, now) {
      const code = codes.filter(item => item.adminId === adminId && !item.consumed && item.expiresAt > now).at(-1)
      return code ? { id: code.id, codeHash: code.codeHash, attempts: code.attempts } : null
    },
    async bumpCodeAttempts(codeId) { const code = codes.find(item => item.id === codeId); if (code) code.attempts += 1 },
    async consumeLoginCode(codeId) { const code = codes.find(item => item.id === codeId); if (!code || code.consumed) return false; code.consumed = true; return true },
    async createSession(session) { sessions.push({ ...session, id: randomUUID(), revoked: false }) },
    async findSession(tokenHash, now): Promise<StoredSession | null> {
      const session = sessions.find(item => item.tokenHash === tokenHash && !item.revoked && item.expiresAt > now)
      const admin = session ? admins.get(session.adminId) : undefined
      return session && admin && admin.status === 'active' ? { sessionId: session.id, adminId: admin.id, email: admin.email } : null
    },
    async touchSession() {},
    async revokeSession(tokenHash) { for (const session of sessions) if (session.tokenHash === tokenHash) session.revoked = true },
  }
  return {
    repository, codes, sessions, admins,
    async addAdmin(email = 'owner@example.com', password = PASSWORD): Promise<AdminUser> {
      const admin: AdminUser = { id: randomUUID(), email, passwordHash: await hashPassword(password), status: 'active', failedLoginCount: 0, lockedUntil: null }
      admins.set(admin.id, admin)
      return admin
    },
  }
}

type FakeCustomerCode = { id: string; email: string; codeHash: string; attempts: number; expiresAt: Date; consumed: boolean; ip: string; createdAt: Date }

/** In-memory customers, sign-in codes and sessions, behaving like the Postgres version. */
export function createFakeCustomerAuthRepository(now: () => Date) {
  const customers = new Map<string, Customer>()
  const codes: FakeCustomerCode[] = []
  const sessions: Array<{ id: string; customerId: string; tokenHash: string; expiresAt: Date; revoked: boolean }> = []
  const repository: CustomerAuthRepository = {
    async countCodes({ email, ip, since }) {
      const matching = codes.filter(code => code.createdAt > since && (email === undefined || code.email === email) && (ip === undefined || code.ip === ip))
      return { count: matching.length, latestAt: matching.reduce<Date | null>((latest, code) => (!latest || code.createdAt > latest ? code.createdAt : latest), null) }
    },
    async replaceCode({ email, codeHash, expiresAt, ip }) {
      for (const code of codes) if (code.email === email) code.consumed = true
      codes.push({ id: randomUUID(), email, codeHash, attempts: 0, expiresAt, consumed: false, ip, createdAt: now() })
    },
    async findActiveCode(email, at) {
      const code = codes.filter(item => item.email === email && !item.consumed && item.expiresAt > at).at(-1)
      return code ? { id: code.id, codeHash: code.codeHash, attempts: code.attempts } : null
    },
    async bumpCodeAttempts(codeId) { const code = codes.find(item => item.id === codeId); if (code) code.attempts += 1 },
    async consumeCode(codeId) { const code = codes.find(item => item.id === codeId); if (!code || code.consumed) return false; code.consumed = true; return true },
    async findByEmail(email) { return [...customers.values()].find(customer => customer.email.toLowerCase() === email && customer.status !== 'deleted') ?? null },
    async findOrCreateByEmail(email) {
      const existing = [...customers.values()].find(customer => customer.email.toLowerCase() === email && customer.status !== 'deleted')
      if (existing) return { customer: existing, created: false }
      const customer: Customer = { id: randomUUID(), phone: null, name: '', email, language: 'en', customerType: 'prepaid', status: 'active' }
      customers.set(customer.id, customer)
      return { customer, created: true }
    },
    async findById(id) { return customers.get(id) ?? null },
    async recordSignIn() {},
    async createSession({ customerId, tokenHash, expiresAt }) { sessions.push({ id: randomUUID(), customerId, tokenHash, expiresAt, revoked: false }) },
    async findSession(tokenHash, at) {
      const session = sessions.find(item => item.tokenHash === tokenHash && !item.revoked && item.expiresAt > at)
      const customer = session ? customers.get(session.customerId) : undefined
      return session && customer && customer.status === 'active' ? { sessionId: session.id, customer } : null
    },
    async touchSession() {},
    async revokeSession(tokenHash) { for (const session of sessions) if (session.tokenHash === tokenHash) session.revoked = true },
    async updateProfile(customerId, update) {
      const customer = customers.get(customerId)
      if (!customer || customer.status !== 'active') return null
      Object.assign(customer, update)
      return customer
    },
    async anonymise(customerId) {
      const customer = customers.get(customerId)
      if (customer) Object.assign(customer, { status: 'deleted', phone: null, name: '', email: '' })
      for (const session of sessions) if (session.customerId === customerId) session.revoked = true
    },
  }
  return { repository, customers, codes, sessions }
}

/** In-memory tickets and messages, behaving like the Postgres version (same ordering, same filters, same scoping). */
export function createFakeSupportTicketRepository(options: { customers: Map<string, Customer>; admins: Map<string, AdminUser>; now: () => Date }) {
  type Row = { ticket: Omit<SupportTicket, 'customerName' | 'customerPhone' | 'assigneeEmail' | 'messageCount'>; messages: Array<{ id: string; author: 'customer' | 'admin'; adminId: string | null; body: string; createdAt: string }> }
  const rows: Row[] = []
  let counter = 1000
  const view = (row: Row): SupportTicket => {
    const customer = options.customers.get(row.ticket.customerId)
    const assignee = row.ticket.assigneeAdminId ? options.admins.get(row.ticket.assigneeAdminId) : undefined
    return { ...row.ticket, customerName: customer?.name ?? '', customerPhone: customer?.phone ?? null, assigneeEmail: assignee?.email ?? null, messageCount: row.messages.length }
  }
  const touch = (row: Row) => { row.ticket.updatedAt = options.now().toISOString() }
  const repository: SupportTicketRepository = {
    async create({ customerId, category, description }) {
      counter += 1
      const stamp = options.now().toISOString()
      const row: Row = { ticket: { id: randomUUID(), ticketNumber: counter, customerId, category, status: 'open', assigneeAdminId: null, createdAt: stamp, updatedAt: stamp, resolvedAt: null, closedAt: null }, messages: [{ id: randomUUID(), author: 'customer', adminId: null, body: description, createdAt: stamp }] }
      rows.push(row)
      return view(row)
    },
    async countRecentForCustomer(customerId, since) { return rows.filter(row => row.ticket.customerId === customerId && new Date(row.ticket.createdAt) > since).length },
    async list({ search, status, category, customerId, forCustomerId, page, pageSize }) {
      const term = search.toLowerCase()
      const matching = rows.map(view)
        .filter(ticket => (!status || ticket.status === status) && (!category || ticket.category === category) && (!customerId || ticket.customerId === customerId) && (!forCustomerId || ticket.customerId === forCustomerId)
          && (!term || [ticket.customerName, ticket.customerPhone ?? '', `TKT-${ticket.ticketNumber}`].some(field => field.toLowerCase().includes(term))))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.ticketNumber - a.ticketNumber)
      return { rows: matching.slice((page - 1) * pageSize, page * pageSize), total: matching.length }
    },
    async getThread(id, forCustomerId) {
      const row = rows.find(item => item.ticket.id === id)
      if (!row || (forCustomerId !== undefined && row.ticket.customerId !== forCustomerId)) return null
      const messages = row.messages.map((message): TicketMessage => ({ id: message.id, author: message.author, authorName: message.author === 'admin' ? (options.admins.get(message.adminId ?? '')?.email ?? 'Support') : (options.customers.get(row.ticket.customerId)?.name ?? ''), body: message.body, createdAt: message.createdAt }))
      return { ticket: view(row), messages }
    },
    async addMessage({ ticketId, author, adminId, body, nextStatus }) {
      const row = rows.find(item => item.ticket.id === ticketId)
      if (!row) return false
      row.messages.push({ id: randomUUID(), author, adminId, body, createdAt: options.now().toISOString() })
      if (nextStatus) { row.ticket.status = nextStatus; if (nextStatus === 'open' || nextStatus === 'in_progress') row.ticket.resolvedAt = null }
      touch(row)
      return true
    },
    async setStatus(id, status, at) {
      const row = rows.find(item => item.ticket.id === id)
      if (!row) return false
      row.ticket.status = status
      if (status === 'resolved') row.ticket.resolvedAt = at.toISOString()
      if (status === 'open' || status === 'in_progress') row.ticket.resolvedAt = null
      if (status === 'closed') row.ticket.closedAt = at.toISOString()
      touch(row)
      return true
    },
    async setAssignee(id, adminId) { const row = rows.find(item => item.ticket.id === id); if (!row) return false; row.ticket.assigneeAdminId = adminId; touch(row); return true },
    async countNeedingAttention() { return rows.filter(row => row.ticket.status === 'open' || row.ticket.status === 'in_progress').length },
  }
  return { repository, rows }
}

/** In-memory addresses with the same rules as the Postgres version: one default, soft removal, nothing crosses customers. */
export function createFakeCustomerAddressRepository() {
  const rows: Array<CustomerAddress & { customerId: string; removed: boolean }> = []
  const instructions = new Map<string, DoorstepInstructions>()
  const live = (customerId: string) => rows.filter(row => row.customerId === customerId && !row.removed)
  const strip = ({ customerId: _customerId, removed: _removed, ...address }: (typeof rows)[number]): CustomerAddress => address
  const repository: CustomerAddressRepository = {
    async list(customerId) { return live(customerId).sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map(strip) },
    async find(customerId, id) { const row = live(customerId).find(item => item.id === id); return row ? strip(row) : null },
    async create(customerId, input) {
      const isDefault = input.isDefault || live(customerId).length === 0
      if (isDefault) for (const row of live(customerId)) row.isDefault = false
      const row = { id: randomUUID(), customerId, removed: false, label: input.label, recipientName: input.recipientName, recipientPhone: input.recipientPhone, line1: input.line1, line2: input.line2, landmark: input.landmark, city: input.city, pinCode: input.pinCode, isDefault }
      rows.push(row)
      return strip(row)
    },
    async update(customerId, id, input) {
      const row = live(customerId).find(item => item.id === id)
      if (!row) return null
      const isDefault = input.isDefault || row.isDefault
      if (isDefault) for (const other of live(customerId)) if (other.id !== id) other.isDefault = false
      Object.assign(row, { label: input.label, recipientName: input.recipientName, recipientPhone: input.recipientPhone, line1: input.line1, line2: input.line2, landmark: input.landmark, city: input.city, pinCode: input.pinCode, isDefault })
      return strip(row)
    },
    async remove(customerId, id) {
      const row = live(customerId).find(item => item.id === id)
      if (!row) return false
      row.removed = true
      row.isDefault = false
      const [first] = live(customerId)
      if (first && !live(customerId).some(item => item.isDefault)) first.isDefault = true
      return true
    },
    async getInstructions(customerId) { return instructions.get(customerId) ?? DEFAULT_DOORSTEP_INSTRUCTIONS },
    async saveInstructions(customerId, value) { instructions.set(customerId, value); return value },
  }
  return { repository, rows }
}

/** The admin's view of the same in-memory customers that sign-in creates. */
export function createFakeAdminCustomerRepository(customers: Map<string, Customer>): CustomerRepository {
  const notes = new Map<string, string>()
  const toAdmin = (customer: Customer) => {
    const stamp = new Date(Date.UTC(2026, 9, 1, 0, [...customers.keys()].indexOf(customer.id))).toISOString()
    return { id: customer.id, phone: customer.phone, name: customer.name, email: customer.email, language: customer.language, customerType: customer.customerType, status: customer.status, adminNote: notes.get(customer.id) ?? '', lastSignInAt: null, createdAt: stamp, updatedAt: stamp }
  }
  return {
    async list({ search, status, customerType, page, pageSize }) {
      const term = search.toLowerCase()
      const matching = [...customers.values()].map(toAdmin).filter(customer => (status ? customer.status === status : customer.status !== 'deleted') && (!customerType || customer.customerType === customerType) && (!term || [customer.name, customer.phone ?? '', customer.email].some(field => field.toLowerCase().includes(term)))).reverse()
      return { rows: matching.slice((page - 1) * pageSize, page * pageSize), total: matching.length }
    },
    async findById(id) { const customer = customers.get(id); return customer ? toAdmin(customer) : null },
    async update(id, { name, customerType, adminNote }) {
      const customer = customers.get(id)
      if (!customer || customer.status === 'deleted') return null
      Object.assign(customer, { name, customerType })
      notes.set(id, adminNote)
      return toAdmin(customer)
    },
  }
}

export function createFakeMediaRepository(): MediaRepository & { rows: MediaAsset[] } {
  const rows: MediaAsset[] = []
  return {
    rows,
    async createPending(asset) { const row: MediaAsset = { id: randomUUID(), objectKey: asset.objectKey, purpose: asset.purpose, contentType: asset.contentType, sizeBytes: asset.sizeBytes, status: 'pending' }; rows.push(row); return row },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async markReady(id) { const row = rows.find(item => item.id === id); if (row) row.status = 'ready' },
  }
}

/** Storage that keeps "files" in memory. `store` plays the part of the browser sending the file to the upload link. */
export function createFakeStorage(): ObjectStorage & { objects: Map<string, StoredObject & { text?: string }>; tickets: Array<{ key: string; contentType: string; sizeBytes: number }>; store(key: string, object: StoredObject & { text?: string }): void } {
  const objects = new Map<string, StoredObject & { text?: string }>()
  const tickets: Array<{ key: string; contentType: string; sizeBytes: number }> = []
  return {
    objects, tickets,
    store(key, object) { objects.set(key, object) },
    async createUploadTicket(input) { tickets.push(input); return { url: `https://upload.test/${input.key}?signed=1`, headers: { 'Content-Type': input.contentType }, expiresInSeconds: 300 } },
    async createDownloadUrl(key) { return `https://files.test/${key}?signed=1` },
    async describeObject(key) { const object = objects.get(key); return object ? { sizeBytes: object.sizeBytes, contentType: object.contentType } : null },
    async readObjectText(key) { return objects.get(key)?.text ?? '' },
  }
}

export const DEFAULT_SETTINGS: StoredAppSettings = {
  supportPhone: '', supportEmail: '', supportWhatsApp: '', callEnabled: false, chatEnabled: false, whatsappEnabled: false,
  supportHoursEn: 'Daily, 5:00 AM – 8:00 PM', supportHoursGu: '', afterHoursMessageEn: '', afterHoursMessageGu: '',
  deliveryPromiseEn: 'Delivered before 7:00 AM', deliveryPromiseGu: '', minimumAppVersion: '1.0.0',
  maintenanceMode: false, maintenanceMessageEn: '', maintenanceMessageGu: '', showMaintenanceContact: false,
  flags: { showTrials: true, showSubscriptions: true, showOffers: true, showQualityReports: true, showSeasonalBanner: true },
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** One settings record in memory, like the single row the migration creates. */
export function createFakeAppSettingsRepository(): AppSettingsRepository & { current: StoredAppSettings; savedBy: string[] } {
  const state = { current: { ...DEFAULT_SETTINGS }, savedBy: [] as string[] }
  return {
    get current() { return state.current },
    savedBy: state.savedBy,
    async get() { return state.current },
    async save(input, adminId) { state.current = { ...input, updatedAt: new Date().toISOString() }; state.savedBy.push(adminId); return state.current },
  }
}

export const TOPICS: HelpTopic[] = [
  { id: 'delivery_missing', labelEn: 'Delivery not received', labelGu: 'ડિલિવરી મળી નથી', iconKey: 'package-x', sortOrder: 1 },
  { id: 'late_delivery', labelEn: 'Late delivery', labelGu: 'મોડી ડિલિવરી', iconKey: 'clock', sortOrder: 2 },
  { id: 'payment_issue', labelEn: 'Payment issue', labelGu: 'ચુકવણીની સમસ્યા', iconKey: 'credit-card', sortOrder: 5 },
]

export function createFakeHelpRepository(): HelpRepository & { rows: Faq[] } {
  const rows: Faq[] = []
  const order = (topic: string) => TOPICS.find(item => item.id === topic)?.sortOrder ?? 99
  const sorted = () => [...rows].sort((a, b) => order(a.topic) - order(b.topic) || a.sortOrder - b.sortOrder || a.questionEn.localeCompare(b.questionEn))
  const stamp = () => new Date().toISOString()
  return {
    rows,
    async listTopics() { return TOPICS },
    async list({ search, topic, status, page, pageSize }) {
      const term = search.toLowerCase()
      const matches = sorted().filter(faq => (!topic || faq.topic === topic) && (!status || faq.status === status) && (!term || [faq.questionEn, faq.questionGu, faq.answerEn, faq.searchKeywords.join(' ')].join(' ').toLowerCase().includes(term)))
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length }
    },
    async listPublished() { return sorted().filter(faq => faq.status === 'published') },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async create(input) { const faq: Faq = { ...input, id: randomUUID(), updatedAt: stamp() }; rows.push(faq); return faq },
    async update(id, input) { const index = rows.findIndex(row => row.id === id); const current = rows[index]; if (!current) return null; const faq = { ...current, ...input, updatedAt: stamp() }; rows[index] = faq; return faq },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; row.featured = row.featured && status === 'published'; return row },
    async countFeatured(excludingId) { return rows.filter(row => row.featured && row.status === 'published' && row.id !== excludingId).length },
    async questionExists(topic, questionEn, excludingId) { return rows.some(row => row.id !== excludingId && row.topic === topic && row.questionEn.trim().toLowerCase() === questionEn.trim().toLowerCase()) },
  }
}

/** Policy versions in memory, enforcing the same rules the database does: one published per type, history never edited or deleted. */
export function createFakePolicyRepository(): PolicyRepository & { rows: Policy[] } {
  const rows: Policy[] = []
  const stamp = () => new Date().toISOString()
  return {
    rows,
    async list() { return [...rows].sort((a, b) => a.type.localeCompare(b.type) || b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt)) },
    async listPublished() { return rows.filter(row => row.status === 'published') },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async findPublished(type) { return rows.find(row => row.type === type && row.status === 'published') ?? null },
    async versionsOf(type) { return rows.filter(row => row.type === type).map(row => row.version) },
    async create(input) { const policy: Policy = { ...input, id: randomUUID(), status: 'draft', publishedAt: null, createdAt: stamp(), updatedAt: stamp() }; rows.push(policy); return policy },
    async updateDraft(id, input) { const row = rows.find(item => item.id === id && item.status === 'draft'); if (!row) return null; Object.assign(row, input, { updatedAt: stamp() }); return row },
    async publish(id, type) {
      const draft = rows.find(row => row.id === id && row.status === 'draft')
      if (!draft) return null
      for (const row of rows) if (row.type === type && row.status === 'published') row.status = 'archived'
      draft.status = 'published'
      draft.publishedAt = stamp()
      return draft
    },
    async archive(id) { const row = rows.find(item => item.id === id && item.status === 'published'); if (!row) return null; row.status = 'archived'; return row },
    async deleteDraft(id) { const index = rows.findIndex(row => row.id === id && row.status === 'draft'); if (index === -1) return false; rows.splice(index, 1); return true },
  }
}

/** Delivery slots in memory. `usageBySlot` is how tests pretend areas or cut-off rules use a slot. */
export function createFakeDeliverySlotRepository(): DeliverySlotRepository & { rows: DeliverySlot[]; usageBySlot: Map<string, { areas: number; rules: number }>; sameDayRules: (slotId: string, startTime: string) => string[] } {
  const rows: DeliverySlot[] = []
  const usageBySlot = new Map<string, { areas: number; rules: number }>()
  const stamp = () => new Date().toISOString()
  const sorted = () => [...rows].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name))
  return {
    rows, usageBySlot,
    /** Set by the test app once the order-by rules exist, so the slot store can ask about them like the real query does. */
    sameDayRules: () => [] as string[],
    async sameDayRulesClosingAfter(slotId, startTime) { return this.sameDayRules(slotId, startTime) },
    async list({ search, status, page, pageSize }) {
      const matches = sorted().filter(slot => (!status || slot.status === status) && (!search || slot.name.toLowerCase().includes(search.toLowerCase())))
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length }
    },
    async listAll() { return sorted() },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async create(input) { const slot: DeliverySlot = { ...input, id: randomUUID(), updatedAt: stamp() }; rows.push(slot); return slot },
    async update(id, input) { const index = rows.findIndex(row => row.id === id); const current = rows[index]; if (!current) return null; const slot = { ...current, ...input, updatedAt: stamp() }; rows[index] = slot; return slot },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; return row },
    async nameExists(name, excludingId) { return rows.some(row => row.id !== excludingId && row.name.trim().toLowerCase() === name.trim().toLowerCase()) },
    async remove(id) { const index = rows.findIndex(item => item.id === id); if (index < 0) return false; rows.splice(index, 1); return true },
    async usage(id) { const used = usageBySlot.get(id) ?? { areas: 0, rules: 0 }; return [{ label: 'service areas', count: used.areas, examples: [] }, { label: 'cut-off rules', count: used.rules, examples: [] }] },
  }
}

/** Cut-off rules in memory. They read slot statuses from the fake slot store, like the real query does. */
export function createFakeCutoffRuleRepository(slots: { rows: DeliverySlot[] }): CutoffRuleRepository & { rows: CutoffRule[]; productsByRule: Map<string, string[]> } {
  const rows: CutoffRule[] = []
  const productsByRule = new Map<string, string[]>()
  const stamp = () => new Date().toISOString()
  const sorted = () => [...rows].sort((a, b) => a.name.localeCompare(b.name))
  return {
    rows, productsByRule,
    async list({ search, status, page, pageSize }) {
      const matches = sorted().filter(rule => (!status || rule.status === status) && (!search || rule.name.toLowerCase().includes(search.toLowerCase())))
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length }
    },
    async listAll() { return sorted() },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async create(input) { const rule: CutoffRule = { ...input, id: randomUUID(), updatedAt: stamp() }; rows.push(rule); return rule },
    async update(id, input) { const index = rows.findIndex(row => row.id === id); const current = rows[index]; if (!current) return null; const rule = { ...current, ...input, updatedAt: stamp() }; rows[index] = rule; return rule },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; return row },
    async nameExists(name, excludingId) { return rows.some(row => row.id !== excludingId && row.name.trim().toLowerCase() === name.trim().toLowerCase()) },
    async slotStatuses(slotIds) { return new Map(slots.rows.filter(slot => slotIds.includes(slot.id)).map(slot => [slot.id, slot.status])) },
    async slotStarts(slotIds) { return new Map(slots.rows.filter(slot => slotIds.includes(slot.id)).map(slot => [slot.id, slot.startTime])) },
    async remove(id) { const index = rows.findIndex(item => item.id === id); if (index < 0) return false; rows.splice(index, 1); return true },
    async usage(id) { const names = productsByRule.get(id) ?? []; return [{ label: 'products', count: names.length, examples: names }] },
  }
}

/** Service areas and their PIN codes in memory. Slot statuses come from the fake slot store, like the real query. */
export function createFakeServiceAreaRepository(slots: { rows: DeliverySlot[] }): ServiceAreaRepository & { rows: Array<Omit<ServiceArea, 'pinCount' | 'slotIds'>>; pins: Map<string, Pin[]>; productsByArea: Map<string, string[]>; brokenProducts: Map<string, CoverageType[]> } {
  const rows: Array<Omit<ServiceArea, 'pinCount' | 'slotIds'>> = []
  const pins = new Map<string, Pin[]>()
  const productsByArea = new Map<string, string[]>()
  /** Coverage kinds that would break a product, per area, for tests that pretend products exist. */
  const brokenProducts = new Map<string, CoverageType[]>()
  const stamp = () => new Date().toISOString()
  const pinsOf = (areaId: string) => pins.get(areaId) ?? []
  const withCounts = (area: Omit<ServiceArea, 'pinCount' | 'slotIds'>): ServiceArea => ({ ...area, pinCount: pinsOf(area.id).length, slotIds: [...new Set(pinsOf(area.id).flatMap(pin => pin.allowedDeliverySlotIds))] })
  const sorted = () => [...rows].sort((a, b) => a.name.localeCompare(b.name)).map(withCounts)
  const strip = (input: ServiceAreaInput): Omit<ServiceAreaInput, 'confirmRemovePins'> => ({ name: input.name, description: input.description, coverageType: input.coverageType, state: input.state, city: input.city, status: input.status })
  return {
    rows, pins, productsByArea, brokenProducts,
    async list({ search, status, page, pageSize }) {
      const matches = sorted().filter(area => (!status || area.status === status) && (!search || `${area.name} ${area.city} ${area.state}`.toLowerCase().includes(search.toLowerCase())))
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length }
    },
    async listAll() { return sorted() },
    async findById(id) { const area = rows.find(row => row.id === id); return area ? withCounts(area) : null },
    async create(input) { const area = { ...strip(input), id: randomUUID(), updatedAt: stamp() }; rows.push(area); return withCounts(area) },
    async update(id, input, _adminId, removePins) {
      const index = rows.findIndex(row => row.id === id)
      const current = rows[index]
      if (!current) return null
      rows[index] = { ...current, ...strip(input), updatedAt: stamp() }
      if (removePins) pins.delete(id)
      return withCounts(rows[index] as typeof current)
    },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; return withCounts(row) },
    async nameExists(name, excludingId) { return rows.some(row => row.id !== excludingId && row.name.trim().toLowerCase() === name.trim().toLowerCase()) },
    async remove(id) { const index = rows.findIndex(item => item.id === id); if (index < 0) return false; rows.splice(index, 1); return true },
    async usage(id) { const names = productsByArea.get(id) ?? []; return [{ label: 'products', count: names.length, examples: names }] },
    async countProductsBrokenBy(id, coverage) { return (brokenProducts.get(id) ?? []).filter(kind => kind === coverage).length },
    async listPins(areaId, { search, status, slotId, page, pageSize }) {
      const term = search.toLowerCase()
      const matches = [...pinsOf(areaId)].sort((a, b) => a.pinCode.localeCompare(b.pinCode)).filter(pin => (!status || pin.status === status) && (!slotId || pin.allowedDeliverySlotIds.includes(slotId)) && (!term || `${pin.pinCode} ${pin.locality}`.toLowerCase().includes(term)))
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length }
    },
    async findPin(areaId, pinId) { return pinsOf(areaId).find(pin => pin.id === pinId) ?? null },
    async createPin(areaId, input) { const pin: Pin = { ...input, id: randomUUID() }; pins.set(areaId, [...pinsOf(areaId), pin]); return pin },
    async updatePin(areaId, pinId, input) { const list = pinsOf(areaId); const index = list.findIndex(pin => pin.id === pinId); if (index === -1) return null; const pin: Pin = { ...input, id: pinId }; list[index] = pin; return pin },
    async addPins(areaId, entries, settings) {
      const existing = new Set(pinsOf(areaId).map(pin => pin.pinCode))
      const added = entries.filter(entry => !existing.has(entry.pinCode))
      pins.set(areaId, [...pinsOf(areaId), ...added.map((entry): Pin => ({ id: randomUUID(), pinCode: entry.pinCode, locality: entry.locality, allowedDeliverySlotIds: settings.allowedDeliverySlotIds, status: settings.status }))])
      return added.map(entry => entry.pinCode)
    },
    async pinExists(areaId, pinCode, excludingPinId) { return pinsOf(areaId).some(pin => pin.pinCode === pinCode && pin.id !== excludingPinId) },
    async slotStatuses(slotIds) { return new Map(slots.rows.filter(slot => slotIds.includes(slot.id)).map(slot => [slot.id, slot.status])) },
  }
}

/** Any plain named record (category, trial plan, subscription rule) in memory. `usage` is set by tests to pretend products use a record. */
export function createFakeSimpleRepository<Saved extends { id: string; name: string; status: RecordStatus; updatedAt: string }, Input extends { name: string; status: RecordStatus }>(): SimpleRecordRepository<Saved, Input> & { rows: Saved[]; productsByRecord: Map<string, number> } {
  const rows: Saved[] = []
  const productsByRecord = new Map<string, number>()
  const stamp = () => new Date().toISOString()
  const sorted = () => [...rows].sort((a, b) => a.name.localeCompare(b.name))
  return {
    rows, productsByRecord,
    async list({ search, status, page, pageSize }) {
      const matches = sorted().filter(row => (!status || row.status === status) && (!search || row.name.toLowerCase().includes(search.toLowerCase())))
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length }
    },
    async listAll() { return sorted() },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async create(input) { const row = { ...input, id: randomUUID(), updatedAt: stamp() } as unknown as Saved; rows.push(row); return row },
    async update(id, input) { const index = rows.findIndex(row => row.id === id); const current = rows[index]; if (!current) return null; const row = { ...current, ...input, updatedAt: stamp() }; rows[index] = row; return row },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; return row },
    async nameExists(name, excludingId) { return rows.some(row => row.id !== excludingId && row.name.trim().toLowerCase() === name.trim().toLowerCase()) },
    async remove(id) { const index = rows.findIndex(item => item.id === id); if (index < 0) return false; rows.splice(index, 1); return true },
    async usage(id) { return [{ label: 'products', count: productsByRecord.get(id) ?? 0, examples: [] }] },
  }
}

/** A tiny national PIN directory in memory: two states, a few districts. */
export function createFakePinDirectory(): PinDirectoryRepository {
  const data = [
    { pinCode: '382010', office: 'Sector 10', district: 'Gandhinagar', state: 'Gujarat' },
    { pinCode: '382011', office: 'Sector 11', district: 'Gandhinagar', state: 'Gujarat' },
    { pinCode: '382011', office: 'Sector 11 Colony', district: 'Gandhinagar', state: 'Gujarat' },
    { pinCode: '380001', office: 'Ahmedabad Gpo', district: 'Ahmedabad', state: 'Gujarat' },
    { pinCode: '400001', office: 'Mumbai Gpo', district: 'Mumbai', state: 'Maharashtra' },
  ]
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  return {
    async listStates() { return [...new Set(data.map(row => row.state))].sort() },
    async listDistricts(state) { return [...new Set(data.filter(row => same(row.state, state)).map(row => row.district))].sort() },
    async listPins(state, district, limit) {
      const pins = [...new Set(data.filter(row => same(row.state, state) && same(row.district, district)).map(row => row.pinCode))].sort().slice(0, limit)
      return pins.map(pinCode => ({ pinCode, offices: data.filter(row => row.pinCode === pinCode).map(row => row.office).sort() }))
    },
  }
}

/** Products in memory. Categories, delivery areas, cut-off rules, plans, rules and pictures are read from their fake stores, like the real joins. */
export function createFakeProductRepository(stores: {
  /** How many subscriptions and trials of a product are running; a test wires this to its subscription store. */
  runningPlans?: (productId: string) => number
  categories: { rows: Category[] }; areas: { rows: Array<Pick<ServiceArea, 'id' | 'name' | 'coverageType' | 'status'>> }; cutoffs: { rows: CutoffRule[] }; trialPlans: { rows: TrialPlan[] }; rules: { rows: SubscriptionRule[] }; media: { rows: MediaAsset[] }
}): ProductRepository & { rows: Product[] } {
  const rows: Product[] = []
  const stamp = () => new Date().toISOString()
  const keyOf = (assetId: string | null): StoredImage | null => {
    const asset = stores.media.rows.find(item => item.id === assetId && item.status === 'ready')
    return asset && assetId ? { assetId, key: asset.objectKey } : null
  }
  const build = (id: string, input: ProductInput, current?: Product): Product => {
    const old = new Map((current?.variants ?? []).map(variant => [variant.id, variant]))
    const kept = input.variants.map((variant): ProductVariant => ({ ...variant, id: variant.id ?? randomUUID() }))
    const keptIds = new Set(kept.map(variant => variant.id))
    const dropped = [...old.values()].filter(variant => !keptIds.has(variant.id)).map((variant): ProductVariant => ({ ...variant, status: 'inactive' }))
    const { primaryImageAssetId, galleryAssetIds } = input
    return { ...input, id, updatedAt: stamp(), variants: [...kept, ...dropped], primaryImage: keyOf(primaryImageAssetId), gallery: galleryAssetIds.map(keyOf).filter((image): image is StoredImage => image !== null) }
  }
  const categoryOf = (id: string) => stores.categories.rows.find(item => item.id === id)
  const sorted = () => [...rows].sort((a, b) => a.name.localeCompare(b.name))
  const visible = (product: Product) => product.status === 'active' && categoryOf(product.categoryId)?.status === 'active'
    && stores.areas.rows.find(item => item.id === product.serviceAreaId)?.status === 'active' && product.variants.some(variant => variant.status === 'active')
  const publicOf = (product: Product): PublicProduct => ({
    id: product.id, name: product.name, nameGu: product.nameGu, categoryId: product.categoryId, categoryName: categoryOf(product.categoryId)?.name ?? '', categoryNameGu: categoryOf(product.categoryId)?.nameGu ?? '',
    shortDescriptionEn: product.shortDescriptionEn, shortDescriptionGu: product.shortDescriptionGu, badges: product.badges, purchaseMethods: product.purchaseMethods,
    variants: product.variants.filter(variant => variant.status === 'active'), primaryImage: product.primaryImage,
  })
  return {
    rows,
    async list({ search, status, categoryId, page, pageSize }) {
      const term = search.toLowerCase()
      const matches = sorted().filter(product => (!status || product.status === status) && (!categoryId || product.categoryId === categoryId) && (!term || `${product.name} ${product.nameGu} ${product.sku}`.toLowerCase().includes(term)))
      const summaries = matches.map((product): ProductSummary => {
        const active = product.variants.filter(variant => variant.status === 'active')
        return {
          id: product.id, name: product.name, nameGu: product.nameGu, categoryId: product.categoryId, categoryName: categoryOf(product.categoryId)?.name ?? '', sku: product.sku, status: product.status,
          purchaseMethods: product.purchaseMethods, deliveryMethod: product.deliveryMethod, serviceAreaName: stores.areas.rows.find(item => item.id === product.serviceAreaId)?.name ?? null, excludedFromCredit: product.excludedFromCredit, variantCount: active.length,
          priceFromPaise: active.length ? Math.min(...active.map(variant => variant.pricePaise)) : null, primaryImageKey: product.primaryImage?.key ?? null, updatedAt: product.updatedAt,
        }
      })
      return { rows: summaries.slice((page - 1) * pageSize, page * pageSize), total: summaries.length }
    },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async create(input) { const product = build(randomUUID(), input); rows.push(product); return product },
    async update(id, input) { const index = rows.findIndex(row => row.id === id); const current = rows[index]; if (!current) return null; const product = build(id, input, current); rows[index] = product; return product },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; return row },
    async setExcludedFromCredit(id, excluded) { const row = rows.find(item => item.id === id); if (!row) return null; row.excludedFromCredit = excluded; return row },
    async nameExists(name, excludingId) { return rows.some(row => row.id !== excludingId && row.name.trim().toLowerCase() === name.trim().toLowerCase()) },
    async skuTaken(sku, excludingId) { return rows.some(row => row.id !== excludingId && row.sku !== '' && row.sku.toLowerCase() === sku.toLowerCase()) },
    async variantSkuTaken(skus, excludingProductId) { const wanted = new Set(skus.map(sku => sku.toLowerCase())); return rows.some(row => row.id !== excludingProductId && row.variants.some(variant => variant.sku !== '' && wanted.has(variant.sku.toLowerCase()))) },
    async categoryStatus(id) { return categoryOf(id)?.status ?? null },
    async areaInfo(id) { const area = stores.areas.rows.find(item => item.id === id); return area ? { status: area.status, coverageType: area.coverageType } : null },
    async runningPlanCount(id) { return stores.runningPlans?.(id) ?? 0 },
    async cutoffRuleStatus(id) { return stores.cutoffs.rows.find(item => item.id === id)?.status ?? null },
    async trialPlanStatuses(ids) { return new Map(stores.trialPlans.rows.filter(item => ids.includes(item.id)).map(item => [item.id, item.status])) },
    async ruleStatuses(ids) { return new Map(stores.rules.rows.filter(item => ids.includes(item.id)).map(item => [item.id, item.status])) },
    async readyProductImages(ids) { return new Set(stores.media.rows.filter(item => ids.includes(item.id) && item.purpose === 'product' && item.status === 'ready').map(item => item.id)) },
    async listPublic({ category, search, page, pageSize }) {
      const term = search.toLowerCase()
      const matches = sorted().filter(product => visible(product) && (!category || product.categoryId === category) && (!term || `${product.name} ${product.nameGu} ${product.shortDescriptionEn}`.toLowerCase().includes(term)))
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize).map(publicOf), total: matches.length }
    },
    async findPublic(id) {
      const product = rows.find(row => row.id === id)
      if (!product || !visible(product)) return null
      return {
        ...product, variants: product.variants.filter(variant => variant.status === 'active'), categoryName: categoryOf(product.categoryId)?.name ?? '', categoryNameGu: categoryOf(product.categoryId)?.nameGu ?? '',
        trialPlans: stores.trialPlans.rows.filter(item => product.trialPlanIds.includes(item.id) && item.status === 'active').map(item => ({ id: item.id, name: item.name, durationDays: item.durationDays })),
        subscriptionRules: stores.rules.rows.filter(item => product.subscriptionRuleIds.includes(item.id) && item.status === 'active').map(item => ({ id: item.id, name: item.name, systemType: item.systemType, lengthOptions: item.lengthOptions, minDays: item.minDays, maxDays: item.maxDays })),
      }
    },
  }
}

export function createFakeOnboardingRepository(media: { rows: MediaAsset[] } = { rows: [] }): OnboardingRepository & { rows: Slide[] } {
  const rows: Slide[] = []
  const stamp = () => new Date().toISOString()
  const keyOf = (assetId: string) => media.rows.find(asset => asset.id === assetId && asset.status === 'ready')?.objectKey ?? null
  const sorted = () => [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
  return {
    rows,
    async list() { return sorted() },
    async listActive() { return sorted().filter(row => row.status === 'active') },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async create(input, sortOrder) { const slide: Slide = { ...input, id: randomUUID(), imageKey: keyOf(input.imageAssetId), sortOrder, createdAt: stamp(), updatedAt: stamp() }; rows.push(slide); return slide },
    async update(id, input) { const index = rows.findIndex(row => row.id === id); const current = rows[index]; if (!current) return null; const slide = { ...current, ...input, imageKey: keyOf(input.imageAssetId), updatedAt: stamp() }; rows[index] = slide; return slide },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; return row },
    async countActive(excludingId) { return rows.filter(row => row.status === 'active' && row.id !== excludingId).length },
    async nextSortOrder() { return Math.max(0, ...rows.map(row => row.sortOrder)) + 1 },
    async setOrder(ids) { ids.forEach((id, position) => { const row = rows.find(item => item.id === id); if (row) row.sortOrder = position + 1 }) },
  }
}

export function createFakeBannerRepository(media: { rows: MediaAsset[] } = { rows: [] }): BannerRepository & { rows: Banner[] } {
  const rows: Banner[] = []
  // A picture only shows once its upload is finished, the same as in the real query.
  const keyOf = (assetId: string | null) => media.rows.find(asset => asset.id === assetId && asset.status === 'ready')?.objectKey ?? null
  const withKey = <T extends { imageAssetId: string | null }>(banner: T) => ({ ...banner, imageKey: keyOf(banner.imageAssetId) })
  const stamp = () => new Date().toISOString()
  return {
    rows,
    async list() { return [...rows].sort((a, b) => a.sortOrder - b.sortOrder) },
    async findById(id) { return rows.find(row => row.id === id) ?? null },
    async create(input) { const banner: Banner = { ...withKey(input), id: randomUUID(), createdAt: stamp(), updatedAt: stamp() }; rows.push(banner); return banner },
    async update(id, input) { const index = rows.findIndex(row => row.id === id); const current = rows[index]; if (!current) return null; const banner = { ...current, ...withKey(input), updatedAt: stamp() }; rows[index] = banner; return banner },
    async setStatus(id, status) { const row = rows.find(item => item.id === id); if (!row) return null; row.status = status; return row },
    async listPublic(date) { return rows.filter(row => row.status === 'active' && row.audience === 'all_users' && (!row.startDate || row.startDate <= date) && (!row.endDate || row.endDate >= date)).sort((a, b) => a.sortOrder - b.sortOrder) },
  }
}

/** A whole API wired to in-memory fakes, with a captured login code and audit trail. */

type StoredOrder = AdminOrderView & { idempotencyKey: string; paymentId: string | null; subscriptionLineId: string | null }
/** Mirrors the real list order: orders still to deliver first (nearest delivery on top), then the rest with the latest delivery first. */
const comingFirst = (a: StoredOrder, b: StoredOrder): number => {
  const coming = (order: StoredOrder) => order.status === 'placed' || order.status === 'out_for_delivery'
  if (coming(a) !== coming(b)) return coming(a) ? -1 : 1
  const byDate = coming(a) ? a.deliveryDate.localeCompare(b.deliveryDate) : b.deliveryDate.localeCompare(a.deliveryDate)
  return byDate || b.placedAt.localeCompare(a.placedAt)
}

export type FakeSkip = { subscriptionId: string; lineId: string; date: string; reason: 'customer' | 'admin' | 'order_cancelled' | 'credit_limit' | 'not_deliverable'; createdAt: string }
type LedgerRow = { id: string; customerId: string; type: 'order_charge' | 'order_refund' | 'payment_received' | 'manual_adjustment'; direction: 'debit' | 'credit'; amountPaise: number; orderId: string | null; paymentId: string | null; description: string; createdAt: string }

/**
 * Orders in memory with the same rules as the Postgres version: one customer at a time, credit limit checked together with
 * what is already owed, the same request key never makes a second order, a cancelled order gives the money back (a missed one
 * only when staff return it), and a cancelled subscription delivery becomes a skip.
 */
export function createFakeOrderRepository(stores: { products: { rows: Product[] }; categories: { rows: Category[] }; customers: Map<string, Customer>; now: () => Date; slots?: { rows: Array<{ id: string; name: string; startTime: string; endTime: string }> }; offers?: { rows: Array<{ id: string; status: string; totalLimit: number | null; perCustomerLimit: number | null }>; redemptions: FakeRedemption[] } }) {
  const orders: StoredOrder[] = []
  const ledger: LedgerRow[] = []
  /** Online payments (the payment fake writes them; orders and refunds read them). */
  const payments: OnlinePayment[] = []
  const adjustments: Array<{ id: string; customerId: string; orderId: string | null; paymentId?: string | null; type: 'carry_forward' | 'account_credit' | 'refund_pending' | 'manual_adjustment'; status: 'pending' | 'applied' | 'cancelled'; amountPaise: number; reason: string; dedupeKey: string; createdAt: string }> = []
  const history: Array<{ orderId: string; from: OrderStatus | null; to: OrderStatus; byAdmin: string | null }> = []
  const creditLimits = new Map<string, number>()
  /** Subscription skips (the subscription fake reads and writes the same list). */
  const skips: FakeSkip[] = []
  let counter = 1000
  const owed = (customerId: string) => ledger.filter(row => row.customerId === customerId).reduce((sum, row) => sum + (row.direction === 'debit' ? row.amountPaise : -row.amountPaise), 0)
  const adminView = (order: StoredOrder): AdminOrderView => ({ ...strip(order), customerId: order.customerId, customerName: order.customerName, customerPhone: order.customerPhone })
  /** Like the database version: the window is shown with the slot's name and times as they are now, the saved copy is a fallback. */
  const liveSlot = (slot: StoredOrder['slot']): StoredOrder['slot'] => { const current = slot ? stores.slots?.rows.find(item => item.id === slot.id) : undefined; return slot && current ? { ...slot, name: current.name, startTime: current.startTime, endTime: current.endTime } : slot }
  const strip = ({ idempotencyKey: _key, paymentId: _payment, subscriptionLineId: _line, customerId: _customer, customerName: _name, customerPhone: _phone, ...order }: StoredOrder): OrderView => ({ ...order, slot: liveSlot(order.slot) })

  /** Like the database version: every check happens before anything is written, so a refusal leaves nothing behind. */
  function insertOrders(customerId: string, newOrders: NewOrder[], now: Date, onlinePaymentId: string | null): OrderView[] {
    const customer = stores.customers.get(customerId)
    if (!customer || customer.status !== 'active') throw new AppError(403, 'CUSTOMER_NOT_ACTIVE', 'This account cannot place orders.')
    const creditTotal = newOrders.filter(order => order.payment.method === 'credit').reduce((sum, order) => sum + order.totalPaise, 0)
    if (creditTotal > 0) {
      if (customer.customerType !== 'credit') throw new AppError(409, 'CREDIT_NOT_ENABLED', 'This account does not have credit.')
      const limit = creditLimits.get(customerId) ?? 0
      if (!withinCreditLimit(limit, owed(customerId), creditTotal)) throw new AppError(409, 'CREDIT_LIMIT_EXCEEDED', 'This order is above your credit limit.', { limitPaise: limit, owedPaise: owed(customerId), neededPaise: creditTotal })
    }
    if (newOrders.some(order => orders.some(existing => existing.customerId === customerId && existing.idempotencyKey === order.idempotencyKey))) throw Object.assign(new Error('duplicate key'), { code: '23505' })
    const offerRef = newOrders.find(order => order.offer)?.offer
    if (offerRef && stores.offers) {
      const offer = stores.offers.rows.find(item => item.id === offerRef.id)
      if (!offer || offer.status !== 'active') throw new AppError(409, 'OFFER_NOT_LIVE', 'That offer has ended.')
      const used = stores.offers.redemptions.filter(item => item.offerId === offer.id && item.checkoutKey !== offerRef.checkoutKey)
      if (offer.totalLimit !== null && new Set(used.map(item => item.checkoutKey)).size >= offer.totalLimit) throw new AppError(409, 'OFFER_LIMIT_REACHED', 'That offer has been used up.')
      if (offer.perCustomerLimit !== null && new Set(used.filter(item => item.customerId === customerId).map(item => item.checkoutKey)).size >= offer.perCustomerLimit) throw new AppError(409, 'OFFER_ALREADY_USED', 'You have already used that offer the most times allowed.')
    }
    const placed: StoredOrder[] = []
    for (const order of newOrders) {
      const id = randomUUID()
      const paymentId = order.payment.method === 'online' ? onlinePaymentId : null
      if (order.payment.method === 'online' && !paymentId) throw new Error('An online order needs its confirmed payment.')
      const stored: StoredOrder = {
        id, orderNumber: `SRM-${++counter}`, status: 'placed', deliveryMethod: order.deliveryMethod, deliveryDate: order.deliveryDate, slot: order.slot, orderBy: order.orderBy, cancelBy: order.cancelBy,
        recipientName: order.recipientName, recipientPhone: order.recipientPhone, addressLine1: order.addressLine1, addressLine2: order.addressLine2, landmark: order.landmark, city: order.city, pinCode: order.pinCode, doorstepNote: order.doorstepNote,
        subtotalPaise: order.subtotalPaise, discountPaise: order.discountPaise ?? 0, totalPaise: order.totalPaise, offerTitle: order.offer?.title ?? order.offerLabel?.title ?? '', offerTitleGu: order.offer?.titleGu ?? order.offerLabel?.titleGu ?? '', paymentMethod: order.payment.method, paymentStatus: order.payment.method === 'online' ? 'paid' : 'unpaid',
        placedAt: now.toISOString(), cancelledAt: null, cancelReason: '',
        subscriptionId: order.subscription?.id ?? null, subscriptionLineId: order.subscription?.lineId ?? null, courierName: '', trackingUrl: '', moneyReturnedAt: null,
        items: order.items.map(item => ({ id: randomUUID(), productId: item.productId, variantId: item.variantId, productName: item.productName, productNameGu: item.productNameGu, variantName: item.variantName, purchaseMethod: item.purchaseMethod ?? 'buy_once', unitPricePaise: item.unitPricePaise, quantity: item.quantity, lineTotalPaise: item.lineTotalPaise, isGift: item.isGift ?? false })),
        customerId, customerName: customer.name, customerPhone: customer.phone ?? '', idempotencyKey: order.idempotencyKey, paymentId,
      }
      orders.push(stored)
      placed.push(stored)
      if (order.offer && stores.offers) stores.offers.redemptions.push({ offerId: order.offer.id, customerId, checkoutKey: order.offer.checkoutKey, orderId: id, subscriptionId: null, discountPaise: order.discountPaise ?? 0 })
      history.push({ orderId: id, from: null, to: 'placed', byAdmin: null })
      if (order.payment.method === 'credit') ledger.push({ id: randomUUID(), customerId, type: 'order_charge', direction: 'debit', amountPaise: order.totalPaise, orderId: id, paymentId: null, description: 'Order placed', createdAt: now.toISOString() })
    }
    return placed.sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)).map(strip)
  }

  const repository: OrderRepository = {
    async loadVariants(variantIds) {
      const found: CheckoutVariant[] = []
      for (const product of stores.products.rows) {
        for (const variant of product.variants) {
          if (!variantIds.includes(variant.id)) continue
          found.push({
            variantId: variant.id, variantName: variant.name, pricePaise: variant.pricePaise, variantActive: variant.status === 'active',
            productId: product.id, productName: product.name, productNameGu: product.nameGu, productActive: product.status === 'active', purchaseMethods: product.purchaseMethods,
            categoryActive: stores.categories.rows.find(category => category.id === product.categoryId)?.status === 'active',
            deliveryMethod: product.deliveryMethod, serviceAreaId: product.serviceAreaId, cutoffRuleId: product.cutoffRuleId,
            includeInProductionPlanning: product.includeInProductionPlanning, excludedFromCredit: product.excludedFromCredit,
            productionUnit: variant.productionUnit, productionQuantity: variant.productionQuantity,
          })
        }
      }
      return found
    },
    async customerMoney(customerId) {
      const customer = stores.customers.get(customerId)
      return customer ? { status: customer.status, customerType: customer.customerType, creditLimitPaise: creditLimits.get(customerId) ?? 0, owedPaise: owed(customerId) } : null
    },
    async findByKeyPrefix(customerId, prefix) { return orders.filter(order => order.customerId === customerId && order.idempotencyKey.startsWith(prefix)).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)).map(strip) },
    async placeOrders(customerId, newOrders: NewOrder[], now) { return insertOrders(customerId, newOrders, now, null) },
    async listForCustomer(customerId, { page, pageSize }) {
      const mine = orders.filter(order => order.customerId === customerId).sort(comingFirst)
      return { orders: mine.slice((page - 1) * pageSize, page * pageSize).map(strip), total: mine.length }
    },
    async deliveriesBetween(customerId, from, to) {
      return orders.filter(order => order.customerId === customerId && order.deliveryDate >= from && order.deliveryDate <= to)
        .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || (a.slot?.startTime ?? '99').localeCompare(b.slot?.startTime ?? '99')).map(strip)
    },
    async findForCustomer(customerId, orderId) { const order = orders.find(item => item.id === orderId && item.customerId === customerId); return order ? strip(order) : null },
    async adminList({ search, status, date, slotId, source, productId, payment, page, pageSize }) {
      const term = search.toLowerCase()
      const kindOf = (order: StoredOrder) => (!order.subscriptionId ? 'one_time' : order.items.some(item => item.purchaseMethod === 'trial') ? 'trial' : 'subscription')
      const anyType = orders.filter(order => (!date || order.deliveryDate === date) && (!slotId || order.slot?.id === slotId)
        && (!productId || order.items.some(item => item.productId === productId)) && (!payment || order.paymentMethod === payment)
        && (!term || `${order.orderNumber} ${order.recipientName} ${order.pinCode} ${order.customerPhone}`.toLowerCase().includes(term)))
      const filtered = anyType.filter(order => !source || kindOf(order) === source)
      const counts = { placed: 0, out_for_delivery: 0, delivered: 0, missed: 0, cancelled: 0 } as Record<OrderStatus, number>
      for (const order of filtered) counts[order.status] += 1
      const typeCounts = { one_time: 0, subscription: 0, trial: 0 }
      for (const order of anyType) typeCounts[kindOf(order)] += 1
      const matches = filtered.filter(order => !status || order.status === status).sort(comingFirst)
      return { rows: matches.slice((page - 1) * pageSize, page * pageSize).map(order => adminView(order)), total: matches.length, counts, typeCounts }
    },
    async adminFind(orderId) {
      const order = orders.find(item => item.id === orderId)
      if (!order) return null
      const payment = payments.find(item => item.id === order.paymentId)
      return {
        ...adminView(order),
        onlinePayment: payment ? {
          id: payment.id, merchantOrderId: payment.merchantOrderId, providerOrderId: payment.providerOrderId, providerTransactionId: payment.providerTransactionId, status: payment.status,
          amountPaise: payment.amountPaise, paidAt: payment.paidAt, mode: payment.method?.mode ?? null, instrument: payment.method?.instrument || null, bank: payment.method?.bank || null, bankReference: payment.method?.bankReference || null,
        } : null,
      }
    },
    async changeStatus(orderId, to, { actor, note, reason, ownedBy }, now) {
      const order = orders.find(item => item.id === orderId && (!ownedBy || item.customerId === ownedBy))
      if (!order) return null
      const from = order.status
      // The customer's own cancel rule is checked here, in the same step that changes the status, as the real database version does.
      if ('customer' in actor && to === 'cancelled' && !customerCanCancel(order, now)) throw new AppError(409, 'CANCEL_NOT_ALLOWED', 'This order can no longer be cancelled. Please contact support.')
      if (!canTransition(order.status, to)) throw new AppError(409, 'INVALID_STATUS_STEP', `An order that is ${order.status.replaceAll('_', ' ')} cannot become ${to.replaceAll('_', ' ')}.`)
      const adminId = 'adminId' in actor ? actor.adminId : null
      order.status = to
      if (to === 'cancelled') { order.cancelledAt = now.toISOString(); order.cancelReason = reason }
      history.push({ orderId, from, to, byAdmin: adminId })
      void note
      if (to === 'cancelled' && order.subscriptionId && order.subscriptionLineId && !skips.some(skip => skip.lineId === order.subscriptionLineId && skip.date === order.deliveryDate)) {
        skips.push({ subscriptionId: order.subscriptionId, lineId: order.subscriptionLineId, date: order.deliveryDate, reason: 'customer' in actor ? 'customer' : 'order_cancelled', createdAt: now.toISOString() })
      }
      if (releasesMoney(to)) {
        if (order.paymentMethod === 'credit') ledger.push({ id: randomUUID(), customerId: order.customerId, type: 'order_refund', direction: 'credit', amountPaise: order.totalPaise, orderId, paymentId: null, description: `Order ${order.orderNumber} ${to}`, createdAt: now.toISOString() })
        else if (order.paymentStatus === 'paid' && !order.subscriptionId && !adjustments.some(item => item.dedupeKey === `order-release:${orderId}`)) adjustments.push({ id: randomUUID(), customerId: order.customerId, orderId, type: 'refund_pending', status: 'pending', amountPaise: order.totalPaise, reason: `Order ${order.orderNumber} ${to}: refund the payment in PhonePe, then record it.`, dedupeKey: `order-release:${orderId}`, createdAt: now.toISOString() })
      }
      return strip(order)
    },
    async returnMoney(orderId, { adminId, reason }, now) {
      const order = orders.find(item => item.id === orderId)
      if (!order) return null
      if (!canReturnMoney(order.status)) throw new AppError(409, 'RETURN_NOT_ALLOWED', 'Money can be returned only for a missed or delivered order.')
      if (order.moneyReturnedAt) throw new AppError(409, 'MONEY_ALREADY_RETURNED', 'The money for this order was already returned.')
      if (order.paymentMethod === 'credit') ledger.push({ id: randomUUID(), customerId: order.customerId, type: 'order_refund', direction: 'credit', amountPaise: order.totalPaise, orderId, paymentId: null, description: `Order ${order.orderNumber}: credited by staff (${reason})`, createdAt: now.toISOString() })
      else if (order.paymentStatus === 'paid' || order.paymentStatus === 'partially_refunded') {
        if (!adjustments.some(item => item.dedupeKey === `order-return:${orderId}`)) adjustments.push({ id: randomUUID(), customerId: order.customerId, orderId, paymentId: order.paymentId, type: 'refund_pending', status: 'pending', amountPaise: order.totalPaise, reason: `Order ${order.orderNumber}: ${reason}. Refund it in PhonePe, then record it.`, dedupeKey: `order-return:${orderId}`, createdAt: now.toISOString() })
      } else throw new AppError(409, 'NOTHING_TO_RETURN', 'This order has no payment to return.')
      order.moneyReturnedAt = now.toISOString()
      history.push({ orderId, from: order.status, to: order.status, byAdmin: adminId })
      return strip(order)
    },
    async setCourier(orderId, { courierName, trackingUrl }) {
      const order = orders.find(item => item.id === orderId)
      if (!order) return null
      if (order.deliveryMethod !== 'shipping') throw new AppError(409, 'NOT_A_COURIER_ORDER', 'Only courier orders have a courier and tracking link.')
      order.courierName = courierName
      order.trackingUrl = trackingUrl
      return strip(order)
    },
  }
  return { repository, insertOrders, orders, ledger, payments, adjustments, history, creditLimits, skips }
}


/** Credit accounts in memory, reading and writing the same ledger the fake orders use, so an order and a payment add up together. */
export function createFakeCreditRepository(stores: { orders: ReturnType<typeof createFakeOrderRepository>; customers: Map<string, Customer>; now: () => Date }) {
  const requests: Array<{ id: string; customerId: string; amountPaise: number; note: string; status: 'open' | 'paid' | 'cancelled'; createdAt: string; closedAt: string | null }> = []
  const manualPayments: Array<{ customerId: string; amountPaise: number; method: string; recordedBy: string; paymentId: string }> = []
  const owed = (customerId: string) => stores.orders.ledger.filter(row => row.customerId === customerId).reduce((sum, row) => sum + (row.direction === 'debit' ? row.amountPaise : -row.amountPaise), 0)
  const accountOf = (customerId: string): CreditAccount | null => {
    const customer = stores.customers.get(customerId)
    if (!customer) return null
    const limit = stores.orders.creditLimits.get(customerId) ?? 0
    const paid = stores.orders.ledger.filter(row => row.customerId === customerId && row.type === 'payment_received').map(row => row.createdAt).sort().at(-1) ?? null
    return { customerId, name: customer.name, phone: customer.phone ?? '', customerType: customer.customerType, status: customer.status, limitPaise: limit, owedPaise: owed(customerId), remainingPaise: Math.max(0, limit - owed(customerId)), lastPaymentAt: paid }
  }
  const push = (row: Omit<LedgerRow, 'id' | 'createdAt'>) => stores.orders.ledger.push({ ...row, id: randomUUID(), createdAt: stores.now().toISOString() })
  const view = (request: (typeof requests)[number]): PaymentRequest => ({ ...request })

  const repository: CreditRepository = {
    async listAccounts({ search, owingOnly, page, pageSize }) {
      const term = search.toLowerCase()
      const all = [...stores.customers.keys()].map(accountOf).filter((account): account is CreditAccount => account !== null && account.customerType === 'credit' && account.status !== 'deleted'
        && (!term || `${account.name} ${account.phone}`.toLowerCase().includes(term)) && (!owingOnly || account.owedPaise > 0)).sort((a, b) => b.owedPaise - a.owedPaise || a.name.localeCompare(b.name))
      return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
    },
    async getAccount(customerId) { return accountOf(customerId) },
    async ledger(customerId, { page, pageSize }) {
      let balance = 0
      const entries = stores.orders.ledger.filter(row => row.customerId === customerId).map((row): LedgerEntry => {
        balance += row.direction === 'debit' ? row.amountPaise : -row.amountPaise
        return { id: row.id, entryType: row.type, direction: row.direction, amountPaise: row.amountPaise, orderId: row.orderId, orderNumber: stores.orders.orders.find(order => order.id === row.orderId)?.orderNumber ?? null, paymentId: row.paymentId, description: row.description, occurredOn: row.createdAt.slice(0, 10), createdAt: row.createdAt, balancePaise: balance }
      }).reverse()
      return { rows: entries.slice((page - 1) * pageSize, page * pageSize), total: entries.length }
    },
    async setLimit(customerId, limitPaise) {
      if (stores.customers.get(customerId)?.customerType !== 'credit') return null
      stores.orders.creditLimits.set(customerId, limitPaise)
      return accountOf(customerId)
    },
    async recordPayment(customerId, { amountPaise, method, note, paymentRequestId }, adminId) {
      if (amountPaise > owed(customerId)) throw new AppError(409, 'PAYMENT_EXCEEDS_BALANCE', 'That is more than the customer owes.', { owedPaise: owed(customerId) })
      const paymentId = randomUUID()
      manualPayments.push({ customerId, amountPaise, method, recordedBy: adminId, paymentId })
      push({ customerId, type: 'payment_received', direction: 'credit', amountPaise, orderId: null, paymentId, description: note || `Payment received (${method})` })
      const request = requests.find(item => item.id === paymentRequestId && item.customerId === customerId && item.status === 'open')
      if (request) { request.status = 'paid'; request.closedAt = stores.now().toISOString() }
      return accountOf(customerId) as CreditAccount
    },
    async addAdjustment(customerId, { direction, amountPaise, description }) {
      if (direction === 'credit' && amountPaise > owed(customerId)) throw new AppError(409, 'ADJUSTMENT_EXCEEDS_BALANCE', 'That is more than the customer owes.', { owedPaise: owed(customerId) })
      push({ customerId, type: 'manual_adjustment', direction, amountPaise, orderId: null, paymentId: null, description })
      return accountOf(customerId) as CreditAccount
    },
    async createRequest(customerId, { amountPaise, note }) {
      const request = { id: randomUUID(), customerId, amountPaise, note, status: 'open' as const, createdAt: stores.now().toISOString(), closedAt: null }
      requests.push(request)
      return view(request)
    },
    async listOpenRequests(customerId) { return requests.filter(item => item.customerId === customerId && item.status === 'open').map(view) },
    async cancelRequest(customerId, requestId, now) {
      const request = requests.find(item => item.id === requestId && item.customerId === customerId && item.status === 'open')
      if (!request) return null
      request.status = 'cancelled'; request.closedAt = now.toISOString()
      return view(request)
    },
  }
  return { repository, requests, manualPayments }
}


/** Prepaid adjustments in memory, sharing the "refund pending" notes that cancelled orders create. */
export function createFakeAdjustmentRepository(stores: { orders: ReturnType<typeof createFakeOrderRepository>; customers: Map<string, Customer>; now: () => Date }) {
  const refunds: Array<{ orderId: string | null; paymentId: string | null; amountPaise: number; providerReference: string; recordedBy: string }> = []
  const view = (row: (typeof stores.orders.adjustments)[number]): Adjustment => {
    const customer = stores.customers.get(row.customerId)
    return {
      id: row.id, customerId: row.customerId, customerName: customer?.name ?? '', customerPhone: customer?.phone ?? '', orderId: row.orderId, orderNumber: stores.orders.orders.find(order => order.id === row.orderId)?.orderNumber ?? null,
      type: row.type, status: row.status, amountPaise: row.amountPaise, quantity: null, productName: null, variantName: null, reason: row.reason, effectiveDate: row.createdAt.slice(0, 10), createdAt: row.createdAt,
    }
  }
  const repository: AdjustmentRepository = {
    async list({ search, status, type, page, pageSize }) {
      const term = search.toLowerCase()
      const all = stores.orders.adjustments.map(view).filter(row => (!status || row.status === status) && (!type || row.type === type) && (!term || `${row.customerName} ${row.customerPhone} ${row.orderNumber ?? ''}`.toLowerCase().includes(term)))
        .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt))
      return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
    },
    async create({ customerId, type, amountPaise, reason }) {
      if (!stores.customers.has(customerId)) return null
      const row = { id: randomUUID(), customerId, orderId: null, type, status: 'pending' as const, amountPaise, reason, dedupeKey: `manual:${randomUUID()}`, createdAt: stores.now().toISOString() }
      stores.orders.adjustments.push(row)
      return view(row)
    },
    async apply(id, { providerReference }, adminId) {
      const row = stores.orders.adjustments.find(item => item.id === id)
      if (!row) return null
      if (row.status !== 'pending') throw new AppError(409, 'ADJUSTMENT_NOT_PENDING', 'This adjustment is already done or cancelled.')
      const order = stores.orders.orders.find(item => item.id === row.orderId)
      const paymentId = row.paymentId ?? order?.paymentId ?? null
      if (row.type === 'refund_pending' && paymentId) {
        refunds.push({ orderId: order?.id ?? null, paymentId, amountPaise: row.amountPaise, providerReference, recordedBy: adminId })
        const payment = stores.orders.payments.find(item => item.id === paymentId)
        const refunded = refunds.filter(item => item.paymentId === paymentId).reduce((sum, item) => sum + item.amountPaise, 0)
        const state = payment && refunded < payment.amountPaise ? 'partially_refunded' : 'refunded'
        if (payment) payment.status = state
        if (order) order.paymentStatus = state
      }
      row.status = 'applied'
      return view(row)
    },
    async cancel(id) {
      const row = stores.orders.adjustments.find(item => item.id === id && item.status === 'pending')
      if (!row) return null
      row.status = 'cancelled'
      return view(row)
    },
  }
  return { repository, refunds }
}


/**
 * Online payments in memory, following the database version's rules: settling happens once per payment (a JavaScript step with
 * no await inside is as atomic as the row lock), a refused order or a wrong amount becomes a "refund pending" item, and a
 * request payment never credits more than is owed.
 */
export function createFakePaymentRepository(stores: { orders: ReturnType<typeof createFakeOrderRepository>; credit: ReturnType<typeof createFakeCreditRepository>; customers: Map<string, Customer>; now: () => Date; subscriptions?: ReturnType<typeof createFakeSubscriptionRepository> }) {
  const rows = stores.orders.payments
  const activity: Array<{ paymentId: string; kind: ActivityKind; detail: Record<string, unknown> }> = []
  const events: Array<{ id: string; eventId: string; processed: boolean; paymentId: string | null }> = []
  const act = (paymentId: string, kind: ActivityKind, detail: Record<string, unknown> = {}) => { activity.push({ paymentId, kind, detail }) }
  const copy = (row: OnlinePayment): OnlinePayment => ({ ...row })
  const owed = (customerId: string) => stores.orders.ledger.filter(row => row.customerId === customerId).reduce((sum, row) => sum + (row.direction === 'debit' ? row.amountPaise : -row.amountPaise), 0)
  const refundDue = (payment: OnlinePayment, amountPaise: number, code: string, markPayment: boolean, now: Date) => {
    const dedupeKey = `payment-refund:${payment.id}`
    if (!stores.orders.adjustments.some(item => item.dedupeKey === dedupeKey)) {
      stores.orders.adjustments.push({ id: randomUUID(), customerId: payment.customerId, orderId: null, paymentId: payment.id, type: 'refund_pending', status: 'pending', amountPaise, reason: `Refund needed (${code})`, dedupeKey, createdAt: now.toISOString() })
    }
    if (markPayment) payment.fulfilment = 'refund_due'
    act(payment.id, 'refund_due', { code, amountPaise })
  }
  const withoutInternals = ({ snapshot: _snapshot, idempotencyKey: _key, ...rest }: OnlinePayment) => rest
  const adminRow = (row: OnlinePayment): AdminPaymentRow => {
    const customer = stores.customers.get(row.customerId)
    return { ...withoutInternals(row), customerName: customer?.name ?? '', customerPhone: customer?.phone ?? '' }
  }

  const repository: PaymentRepository = {
    async createPending(input) {
      const existing = rows.find(row => row.customerId === input.customerId && row.idempotencyKey === input.idempotencyKey)
      if (existing) return { payment: copy(existing), created: false }
      const row: OnlinePayment = {
        id: randomUUID(), customerId: input.customerId, purpose: input.purpose, amountPaise: input.amountPaise, status: 'pending', fulfilment: 'none',
        merchantOrderId: input.merchantOrderId, providerOrderId: null, providerTransactionId: null, idempotencyKey: input.idempotencyKey,
        paymentRequestId: input.paymentRequestId, expiresAt: input.expiresAt.toISOString(), failureReason: '', createdAt: stores.now().toISOString(), paidAt: null, method: null,
        snapshot: JSON.parse(JSON.stringify(input.snapshot)),
      }
      rows.push(row)
      act(row.id, 'started', { amountPaise: input.amountPaise })
      return { payment: copy(row), created: true }
    },
    async findByIdempotencyKey(customerId, key) { const row = rows.find(item => item.customerId === customerId && item.idempotencyKey === key); return row ? copy(row) : null },
    async findByMerchantOrderId(id) { const row = rows.find(item => item.merchantOrderId === id); return row ? copy(row) : null },
    async findById(id) { const row = rows.find(item => item.id === id); return row ? copy(row) : null },
    async recordProviderOrder(paymentId, providerOrderId, expiresAt) {
      const row = rows.find(item => item.id === paymentId)
      if (row) { row.providerOrderId = providerOrderId; if (expiresAt) row.expiresAt = expiresAt.toISOString() }
      act(paymentId, 'provider_order_created', { providerOrderId })
    },
    async addActivity(paymentId, kind, detail = {}) { act(paymentId, kind, detail) },
    async markFailed(paymentId, reason, detail = {}) {
      const row = rows.find(item => item.id === paymentId)
      if (!row || row.status !== 'pending') return false
      row.status = 'failed'; row.failureReason = reason
      act(paymentId, 'failed', { reason, ...detail })
      return true
    },
    async settle(paymentId, completion, now) {
      const row = rows.find(item => item.id === paymentId)
      if (!row || row.status !== 'pending') return { changed: false }
      row.status = 'paid'; row.paidAt = now.toISOString(); row.providerTransactionId = completion.transactionId; row.providerOrderId ??= completion.providerOrderId; row.method = completion.method
      act(row.id, 'paid', { source: completion.source })
      if (completion.reportedAmountPaise !== null && completion.reportedAmountPaise !== row.amountPaise) {
        refundDue(row, completion.reportedAmountPaise, 'AMOUNT_MISMATCH', true, now)
      } else if (row.purpose === 'order') {
        const snapshot = row.snapshot as OrderSnapshot | null
        if (snapshot?.kind !== 'order' || !Array.isArray(snapshot.orders) || snapshot.orders.length === 0) {
          refundDue(row, row.amountPaise, 'SNAPSHOT_INVALID', true, now)
        } else {
          try {
            const placed = stores.orders.insertOrders(row.customerId, snapshot.orders, now, row.id)
            row.fulfilment = 'fulfilled'
            act(row.id, 'fulfilled', { orderNumbers: placed.map(order => order.orderNumber) })
          } catch (error) {
            if (!(error instanceof AppError)) throw error
            refundDue(row, row.amountPaise, error.code, true, now)
          }
        }
      } else if (row.purpose === 'subscription') {
        const snapshot = row.snapshot as Partial<SubscriptionSnapshot> | null
        if (snapshot?.kind !== 'subscription' || !snapshot.draft || !stores.subscriptions) refundDue(row, row.amountPaise, 'SNAPSHOT_INVALID', true, now)
        else {
          try {
            const subscriptionId = stores.subscriptions.insert(snapshot.draft, row.id)
            row.fulfilment = 'fulfilled'
            act(row.id, 'fulfilled', { subscriptionId })
          } catch (error) {
            const code = error instanceof AppError ? error.code : typeof error === 'object' && error !== null && 'code' in error ? `DB_${String((error as { code: unknown }).code)}` : null
            if (!code) throw error
            refundDue(row, row.amountPaise, code, true, now)
          }
        }
      } else {
        const credited = Math.min(row.amountPaise, Math.max(0, owed(row.customerId)))
        if (credited > 0) stores.orders.ledger.push({ id: randomUUID(), customerId: row.customerId, type: 'payment_received', direction: 'credit', amountPaise: credited, orderId: null, paymentId: row.id, description: 'Paid online (PhonePe)', createdAt: now.toISOString() })
        const request = stores.credit.requests.find(item => item.id === row.paymentRequestId && item.status === 'open')
        if (request) { request.status = 'paid'; request.closedAt = now.toISOString() }
        const excess = row.amountPaise - credited
        if (excess > 0) refundDue(row, excess, 'MORE_THAN_OWED', credited === 0, now)
        if (credited > 0) { row.fulfilment = 'fulfilled'; act(row.id, 'fulfilled', { creditedPaise: credited }) }
      }
      return { changed: true, fulfilment: row.fulfilment }
    },
    async subscriptionOf(paymentId) {
      const found = stores.subscriptions?.subscriptions.find(item => item.paymentId === paymentId)
      return found ? { id: found.id, number: found.number } : null
    },
    async listPending(after, before, limit) {
      return rows.filter(row => row.status === 'pending' && Date.parse(row.createdAt) > after.getTime() && Date.parse(row.createdAt) < before.getTime()).slice(0, limit).map(copy)
    },
    async recordWebhook({ eventId, paymentId }) {
      const existing = events.find(item => item.eventId === eventId)
      if (existing) return { id: existing.id, alreadyProcessed: existing.processed }
      const event = { id: randomUUID(), eventId, processed: false, paymentId }
      events.push(event)
      return { id: event.id, alreadyProcessed: false }
    },
    async markWebhookProcessed(id) { const event = events.find(item => item.id === id); if (event) event.processed = true },
    async adminList({ status, purpose, search, page, pageSize }) {
      const term = search.toLowerCase()
      const all = rows.map(adminRow).filter(row => (!status || row.status === status) && (!purpose || row.purpose === purpose)
        && (!term || `${row.customerName} ${row.customerPhone} ${row.merchantOrderId} ${row.providerTransactionId ?? ''}`.toLowerCase().includes(term))).reverse()
      return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
    },
    async adminFind(id) {
      const row = rows.find(item => item.id === id)
      if (!row) return null
      return {
        ...adminRow(row),
        activity: activity.filter(item => item.paymentId === id).map(item => ({ kind: item.kind, detail: item.detail, createdAt: row.createdAt })),
        orders: stores.orders.orders.filter(order => order.paymentId === id).map(order => ({ id: order.id, orderNumber: order.orderNumber, status: order.status, totalPaise: order.totalPaise })),
        refunds: [],
        refundDue: stores.orders.adjustments.filter(item => item.paymentId === id).map(item => ({ id: item.id, amountPaise: item.amountPaise, status: item.status, reason: item.reason })),
      }
    },
  }
  return { repository, payments: rows, activity, events }
}

/**
 * PhonePe for tests. By default a payment completes at once for the amount asked (like the development test gateway); a test can
 * hold it pending, fail it, report a different amount, or make PhonePe unreachable.
 */
export function createFakeGateway() {
  const checkouts = new Map<string, { amountPaise: number; state: GatewayState; reportedAmountPaise: number | null; errorCode: string }>()
  const control = { autoComplete: true, createFails: false, statusFails: false, statusCalls: 0, createCalls: 0, webhookAuthorization: 'genuine-phonepe-hash' }
  const gateway: PaymentGateway = {
    sdk: { environment: 'SANDBOX', merchantId: 'MTESTMERCHANT' },
    async createCheckout({ merchantOrderId, amountPaise }) {
      control.createCalls += 1
      if (control.createFails) throw new PaymentGatewayError('PhonePe could not be reached.')
      checkouts.set(merchantOrderId, { amountPaise, state: control.autoComplete ? 'COMPLETED' : 'PENDING', reportedAmountPaise: amountPaise, errorCode: '' })
      return { providerOrderId: `OMO-${merchantOrderId}`, token: `order-token-${merchantOrderId}`, expiresAt: null }
    },
    async fetchStatus(merchantOrderId) {
      control.statusCalls += 1
      if (control.statusFails) throw new PaymentGatewayError('PhonePe timed out.')
      const checkout = checkouts.get(merchantOrderId)
      if (!checkout) throw new PaymentGatewayError('PhonePe status check failed (HTTP 404).', 404)
      return { state: checkout.state, amountPaise: checkout.reportedAmountPaise, providerOrderId: `OMO-${merchantOrderId}`, transactionId: checkout.state === 'PENDING' ? null : `TXN-${merchantOrderId}`, errorCode: checkout.errorCode,
        method: checkout.state === 'COMPLETED' ? { mode: 'UPI_INTENT', instrument: 'ACCOUNT', bank: '', bankReference: `UTR-${merchantOrderId.slice(-6)}` } : null }
    },
    verifyWebhook: authorization => authorization === control.webhookAuthorization,
  }
  /** Changes what PhonePe will say about a payment. */
  const set = (merchantOrderId: string, change: Partial<{ state: GatewayState; reportedAmountPaise: number | null; errorCode: string }>) => {
    const checkout = checkouts.get(merchantOrderId)
    if (!checkout) throw new Error(`No checkout ${merchantOrderId}`)
    Object.assign(checkout, change)
  }
  return { gateway, checkouts, control, set }
}

export async function createTestApi(options: { clock?: ReturnType<typeof createClock>; withAdmin?: boolean } = {}) {
  const clock = options.clock ?? createClock()
  const auth = createFakeAuthRepository()
  const mediaRepository = createFakeMediaRepository()
  const storage = createFakeStorage()
  const bannersRepository = createFakeBannerRepository(mediaRepository)
  const onboardingRepository = createFakeOnboardingRepository(mediaRepository)
  const settingsRepository = createFakeAppSettingsRepository()
  const helpRepository = createFakeHelpRepository()
  const policyRepository = createFakePolicyRepository()
  const deliverySlotRepository = createFakeDeliverySlotRepository()
  const cutoffRuleRepository = createFakeCutoffRuleRepository(deliverySlotRepository)
  deliverySlotRepository.sameDayRules = (slotId, startTime) => cutoffRuleRepository.rows.filter(rule => rule.conditions.some(condition => condition.deliverySlotId === slotId && condition.dayRelation === 'same_day' && condition.cutoffTime > startTime)).map(rule => rule.name).sort()
  const serviceAreaRepository = createFakeServiceAreaRepository(deliverySlotRepository)
  const categoryRepository = createFakeSimpleRepository<Category, CategoryInput>()
  const trialPlanRepository = createFakeSimpleRepository<TrialPlan, TrialPlanInput>()
  const subscriptionRuleRepository = createFakeSimpleRepository<SubscriptionRule, SubscriptionRuleInput>()
  const productRepository = createFakeProductRepository({ runningPlans: productId => subscriptionStore.subscriptions.filter(item => item.productId === productId && item.status === 'active').length, categories: categoryRepository, areas: serviceAreaRepository, cutoffs: cutoffRuleRepository, trialPlans: trialPlanRepository, rules: subscriptionRuleRepository, media: mediaRepository })
  const audit: AuditEntry[] = []
  const customerAuth = createFakeCustomerAuthRepository(clock.now)
  const addressStore = createFakeCustomerAddressRepository()
  // Stands in for the delivery check: these PINs are served, every other PIN is not.
  const servedPins = new Set(['382010', '110001'])
  const notificationStore = createFakeNotificationStore({ customers: customerAuth.customers, now: clock.now })
  const notificationService = createNotificationService({ repository: notificationStore.repository, sender: notificationStore.sender, audit: async entry => { audit.push(entry) } })
  const notifier = notificationService.notifier
  const supportStore = createFakeSupportTicketRepository({ customers: customerAuth.customers, admins: auth.admins, now: clock.now })
  const sentCustomerCodes: Array<{ email: string; code: string }> = []
  const customerCodeSender: CustomerCodeSender = { channel: 'console', async sendCode(email, code) { sentCustomerCodes.push({ email, code }) } }
  const sentCodes: Array<{ email: string; code: string }> = []
  const sender: CodeSender = { async sendLoginCode(email, code) { sentCodes.push({ email, code }) } }
  const auditWriter = async (entry: AuditEntry) => { audit.push(entry) }
  const authService = createAuthService({ repository: auth.repository, sender, audit: auditWriter, secret: SECRET, now: clock.now })
  const customerAuthService = createCustomerAuthService({ repository: customerAuth.repository, sender: customerCodeSender, secret: SECRET, now: clock.now })
  const customerAddressService = createCustomerAddressService({ repository: addressStore.repository, delivery: { servedOptions: async pin => (servedPins.has(pin) ? [{ optionId: 'option', name: 'Local', deliveryMethod: 'local_delivery', locality: '', slots: [] }] : []) } })
  const supportService = createSupportTicketService({ repository: supportStore.repository, audit: auditWriter, now: clock.now })
  const mediaService = createMediaService({ repository: mediaRepository, storage, audit: auditWriter, now: clock.now })
  const bannerService = createBannerService({ repository: bannersRepository, audit: auditWriter, storage, media: mediaService, now: clock.now })
  const onboardingService = createOnboardingService({ repository: onboardingRepository, audit: auditWriter, storage, media: mediaService })
  const helpService = createHelpService({ repository: helpRepository, audit: auditWriter })
  const policyService = createPolicyService({ repository: policyRepository, audit: auditWriter })
  const deliverySlotService = createDeliverySlotService({ repository: deliverySlotRepository, audit: auditWriter })
  const cutoffRuleService = createCutoffRuleService({ repository: cutoffRuleRepository, audit: auditWriter })
  const serviceAreaService = createServiceAreaService({ repository: serviceAreaRepository, audit: auditWriter })
  const categoryService = createCategoryService({ repository: categoryRepository, audit: auditWriter })
  const trialPlanService = createTrialPlanService({ repository: trialPlanRepository, audit: auditWriter })
  const subscriptionRuleService = createSubscriptionRuleService({ repository: subscriptionRuleRepository, audit: auditWriter })
  const productService = createProductService({ repository: productRepository, audit: auditWriter, storage })
  const offerStore = createFakeOfferRepository(clock.now)
  const orderStore = createFakeOrderRepository({ products: productRepository, categories: categoryRepository, customers: customerAuth.customers, now: clock.now, slots: deliverySlotRepository, offers: offerStore })
  /** What the delivery check says for each product. A test sets it; a product with no entry is "not deliverable". */
  const deliveryAnswers = new Map<string, DeliveryCheck>()
  const creditStore = createFakeCreditRepository({ orders: orderStore, customers: customerAuth.customers, now: clock.now })
  const subscriptionStore = createFakeSubscriptionRepository({ orders: orderStore, customers: customerAuth.customers, now: clock.now, slots: deliverySlotRepository, products: productRepository, rules: subscriptionRuleRepository, trialPlans: trialPlanRepository, offers: offerStore })
  const paymentStore = createFakePaymentRepository({ orders: orderStore, credit: creditStore, customers: customerAuth.customers, now: clock.now, subscriptions: subscriptionStore })
  const phonePe = createFakeGateway()
  const paymentService = createPaymentService({ repository: paymentStore.repository, gateway: phonePe.gateway, orders: orderStore.repository, now: clock.now, onSubscriptionStarted: id => subscriptionService.syncNow(id), onOrdersPlaced: (customerId, placed) => orderService.announcePlaced(customerId, placed) })
  const creditService = createCreditService({ repository: creditStore.repository, audit: auditWriter, now: clock.now, payments: paymentService, notifier })
  const adjustmentStore = createFakeAdjustmentRepository({ orders: orderStore, customers: customerAuth.customers, now: clock.now })
  const adjustmentService = createAdjustmentService({ repository: adjustmentStore.repository, audit: auditWriter, now: clock.now, notifier })
  /** The demand a test wants production planning to see. */
  const productionDemand: { rows: DemandRow[]; closings: SlotClosing[] } = { rows: [], closings: [] }
  const productionPlanService = createProductionPlanService({ repository: { demandFor: async () => productionDemand }, now: clock.now })
  const offerService = createOfferService({ repository: offerStore.repository, audit: auditWriter, now: clock.now })
  const orderService = createOrderService({
    repository: orderStore.repository, addresses: addressStore.repository, audit: auditWriter, now: clock.now, payments: paymentService, notifier, offers: offerService,
    delivery: { check: async (_pin: string, productId: string) => deliveryAnswers.get(productId) ?? { served: false, reason: 'NOT_SERVED' as const } },
  })
  /** The slots and cut-offs a test wants each product to have at every served PIN. A product with no entry is "not deliverable". */
  const slotRuleAnswers = new Map<string, SlotRules>()
  const subscriptionService = createSubscriptionService({
    repository: subscriptionStore.repository, orders: orderStore.repository, addresses: addressStore.repository, audit: auditWriter, now: clock.now, payments: paymentService, notifier, offers: offerService,
    delivery: { slotRules: async (_pin: string, productId: string) => slotRuleAnswers.get(productId) ?? { served: false, reason: 'NOT_SERVED' as const } },
  })
  const settingsService = createAppSettingsService({ repository: settingsRepository, audit: auditWriter })
  /** The dashboard's numbers come from SQL roll-ups; tests check the days it asks for and what it hands on. */
  const dashboardCalls: Array<{ today: string; tomorrow: string }> = []
  const dashboardRepository: DashboardRepository = {
    async summary(today, tomorrow) {
      dashboardCalls.push({ today, tomorrow })
      return {
        deliveries: { today: { placed: 3, out_for_delivery: 1, delivered: 2, missed: 0, cancelled: 1 }, todayTotal: 6, tomorrowTotal: 9 },
        plans: { subscriptions: 4, trials: 2 },
        money: { owedPaise: 125_000, owingCustomers: 3, refundsToSend: 1, refundsToSendPaise: 7000, paidOnlineTodayPaise: 21_000 },
        customers: { active: 40, newThisWeek: 5 },
        attention: { creditLimitSkips: 1, overdueOrders: 0, openTickets: 2 },
      }
    },
  }
  const dashboardService = createDashboardService({ repository: dashboardRepository, now: clock.now })
  const admin = options.withAdmin === false ? undefined : await auth.addAdmin()
  const allowedOrigins = [ADMIN_ORIGIN]
  const app: Express = createApp({
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', CORS_ORIGINS: allowedOrigins, RATE_LIMIT_PER_MINUTE: 10_000 },
    routes: router => {
      router.use('/admin/auth', createAuthRouter({ auth: authService, allowedOrigins, secureCookie: false }))
      router.use('/customer', createCustomerAuthRouter({ auth: customerAuthService }))
      router.use('/customer/support', createCustomerSupportRouter({ auth: customerAuthService, tickets: supportService }))
      router.use('/admin/support-tickets', createAdminSupportRouter({ auth: authService, tickets: supportService, allowedOrigins }))
      router.use('/customer', createCustomerAddressRouter({ auth: customerAuthService, addresses: customerAddressService }))
      router.use('/customer', createCustomerOrderRouter({ auth: customerAuthService, orders: orderService }))
      router.use('/customer', createCustomerSubscriptionRouter({ auth: customerAuthService, subscriptions: subscriptionService }))
      router.use('/customer', createCustomerNotificationRouter({ auth: customerAuthService, notifications: notificationService }))
      router.use('/admin/dashboard', createAdminDashboardRouter({ auth: authService, dashboard: dashboardService, allowedOrigins }))
      router.use('/admin/notifications', createAdminNotificationRouter({ auth: authService, notifications: notificationService, allowedOrigins }))
      router.use('/admin/subscriptions', createAdminSubscriptionRouter({ auth: authService, subscriptions: subscriptionService, allowedOrigins }))
      router.use('/customer/payments', createCustomerPaymentRouter({ auth: customerAuthService, payments: paymentService }))
      router.use('/admin/payments', createAdminPaymentRouter({ auth: authService, payments: paymentService, allowedOrigins }))
      router.use('/webhooks/phonepe', createPhonePeWebhookRouter({ payments: paymentService }))
      router.use('/admin/production-planning', createAdminProductionPlanRouter({ auth: authService, plans: productionPlanService, allowedOrigins }))
      router.use('/customer', createCustomerCreditRouter({ auth: customerAuthService, credit: creditService }))
      router.use('/admin/credit-accounts', createAdminCreditRouter({ auth: authService, credit: creditService, allowedOrigins }))
      router.use('/admin/prepaid-adjustments', createAdminAdjustmentRouter({ auth: authService, adjustments: adjustmentService, allowedOrigins }))
      router.use('/admin/orders', createAdminOrderRouter({ auth: authService, orders: orderService, allowedOrigins }))
      router.use('/admin/customers', createAdminCustomerRouter({ auth: authService, customers: createCustomerService({ repository: createFakeAdminCustomerRepository(customerAuth.customers), addresses: addressStore.repository, audit: auditWriter }), allowedOrigins }))
      router.use('/admin/media', createAdminMediaRouter({ auth: authService, media: mediaService, allowedOrigins }))
      router.use('/admin/onboarding', createAdminOnboardingRouter({ auth: authService, onboarding: onboardingService, allowedOrigins }))
      router.use('/public/onboarding', createPublicOnboardingRouter({ onboarding: onboardingService }))
      router.use('/admin/app-settings', createAdminAppSettingsRouter({ auth: authService, settings: settingsService, allowedOrigins }))
      router.use('/public/app-settings', createPublicAppSettingsRouter({ settings: settingsService }))
      router.use('/admin/help', createAdminHelpRouter({ auth: authService, help: helpService, allowedOrigins }))
      router.use('/public/help', createPublicHelpRouter({ help: helpService }))
      router.use('/admin/policies', createAdminPolicyRouter({ auth: authService, policies: policyService, allowedOrigins }))
      router.use('/public/policies', createPublicPolicyRouter({ policies: policyService }))
      router.use('/legal', createLegalPageRouter({ policies: policyService }))
      router.use('/admin/delivery-slots', createAdminDeliverySlotRouter({ auth: authService, slots: deliverySlotService, allowedOrigins }))
      router.use('/admin/cutoff-rules', createAdminCutoffRuleRouter({ auth: authService, rules: cutoffRuleService, allowedOrigins }))
      router.use('/admin/service-areas', createAdminServiceAreaRouter({ auth: authService, areas: serviceAreaService, allowedOrigins }))
      router.use('/admin/products', createAdminProductRouter({ auth: authService, products: productService, allowedOrigins }))
      router.use('/admin/offers', createAdminOfferRouter({ auth: authService, offers: offerService, allowedOrigins }))
      router.use('/public/offers', createPublicOfferRouter({ offers: offerService }))
      router.use('/public/products', createPublicProductRouter({ products: productService }))
      router.use('/public/categories', createPublicCategoryRouter({ categories: categoryService }))
      router.use('/admin/categories', createAdminCategoryRouter({ auth: authService, categories: categoryService, allowedOrigins }))
      router.use('/admin/trial-plans', createAdminTrialPlanRouter({ auth: authService, trialPlans: trialPlanService, allowedOrigins }))
      router.use('/admin/subscription-rules', createAdminSubscriptionRuleRouter({ auth: authService, subscriptionRules: subscriptionRuleService, allowedOrigins }))
      router.use('/admin/pin-directory', createAdminPinDirectoryRouter({ auth: authService, directory: createFakePinDirectory(), allowedOrigins }))
      router.use('/admin/banners', createAdminBannerRouter({ auth: authService, banners: bannerService, allowedOrigins }))
      router.use('/public/banners', createPublicBannerRouter({ banners: bannerService }))
    },
  })
  return { app, clock, subscriptions: subscriptionStore, subscriptionService, slotRuleAnswers, payments: paymentStore, phonePe, paymentService, adjustments: adjustmentStore, credit: creditStore, productionDemand, orders: orderStore, deliveryAnswers, auth, banners: bannersRepository, media: mediaRepository, onboarding: onboardingRepository, settings: settingsRepository, help: helpRepository, policies: policyRepository, deliverySlots: deliverySlotRepository, cutoffRules: cutoffRuleRepository, serviceAreas: serviceAreaRepository, categories: categoryRepository, trialPlans: trialPlanRepository, subscriptionRules: subscriptionRuleRepository, products: productRepository, storage, audit, sentCodes, customerAuth, addressStore, supportStore, servedPins, sentCustomerCodes, admin, notificationStore, notificationService, dashboardCalls, offerStore }
}

export type TestApi = Awaited<ReturnType<typeof createTestApi>>
