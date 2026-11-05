import { z } from 'zod'

const email = z.string().trim().toLowerCase().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email address.')

export const riderLoginBody = z.object({ email, password: z.string().min(1, 'Enter your password.').max(200) })
export const riderVerifyBody = z.object({ email, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') })

/** The rider works on today's deliveries only, so no date is ever sent: the server decides what "today" is (India time). */
export const riderSheetQuery = z.object({ slotId: z.uuid() })
export type RiderSheetQuery = z.infer<typeof riderSheetQuery>

export const riderCheckInBody = z.object({ slotId: z.uuid(), pinCode: z.string().trim().regex(/^\d{6}$/, 'A PIN code has 6 digits.') })
export type RiderCheckInBody = z.infer<typeof riderCheckInBody>

/** The rider can only close a delivery as delivered or missed; cancelling or anything else stays with the admin panel. */
export const riderDeliveriesBody = z.object({
  orderIds: z.array(z.uuid()).min(1, 'Choose at least one order.').max(50, 'At most 50 orders at once.'),
  status: z.enum(['delivered', 'missed']),
})
export type RiderDeliveriesBody = z.infer<typeof riderDeliveriesBody>
