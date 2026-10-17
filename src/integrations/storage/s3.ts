import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ObjectStorage } from './storage.js'

const UPLOAD_SECONDS = 5 * 60
const DOWNLOAD_SECONDS = 60 * 60

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
    createDownloadUrl: key => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: DOWNLOAD_SECONDS }),
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
