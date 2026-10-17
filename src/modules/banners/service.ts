import { AppError } from '../../http/errors.js'
import { PUBLIC_CACHE_SECONDS } from '../../http/public-cache.js'
import { createTtlCache } from '../../http/ttl-cache.js'
import { ValidationError } from '../../http/validate.js'
import type { ObjectStorage } from '../../integrations/storage/storage.js'
import type { AuditWriter } from '../audit/audit.js'
import type { MediaPurpose } from '../media/schema.js'
import type { Banner, BannerRepository } from './repository.js'
import type { BannerInput, BannerStatus } from './schema.js'

/** What the admin screens read: the banner plus a short-lived link to its picture. The storage key stays private. */
export type AdminBanner = Omit<Banner, 'imageKey'> & { imageUrl: string | null }

/** The shape the customer app reads. It carries only what the app shows: no status, audience or dates. */
export type PublicBanner = { id: string; type: Banner['type']; titleEn: string; titleGu: string; messageEn: string; messageGu: string; labelEn: string; labelGu: string; imageUrl: string | null; ctaType: Banner['ctaType']; ctaTarget: string; sortOrder: number }

/** Today's date in India (YYYY-MM-DD). The business runs on one timezone, never the server's. */
export function businessDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

type Dependencies = {
  repository: BannerRepository
  audit: AuditWriter
  storage: Pick<ObjectStorage, 'createDownloadUrl'>
  /** Says whether a picture upload is finished and meant for banners. */
  media: { isReady(id: string, purpose: MediaPurpose): Promise<boolean> }
  now?: () => Date
}
type Actor = { adminId: string; ip: string | null }

/** Promotions carry a photo, Maintenance and Information carry a small SVG icon, Warnings are plain text. */
const IMAGE_PURPOSE: Record<BannerInput['type'], MediaPurpose | null> = { promotion: 'banner', maintenance: 'banner_icon', informational: 'banner_icon', warning: null }

const notFound = () => new AppError(404, 'BANNER_NOT_FOUND', 'That banner does not exist.')

export function createBannerService({ repository, audit, storage, media, now = () => new Date() }: Dependencies) {
  // Every phone asks for the public list; the database answers once per interval. The key is today's date, so a day change shows at once.
  const publicList = createTtlCache<PublicBanner[]>(PUBLIC_CACHE_SECONDS * 1000, () => now().getTime())
  const imageUrlOf = (banner: Banner) => (banner.imageKey ? storage.createDownloadUrl(banner.imageKey) : Promise.resolve(null))
  const toAdminBanner = async (banner: Banner): Promise<AdminBanner> => {
    const imageUrl = await imageUrlOf(banner)
    // Rebuilt field by field so the storage key can never slip into a response.
    return { id: banner.id, type: banner.type, audience: banner.audience, titleEn: banner.titleEn, titleGu: banner.titleGu, messageEn: banner.messageEn, messageGu: banner.messageGu, labelEn: banner.labelEn, labelGu: banner.labelGu, imageAssetId: banner.imageAssetId, imageUrl, ctaType: banner.ctaType, ctaTarget: banner.ctaTarget, startDate: banner.startDate, endDate: banner.endDate, sortOrder: banner.sortOrder, status: banner.status, createdAt: banner.createdAt, updatedAt: banner.updatedAt }
  }
  const checkImage = async (input: BannerInput) => {
    if (!input.imageAssetId) return
    const purpose = IMAGE_PURPOSE[input.type]
    if (!purpose) throw new ValidationError([{ field: 'imageAssetId', message: 'Warnings are plain text. Remove the picture.' }])
    if (!(await media.isReady(input.imageAssetId, purpose))) throw new ValidationError([{ field: 'imageAssetId', message: purpose === 'banner' ? 'That picture has not finished uploading. Upload it again.' : 'That icon has not finished uploading. Upload it again.' }])
  }

  return {
    async list(): Promise<AdminBanner[]> { return Promise.all((await repository.list()).map(toAdminBanner)) },

    async get(id: string): Promise<AdminBanner> {
      const banner = await repository.findById(id)
      if (!banner) throw notFound()
      return toAdminBanner(banner)
    },

    async create(input: BannerInput, actor: Actor): Promise<AdminBanner> {
      await checkImage(input)
      const banner = await repository.create(input)
      publicList.clear()
      await audit({ adminId: actor.adminId, action: 'banner_created', details: { bannerId: banner.id }, ip: actor.ip })
      return toAdminBanner(banner)
    },

    async update(id: string, input: BannerInput, actor: Actor): Promise<AdminBanner> {
      await checkImage(input)
      const banner = await repository.update(id, input)
      if (!banner) throw notFound()
      publicList.clear()
      await audit({ adminId: actor.adminId, action: 'banner_updated', details: { bannerId: id }, ip: actor.ip })
      return toAdminBanner(banner)
    },

    async setStatus(id: string, status: BannerStatus, actor: Actor): Promise<AdminBanner> {
      const banner = await repository.setStatus(id, status)
      if (!banner) throw notFound()
      publicList.clear()
      await audit({ adminId: actor.adminId, action: 'banner_status_changed', details: { bannerId: id, status }, ip: actor.ip })
      return toAdminBanner(banner)
    },

    /** What the app shows right now: active, inside its dates, for everyone. Targeted banners wait for customer sign-in. */
    listPublic(): Promise<PublicBanner[]> {
      const date = businessDate(now())
      return publicList.get(date, async () => {
        const banners = await repository.listPublic(date)
        return Promise.all(banners.map(async banner => ({ id: banner.id, type: banner.type, titleEn: banner.titleEn, titleGu: banner.titleGu, messageEn: banner.messageEn, messageGu: banner.messageGu, labelEn: banner.labelEn, labelGu: banner.labelGu, imageUrl: await imageUrlOf(banner), ctaType: banner.ctaType, ctaTarget: banner.ctaTarget, sortOrder: banner.sortOrder })))
      })
    },
  }
}

export type BannerService = ReturnType<typeof createBannerService>
