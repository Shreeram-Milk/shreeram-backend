import { AppError } from '../../http/errors.js'
import { newToken, sha256 } from '../auth/crypto.js'
import type { AuthService, RequestContext, SignedInAdmin } from '../auth/service.js'
import { indiaClock } from '../delivery-brain/rules.js'
import type { Notifier } from '../notifications/notifier.js'
import type { OrderService } from '../orders/service.js'
import type { ProductionPlanService } from '../production-planning/service.js'
import type { RiderRepository } from './repository.js'
import type { RiderCheckInBody, RiderDeliveriesBody } from './schema.js'

/** The rider app keeps the owner signed in on one phone for a month; signing out from the app ends it at once. */
export const RIDER_SESSION_DAYS = 30
const days = (count: number) => count * 24 * 60 * 60_000

type Dependencies = {
  repository: RiderRepository
  /** Password + emailed code, the same as the admin panel. */
  auth: Pick<AuthService, 'startLogin' | 'confirmCode'>
  plans: Pick<ProductionPlanService, 'riderSheetFor'>
  orders: Pick<OrderService, 'adminBulkStatus'>
  notifier: Notifier
  now?: () => Date
}
type Actor = { adminId: string; ip: string | null }

/**
 * The rider's day: which windows have deliveries, the sheet of houses for a window, "I have reached this PIN code" (which tells the
 * customers there that the rider is about 15-20 minutes away) and closing deliveries as delivered or missed. The rules for the sheet
 * and for order status are the same ones the admin panel uses; nothing is copied here.
 */
export function createRiderService({ repository, auth, plans, orders, notifier, now = () => new Date() }: Dependencies) {
  const today = () => indiaClock(now()).date

  return {
    startLogin: (email: string, password: string, context: RequestContext) => auth.startLogin(email, password, context),

    async completeLogin(email: string, code: string, context: RequestContext): Promise<{ token: string; expiresAt: Date; rider: SignedInAdmin }> {
      const rider = await auth.confirmCode(email, code, context)
      const token = newToken()
      const expiresAt = new Date(now().getTime() + days(RIDER_SESSION_DAYS))
      await repository.createSession({ adminId: rider.id, tokenHash: sha256(token), expiresAt, userAgent: context.userAgent?.slice(0, 300) ?? null, ip: context.ip })
      return { token, expiresAt, rider }
    },

    /** Who is signed in for this token, or null when it is missing, expired, signed out, or the person was disabled. */
    async authenticate(token: string | undefined): Promise<SignedInAdmin | null> {
      if (!token) return null
      const session = await repository.findSession(sha256(token), now())
      if (!session) return null
      await repository.touchSession(session.sessionId, now())
      return { id: session.adminId, email: session.email }
    },

    async logout(token: string | undefined): Promise<void> {
      if (token) await repository.revokeSession(sha256(token), now())
    },

    /** Today's windows with their counts. */
    async day() {
      const date = today()
      return { date, windows: await repository.windows(date) }
    },

    /** The houses still to visit in one window (delivered and missed ones are gone from it), and which PIN codes are already checked in. */
    async sheet(slotId: string) {
      const date = today()
      const [sheet, checkIns] = await Promise.all([plans.riderSheetFor(date, slotId), repository.checkIns(date, slotId)])
      return { sheet, checkIns }
    },

    /**
     * "I have reached this PIN code." Every customer with an open order there (in this window, today) gets one "arriving in about 15-20
     * minutes" message. Pressing it again, or from a second phone, tells nobody twice.
     */
    async checkIn(input: RiderCheckInBody, actor: Actor): Promise<{ alreadyCheckedIn: boolean; customersNotified: number }> {
      const date = today()
      const sheet = await plans.riderSheetFor(date, input.slotId)
      if (!sheet.areas.some(area => area.pinCode === input.pinCode)) {
        throw new AppError(409, 'NO_OPEN_ORDERS_IN_PIN', 'There are no deliveries left in this PIN code for this window.')
      }
      const checkInId = await repository.recordCheckIn({ adminId: actor.adminId, date, slotId: input.slotId, pinCode: input.pinCode })
      if (!checkInId) {
        const earlier = (await repository.checkIns(date, input.slotId)).find(entry => entry.pinCode === input.pinCode)
        return { alreadyCheckedIn: true, customersNotified: earlier?.customersNotified ?? 0 }
      }
      const waiting = await repository.waitingCustomers(date, input.slotId, input.pinCode)
      // The notifier never throws and never makes us wait for the phone. The dedupe key makes each customer's message a once-only event.
      await Promise.all(waiting.map(customer => notifier.notify({
        event: 'rider_arriving', customerId: customer.customerId, vars: { order: customer.orderNumber, window: sheet.slot.name },
        link: `/order-tracking?orderId=${customer.orderId}`, dedupeKey: `rider-arriving:${date}:${input.slotId}:${input.pinCode}:${customer.customerId}`,
      })))
      await repository.setNotified(checkInId, waiting.length)
      return { alreadyCheckedIn: false, customersNotified: waiting.length }
    },

    /** Closes one house's orders (a house can have several) as delivered or missed, with the same rules and customer messages as the admin panel. */
    markOrders: (input: RiderDeliveriesBody, actor: Actor) => orders.adminBulkStatus({ orderIds: input.orderIds, status: input.status, note: 'Rider app' }, actor, { handedOver: true }),
  }
}

export type RiderService = ReturnType<typeof createRiderService>
