import { AppError } from '../../http/errors.js'
import { PUBLIC_CACHE_SECONDS } from '../../http/public-cache.js'
import { createTtlCache } from '../../http/ttl-cache.js'
import { ValidationError } from '../../http/validate.js'
import type { ObjectStorage } from '../../integrations/storage/storage.js'
import type { AuditWriter } from '../audit/audit.js'
import type { MediaPurpose } from '../media/schema.js'
import type { OnboardingRepository, Slide } from './repository.js'
import { MAX_ACTIVE_SLIDES, type SlideInput, type SlideStatus } from './schema.js'

/** What the admin reads: the slide plus a short-lived link to its picture. The storage key stays private. */
export type AdminSlide = Omit<Slide, 'imageKey'> & { imageUrl: string | null }

/** What the customer app reads: only what a slide shows. */
export type PublicSlide = { id: string; imageUrl: string | null; titleEn: string; titleGu: string; descriptionEn: string; descriptionGu: string; sortOrder: number }

type Dependencies = {
  repository: OnboardingRepository
  audit: AuditWriter
  storage: Pick<ObjectStorage, 'createDownloadUrl'>
  media: { isReady(id: string, purpose: MediaPurpose): Promise<boolean> }
}
type Actor = { adminId: string; ip: string | null }

const notFound = () => new AppError(404, 'SLIDE_NOT_FOUND', 'That slide does not exist.')

export function createOnboardingService({ repository, audit, storage, media }: Dependencies) {
  // Every new phone asks for the slides; the database answers once per interval.
  const publicList = createTtlCache<PublicSlide[]>(PUBLIC_CACHE_SECONDS * 1000)
  const imageUrlOf = (slide: Slide) => (slide.imageKey ? storage.createDownloadUrl(slide.imageKey) : Promise.resolve(null))
  const toAdminSlide = async (slide: Slide): Promise<AdminSlide> => ({
    id: slide.id, imageAssetId: slide.imageAssetId, imageUrl: await imageUrlOf(slide), titleEn: slide.titleEn, titleGu: slide.titleGu, descriptionEn: slide.descriptionEn, descriptionGu: slide.descriptionGu,
    sortOrder: slide.sortOrder, status: slide.status, createdAt: slide.createdAt, updatedAt: slide.updatedAt,
  })
  const checkImage = async (input: SlideInput) => {
    if (!(await media.isReady(input.imageAssetId, 'onboarding'))) throw new ValidationError([{ field: 'imageAssetId', message: 'That picture has not finished uploading. Upload it again.' }])
  }
  /** Turning a slide on counts against the limit; editing one that is already on does not. */
  const checkActiveLimit = async (becomingActive: boolean, id?: string) => {
    if (becomingActive && (await repository.countActive(id)) >= MAX_ACTIVE_SLIDES) throw new AppError(409, 'ONBOARDING_LIMIT', `Only ${MAX_ACTIVE_SLIDES} slides can be active at once. Deactivate one first.`)
  }

  return {
    async list(): Promise<AdminSlide[]> { return Promise.all((await repository.list()).map(toAdminSlide)) },

    async get(id: string): Promise<AdminSlide> {
      const slide = await repository.findById(id)
      if (!slide) throw notFound()
      return toAdminSlide(slide)
    },

    async create(input: SlideInput, actor: Actor): Promise<AdminSlide> {
      await checkImage(input)
      await checkActiveLimit(input.status === 'active')
      const slide = await repository.create(input, await repository.nextSortOrder())
      publicList.clear()
      await audit({ adminId: actor.adminId, action: 'onboarding_slide_created', details: { slideId: slide.id }, ip: actor.ip })
      return toAdminSlide(slide)
    },

    async update(id: string, input: SlideInput, actor: Actor): Promise<AdminSlide> {
      const existing = await repository.findById(id)
      if (!existing) throw notFound()
      await checkImage(input)
      await checkActiveLimit(input.status === 'active' && existing.status !== 'active', id)
      const slide = await repository.update(id, input)
      if (!slide) throw notFound()
      publicList.clear()
      await audit({ adminId: actor.adminId, action: 'onboarding_slide_updated', details: { slideId: id }, ip: actor.ip })
      return toAdminSlide(slide)
    },

    async setStatus(id: string, status: SlideStatus, actor: Actor): Promise<AdminSlide> {
      const existing = await repository.findById(id)
      if (!existing) throw notFound()
      await checkActiveLimit(status === 'active' && existing.status !== 'active', id)
      const slide = await repository.setStatus(id, status)
      if (!slide) throw notFound()
      publicList.clear()
      await audit({ adminId: actor.adminId, action: 'onboarding_slide_status_changed', details: { slideId: id, status }, ip: actor.ip })
      return toAdminSlide(slide)
    },

    /** Swaps a slide with its neighbour, and renumbers the whole list 1, 2, 3... so old gaps or ties never matter. */
    async move(id: string, direction: 'up' | 'down', actor: Actor): Promise<AdminSlide[]> {
      const ids = (await repository.list()).map(slide => slide.id)
      const index = ids.indexOf(id)
      if (index === -1) throw notFound()
      const target = direction === 'up' ? index - 1 : index + 1
      if (target >= 0 && target < ids.length) {
        ;[ids[index], ids[target]] = [ids[target] as string, ids[index] as string]
        await repository.setOrder(ids)
        publicList.clear()
        await audit({ adminId: actor.adminId, action: 'onboarding_slides_reordered', details: { slideId: id, direction }, ip: actor.ip })
      }
      return this.list()
    },

    /** The introduction the app shows: active slides, in order. */
    listPublic(): Promise<PublicSlide[]> {
      return publicList.get('active', async () => Promise.all((await repository.listActive()).map(async slide => ({ id: slide.id, imageUrl: await imageUrlOf(slide), titleEn: slide.titleEn, titleGu: slide.titleGu, descriptionEn: slide.descriptionEn, descriptionGu: slide.descriptionGu, sortOrder: slide.sortOrder }))))
    },
  }
}

export type OnboardingService = ReturnType<typeof createOnboardingService>
