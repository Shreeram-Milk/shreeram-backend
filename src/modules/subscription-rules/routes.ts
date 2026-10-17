import type { AuditWriter } from '../audit/audit.js'
import type { AuthService } from '../auth/service.js'
import { createSimpleRecordRouter, createSimpleRecordService } from '../master-data/simple-records.js'
import type { SubscriptionRule, SubscriptionRuleRepository } from './repository.js'
import { subscriptionRuleInputSchema, type SubscriptionRuleInput } from './schema.js'

export const createSubscriptionRuleService = (options: { repository: SubscriptionRuleRepository; audit: AuditWriter }) =>
  createSimpleRecordService<SubscriptionRule, SubscriptionRuleInput>({ ...options, noun: 'subscription rule', notFoundCode: 'SUBSCRIPTION_RULE_NOT_FOUND', auditPrefix: 'subscription_rule' })
export type SubscriptionRuleService = ReturnType<typeof createSubscriptionRuleService>

/** `/admin/subscription-rules`: only a signed-in admin can read or change subscription rules. */
export const createAdminSubscriptionRuleRouter = (options: { auth: AuthService; subscriptionRules: SubscriptionRuleService; allowedOrigins: string[] }) =>
  createSimpleRecordRouter<SubscriptionRule, SubscriptionRuleInput>({ auth: options.auth, service: options.subscriptionRules, allowedOrigins: options.allowedOrigins, inputSchema: subscriptionRuleInputSchema, key: 'subscriptionRule' })
