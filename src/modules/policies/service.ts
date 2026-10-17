import { AppError } from '../../http/errors.js'
import { PUBLIC_CACHE_SECONDS } from '../../http/public-cache.js'
import { createTtlCache } from '../../http/ttl-cache.js'
import type { AuditWriter } from '../audit/audit.js'
import type { Policy, PolicyRepository } from './repository.js'
import { MIN_PUBLISHED_BODY_LENGTH, POLICY_TITLES, type PolicyInput, type PolicyType } from './schema.js'

/** What the customer app and the public web pages read: only published versions. */
export type PublicPolicy = Pick<Policy, 'id' | 'type' | 'titleEn' | 'titleGu' | 'bodyEn' | 'bodyGu' | 'version' | 'effectiveDate'>

type Dependencies = { repository: PolicyRepository; audit: AuditWriter }
type Actor = { adminId: string; ip: string | null }

const notFound = () => new AppError(404, 'POLICY_NOT_FOUND', 'That policy version does not exist.')
const sameVersion = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** "1.0" -> "1.1", "2" -> "3"; anything unexpected restarts at "1.0". */
export function nextVersion(versions: string[]): string {
  const parsed = versions.map(version => /^(\d+)(?:\.(\d+))?$/.exec(version.trim())).filter((match): match is RegExpExecArray => match !== null).map(match => [Number(match[1]), Number(match[2] ?? 0)] as const)
  const latest = parsed.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0]
  return latest ? `${latest[0]}.${latest[1] + 1}` : '1.0'
}

export function createPolicyService({ repository, audit }: Dependencies) {
  // Every phone and every web visitor reads the published policies; the database answers once per interval.
  const published = createTtlCache<PublicPolicy[]>(PUBLIC_CACHE_SECONDS * 1000)
  const toPublic = (policy: Policy): PublicPolicy => ({ id: policy.id, type: policy.type, titleEn: policy.titleEn, titleGu: policy.titleGu, bodyEn: policy.bodyEn, bodyGu: policy.bodyGu, version: policy.version, effectiveDate: policy.effectiveDate })

  async function find(id: string): Promise<Policy> {
    const policy = await repository.findById(id)
    if (!policy) throw notFound()
    return policy
  }
  async function checkVersionFree(type: PolicyType, version: string) {
    if ((await repository.versionsOf(type)).some(used => sameVersion(used, version))) throw new AppError(409, 'POLICY_VERSION_EXISTS', `Version ${version} of the ${POLICY_TITLES[type]} already exists.`)
  }

  const getPublic = () => published.get('published', async () => (await repository.listPublished()).map(toPublic))

  return {
    list: () => repository.list(),
    get: find,

    async create(input: PolicyInput, actor: Actor): Promise<Policy> {
      await checkVersionFree(input.type, input.version)
      const policy = await repository.create(input, actor.adminId)
      await audit({ adminId: actor.adminId, action: 'policy_draft_created', details: { policyId: policy.id, type: policy.type }, ip: actor.ip })
      return policy
    },

    /** Edits a draft. Published and archived versions are history and cannot change. */
    async updateDraft(id: string, input: PolicyInput, actor: Actor): Promise<Policy> {
      const existing = await find(id)
      if (existing.status !== 'draft') throw new AppError(409, 'POLICY_NOT_DRAFT', existing.status === 'published' ? 'A published version can’t be edited. Create a new version instead.' : 'An archived version can’t be edited.')
      if (input.type !== existing.type || !sameVersion(input.version, existing.version)) await checkVersionFree(input.type, input.version)
      const policy = await repository.updateDraft(id, input, actor.adminId)
      if (!policy) throw new AppError(409, 'POLICY_NOT_DRAFT', 'Only a draft can be edited.')
      await audit({ adminId: actor.adminId, action: 'policy_draft_updated', details: { policyId: id }, ip: actor.ip })
      return policy
    },

    /** A draft copy of any version with the next version number, to start a revision from. */
    async startNewVersion(id: string, actor: Actor): Promise<Policy> {
      const source = await find(id)
      const version = nextVersion(await repository.versionsOf(source.type))
      const policy = await repository.create({ type: source.type, titleEn: source.titleEn, titleGu: source.titleGu, bodyEn: source.bodyEn, bodyGu: source.bodyGu, version, effectiveDate: source.effectiveDate }, actor.adminId)
      await audit({ adminId: actor.adminId, action: 'policy_draft_created', details: { policyId: policy.id, type: policy.type, copiedFrom: id }, ip: actor.ip })
      return policy
    },

    /** Publishes a draft and archives whatever was published before, so exactly one version is live. Nothing is deleted. */
    async publish(id: string, actor: Actor): Promise<Policy> {
      const draft = await find(id)
      if (draft.status !== 'draft') throw new AppError(409, 'POLICY_NOT_DRAFT', 'Only a draft can be published.')
      if (draft.bodyEn.trim().length < MIN_PUBLISHED_BODY_LENGTH) throw new AppError(409, 'POLICY_TOO_SHORT', `The English text must be at least ${MIN_PUBLISHED_BODY_LENGTH} characters before it can be published.`)
      const current = await repository.findPublished(draft.type)
      if (current && draft.effectiveDate < current.effectiveDate) throw new AppError(409, 'POLICY_DATE_ORDER', `This version takes effect before the one it replaces (version ${current.version}, from ${current.effectiveDate}). Move its date forward.`)
      const policy = await repository.publish(id, draft.type, actor.adminId)
      if (!policy) throw new AppError(409, 'POLICY_NOT_DRAFT', 'Only a draft can be published.')
      published.clear()
      await audit({ adminId: actor.adminId, action: 'policy_published', details: { policyId: id, type: policy.type, version: policy.version, replaced: current?.version ?? null }, ip: actor.ip })
      return policy
    },

    async archive(id: string, actor: Actor): Promise<Policy> {
      const existing = await find(id)
      if (existing.status !== 'published') throw new AppError(409, 'POLICY_NOT_PUBLISHED', existing.status === 'draft' ? 'A draft is not live. Discard it instead.' : 'This version is already archived.')
      const policy = await repository.archive(id, actor.adminId)
      if (!policy) throw new AppError(409, 'POLICY_NOT_PUBLISHED', 'Only a published version can be archived.')
      published.clear()
      await audit({ adminId: actor.adminId, action: 'policy_archived', details: { policyId: id, type: policy.type, version: policy.version }, ip: actor.ip })
      return policy
    },

    /** Deletes a draft that is no longer wanted. A published or archived version is part of the record and is never deleted. */
    async discardDraft(id: string, actor: Actor): Promise<void> {
      const existing = await find(id)
      if (existing.status !== 'draft') throw new AppError(409, 'POLICY_NOT_DRAFT', 'Only a draft can be discarded. Published and archived versions are kept as history.')
      if (!(await repository.deleteDraft(id))) throw new AppError(409, 'POLICY_NOT_DRAFT', 'Only a draft can be discarded.')
      await audit({ adminId: actor.adminId, action: 'policy_draft_discarded', details: { policyId: id, type: existing.type, version: existing.version }, ip: actor.ip })
    },

    getPublic,
    async getPublicByType(type: PolicyType): Promise<PublicPolicy | null> { return (await getPublic()).find(policy => policy.type === type) ?? null },
  }
}

export type PolicyService = ReturnType<typeof createPolicyService>
