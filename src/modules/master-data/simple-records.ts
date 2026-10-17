import { Router, type Request, type Response } from 'express'
import type { ZodType } from 'zod'
import { validate } from '../../http/validate.js'
import type { AuditWriter } from '../audit/audit.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { assertCanDeactivate, assertCanDelete, nameTakenError, notFoundError, pageQuerySchema, recordIdParamsSchema, statusChangeSchema, type PageQuery, type RecordStatus, type StatusChange, type Usage } from './shared.js'

type Named = { name: string; status: RecordStatus }

/** Storage for a plain named record (a category, trial plan or subscription rule). Each feature supplies its own SQL. */
export interface SimpleRecordRepository<Saved extends { id: string; status: RecordStatus }, Input extends Named> {
  list(query: PageQuery): Promise<{ rows: Saved[]; total: number }>
  listAll(): Promise<Saved[]>
  findById(id: string): Promise<Saved | null>
  create(input: Input, adminId: string): Promise<Saved>
  update(id: string, input: Input, adminId: string): Promise<Saved | null>
  setStatus(id: string, status: RecordStatus, adminId: string): Promise<Saved | null>
  nameExists(name: string, excludingId?: string): Promise<boolean>
  /** What uses this record. Empty until products are stored in the database. */
  usage(id: string): Promise<Usage[]>
  /** Deletes the record. Only called once `usage` says nothing uses it. */
  remove(id: string): Promise<boolean>
}

type Actor = { adminId: string; ip: string | null }
type ServiceOptions<Saved extends { id: string; status: RecordStatus }, Input extends Named> = {
  repository: SimpleRecordRepository<Saved, Input>
  audit: AuditWriter
  /** Plain words for messages, such as "trial plan". */
  noun: string
  /** Error code for "no such record", such as TRIAL_PLAN_NOT_FOUND. */
  notFoundCode: string
  /** Audit action prefix, such as `trial_plan` giving `trial_plan_created`. */
  auditPrefix: string
}

/** The rules every plain named record shares: unique name, in-use check before switching off, one audit entry per change. */
export function createSimpleRecordService<Saved extends { id: string; status: RecordStatus }, Input extends Named>({ repository, audit, noun, notFoundCode, auditPrefix }: ServiceOptions<Saved, Input>) {
  const notFound = () => notFoundError(notFoundCode, noun)

  async function get(id: string): Promise<Saved> {
    const record = await repository.findById(id)
    if (!record) throw notFound()
    return record
  }

  return {
    list: (query: PageQuery) => repository.list(query),
    listAll: () => repository.listAll(),
    get,

    async usage(id: string): Promise<Usage[]> {
      await get(id)
      return repository.usage(id)
    },

    async create(input: Input, actor: Actor): Promise<Saved> {
      if (await repository.nameExists(input.name)) throw nameTakenError()
      const record = await repository.create(input, actor.adminId)
      await audit({ adminId: actor.adminId, action: `${auditPrefix}_created`, details: { recordId: record.id }, ip: actor.ip })
      return record
    },

    async update(id: string, input: Input, actor: Actor): Promise<Saved> {
      const current = await get(id)
      if (await repository.nameExists(input.name, id)) throw nameTakenError()
      if (current.status === 'active' && input.status === 'inactive') assertCanDeactivate(await repository.usage(id), { status: 'inactive', confirmInUse: false }, noun)
      const record = await repository.update(id, input, actor.adminId)
      if (!record) throw notFound()
      await audit({ adminId: actor.adminId, action: `${auditPrefix}_updated`, details: { recordId: id }, ip: actor.ip })
      return record
    },

    async setStatus(id: string, change: StatusChange, actor: Actor): Promise<Saved> {
      await get(id)
      assertCanDeactivate(await repository.usage(id), change, noun)
      const record = await repository.setStatus(id, change.status, actor.adminId)
      if (!record) throw notFound()
      await audit({ adminId: actor.adminId, action: `${auditPrefix}_status_changed`, details: { recordId: id, status: change.status, forced: change.confirmInUse }, ip: actor.ip })
      return record
    },

    async remove(id: string, actor: Actor): Promise<void> {
      await get(id)
      assertCanDelete(await repository.usage(id), noun)
      if (!(await repository.remove(id))) throw notFound()
      await audit({ adminId: actor.adminId, action: `${auditPrefix}_deleted`, details: { recordId: id }, ip: actor.ip })
    },
  }
}

export type SimpleRecordService<Saved extends { id: string; status: RecordStatus }, Input extends Named> = ReturnType<typeof createSimpleRecordService<Saved, Input>>

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** Admin-only routes for a plain named record: list, pick-list, read, usage, create, edit, switch on/off. */
export function createSimpleRecordRouter<Saved extends { id: string; status: RecordStatus }, Input extends Named>(options: {
  auth: AuthService
  service: SimpleRecordService<Saved, Input>
  allowedOrigins: string[]
  inputSchema: ZodType<Input>
  /** The name the single record goes under in the JSON answer, such as `plan`. */
  key: string
}): Router {
  const { auth, service, allowedOrigins, inputSchema, key } = options
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', validate('query', pageQuerySchema), async (request: Request, response: Response) => { response.json(await service.list(request.query as unknown as PageQuery)) })
  router.get('/all', async (_request: Request, response: Response) => { response.json({ rows: await service.listAll() }) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ [key]: await service.get(idOf(request)) }) })
  router.get('/:id/usage', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ usage: await service.usage(idOf(request)) }) })
  router.post('/', validate('body', inputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ [key]: await service.create(request.body as Input, actorOf(request)) })
  })
  router.put('/:id', validate('params', recordIdParamsSchema), validate('body', inputSchema), async (request: Request, response: Response) => {
    response.json({ [key]: await service.update(idOf(request), request.body as Input, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', recordIdParamsSchema), validate('body', statusChangeSchema), async (request: Request, response: Response) => {
    response.json({ [key]: await service.setStatus(idOf(request), request.body as StatusChange, actorOf(request)) })
  })
  router.delete('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => {
    await service.remove(idOf(request), actorOf(request))
    response.status(204).end()
  })
  return router
}
