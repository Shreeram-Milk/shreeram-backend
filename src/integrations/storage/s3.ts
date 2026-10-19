import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ObjectStorage } from './storage.js'

const UPLOAD_SECONDS = 5 * 60
const DOWNLOAD_SECONDS = 2 * 60 * 60
/**
 * Picture links are signed as if at the start of the current half hour, so the same picture gets the same link for 30 minutes.
 * A new link on every request made phones download every picture again on each screen change, and cost an S3 request each time.
 * Each link still has at least 90 minutes left when handed out. A replaced picture has a new key, so it shows at once.
 */
const DOWNLOAD_LINK_STEP_MS = 30 * 60 * 1000

/** The start of the current half hour: the same signing time, and so the same link, for every request inside it. */
export const downloadSigningDate = (now: Date): Date => new Date(Math.floor(now.getTime() / DOWNLOAD_LINK_STEP_MS) * DOWNLOAD_LINK_STEP_MS)

type Settings = { region: string; bucket: string }

/**
 * S3 storage. Credentials are not passed in: the AWS library finds them itself (access keys in the environment on a
 * developer machine, an IAM role in production), so a key can never be written into code or logs here.
 */
export function createS3Storage({ region, bucket }: Settings, client: S3Client = new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED' })): ObjectStorage {
  // WHEN_REQUIRED keeps a checksum of an empty body out of the upload link; it would never match the real picture.
  return {
    async createUploadTicket({ key, contentType, sizeBytes }) {
      // Type and size are part of the signature, so S3 refuses a different file sent with this link.
      const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes }), {
        expiresIn: UPLOAD_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
        unhoistableHeaders: new Set(['content-type']),
      })
      return { url, headers: { 'Content-Type': contentType }, expiresInSeconds: UPLOAD_SECONDS }
    },
    createDownloadUrl: key => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: DOWNLOAD_SECONDS, signingDate: downloadSigningDate(new Date()) }),
    async readObjectText(key, maxBytes) {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }))
      return (await object.Body?.transformToString('utf-8')) ?? ''
    },
    async describeObject(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType ?? null }
      } catch (error) {
        if ((error as { name?: string }).name === 'NotFound' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
        throw error
      }
    },
  }
}
