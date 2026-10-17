import type { AuditWriter } from '../audit/audit.js'
import type { AuthService } from '../auth/service.js'
import { createSimpleRecordRouter, createSimpleRecordService } from '../master-data/simple-records.js'
import type { TrialPlan, TrialPlanRepository } from './repository.js'
import { trialPlanInputSchema, type TrialPlanInput } from './schema.js'

export const createTrialPlanService = (options: { repository: TrialPlanRepository; audit: AuditWriter }) =>
  createSimpleRecordService<TrialPlan, TrialPlanInput>({ ...options, noun: 'trial plan', notFoundCode: 'TRIAL_PLAN_NOT_FOUND', auditPrefix: 'trial_plan' })
export type TrialPlanService = ReturnType<typeof createTrialPlanService>

/** `/admin/trial-plans`: only a signed-in admin can read or change trial plans. */
export const createAdminTrialPlanRouter = (options: { auth: AuthService; trialPlans: TrialPlanService; allowedOrigins: string[] }) =>
  createSimpleRecordRouter<TrialPlan, TrialPlanInput>({ auth: options.auth, service: options.trialPlans, allowedOrigins: options.allowedOrigins, inputSchema: trialPlanInputSchema, key: 'trialPlan' })
