import { randomUUID } from 'node:crypto'
import type { ObjectStorage, UploadTicket } from '../../integrations/storage/storage.js'
import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import type { MediaAsset, MediaRepository } from './repository.js'
import type { ImageType, MediaPurpose, UploadRequest } from './schema.js'
import { svgProblem } from './svg.js'

type Dependencies = { repository: MediaRepository; storage: ObjectStorage; audit: AuditWriter; now?: () => Date }
type Actor = { adminId: string; ip: string | null }

const EXTENSIONS: Record<ImageType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' }
const FOLDERS: Record<MediaPurpose, string> = { banner: 'banners', banner_icon: 'banner-icons', onboarding: 'onboarding', product: 'products' }

/** Random keys in a folder per purpose and month: `banners/2026/10/<uuid>.webp`. A name chosen by a user never reaches the path. */
export function objectKeyFor(purpose: MediaPurpose, contentType: ImageType, at: Date): string {
  const year = at.getUTCFullYear()
  const month = String(at.getUTCMonth() + 1).padStart(2, '0')
  return `${FOLDERS[purpose]}/${year}/${month}/${randomUUID()}.${EXTENSIONS[contentType]}`
}

const notFound = () => new AppError(404, 'MEDIA_NOT_FOUND', 'That picture does not exist.')

export function createMediaService({ repository, storage, audit, now = () => new Date() }: Dependencies) {
  return {
    /** Step 1: reserve a place for the picture and hand the browser a link to send it to. */
    async startUpload(request: UploadRequest, actor: Actor): Promise<{ asset: { id: string }; upload: UploadTicket }> {
      const objectKey = objectKeyFor(request.purpose, request.contentType, now())
      const upload = await storage.createUploadTicket({ key: objectKey, contentType: request.contentType, sizeBytes: request.sizeBytes })
      const asset = await repository.createPending({ objectKey, purpose: request.purpose, contentType: request.contentType, sizeBytes: request.sizeBytes, uploadedBy: actor.adminId })
      await audit({ adminId: actor.adminId, action: 'media_upload_started', details: { assetId: asset.id }, ip: actor.ip })
      return { asset: { id: asset.id }, upload }
    },

    /** Step 2: after the browser says it sent the file, check the storage really holds what was promised. */
    async completeUpload(id: string, actor: Actor): Promise<{ asset: { id: string; status: 'ready' } }> {
      const asset = await repository.findById(id)
      if (!asset) throw notFound()
      if (asset.status === 'ready') return { asset: { id, status: 'ready' } }
      const stored = await storage.describeObject(asset.objectKey)
      if (!stored) throw new AppError(409, 'UPLOAD_NOT_FOUND', 'The picture did not arrive. Please upload it again.')
      if (stored.sizeBytes !== asset.sizeBytes || stored.contentType !== asset.contentType) throw new AppError(409, 'UPLOAD_MISMATCH', 'The uploaded picture is not what was expected. Please upload it again.')
      if (asset.contentType === 'image/svg+xml') {
        // Read back what was actually stored; the browser's word that it is a harmless drawing is not enough.
        const problem = svgProblem(await storage.readObjectText(asset.objectKey, asset.sizeBytes))
        if (problem) throw new AppError(409, 'UNSAFE_SVG', `That icon cannot be used. ${problem}`)
      }
      await repository.markReady(id)
      await audit({ adminId: actor.adminId, action: 'media_upload_completed', details: { assetId: id }, ip: actor.ip })
      return { asset: { id, status: 'ready' } }
    },

    /** True only for a finished upload made for this purpose. Other features use it before linking a picture. */
    async isReady(id: string, purpose: MediaPurpose): Promise<boolean> {
      const asset: MediaAsset | null = await repository.findById(id)
      return asset?.status === 'ready' && asset.purpose === purpose
    },
  }
}

export type MediaService = ReturnType<typeof createMediaService>
