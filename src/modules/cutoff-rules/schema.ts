import { z } from 'zod'
import { RECORD_STATUSES, descriptionField, nameField, timeField } from '../master-data/shared.js'

export const DAY_RELATIONS = ['same_day', 'previous_day'] as const
export const MAX_CONDITIONS = 20

/** Minutes from midnight of the delivery day; the day before counts as negative, so earlier deadlines are smaller. */
const deadlineMinutes = (dayRelation: (typeof DAY_RELATIONS)[number], time: string) => {
  const [hours = 0, minutes = 0] = time.split(':').map(Number)
  return (dayRelation === 'previous_day' ? -1440 : 0) + hours * 60 + minutes
}

/**
 * One slot of a rule. Orders for a day close at the cut-off. Customers may cancel or skip until the cancel time, which can
 * be earlier than the cut-off but never later (left empty, it is the cut-off itself).
 */
const conditionSchema = z.object({
  deliverySlotId: z.uuid('Choose a delivery slot.'),
  dayRelation: z.enum(DAY_RELATIONS),
  cutoffTime: timeField,
  cancelDayRelation: z.enum(DAY_RELATIONS).nullable().default(null),
  cancelTime: timeField.nullable().default(null),
}).superRefine((condition, context) => {
  if ((condition.cancelDayRelation === null) !== (condition.cancelTime === null)) {
    context.addIssue({ code: 'custom', path: ['cancelTime'], message: 'Choose both the day and the time, or leave cancelling the same as the cut-off.' })
    return
  }
  if (condition.cancelDayRelation && condition.cancelTime && deadlineMinutes(condition.cancelDayRelation, condition.cancelTime) > deadlineMinutes(condition.dayRelation, condition.cutoffTime)) {
    context.addIssue({ code: 'custom', path: ['cancelTime'], message: 'Cancelling must close at or before the order cut-off.' })
  }
})

export const cutoffRuleInputSchema = z.object({
  name: nameField,
  description: descriptionField,
  status: z.enum(RECORD_STATUSES).default('active'),
  conditions: z.array(conditionSchema).min(1, 'Add at least one slot condition.').max(MAX_CONDITIONS, `Add at most ${MAX_CONDITIONS} conditions.`),
}).refine(rule => new Set(rule.conditions.map(condition => condition.deliverySlotId)).size === rule.conditions.length, { path: ['conditions'], message: 'Each delivery slot can only appear once.' })

export type CutoffRuleInput = z.infer<typeof cutoffRuleInputSchema>
export type CutoffCondition = CutoffRuleInput['conditions'][number]
