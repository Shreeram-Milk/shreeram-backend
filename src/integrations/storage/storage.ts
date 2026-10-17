import { AppError } from '../../http/errors.js'

export type UploadTicket = { url: string; headers: Record<string, string>; expiresInSeconds: number }
export type StoredObject = { sizeBytes: number; contentType: string | null }

/**
 * Private file storage. Files are never public: the backend hands out short-lived links, and the keys that
 * sign them never leave the backend. The S3 version is the real one; tests use a fake.
 */
export interface ObjectStorage {
  /** A one-time link the browser uses to send exactly this file (this type, this size) to exactly this key. */
  createUploadTicket(input: { key: string; contentType: string; sizeBytes: number }): Promise<UploadTicket>
  /** A short-lived link that lets a viewer read the file. Signing is local, so this makes no network call. */
  createDownloadUrl(key: string): Promise<string>
  /** What is actually stored under the key, or null when nothing is there. */
  describeObject(key: string): Promise<StoredObject | null>
  /** The text of a small stored file (used to inspect SVG icons). Refuses anything larger than `maxBytes`. */
  readObjectText(key: string, maxBytes: number): Promise<string>
}

/** Used when no bucket is configured, so the rest of the API still starts and only uploads report why they cannot work. */
export const unconfiguredStorage: ObjectStorage = {
  async createUploadTicket() { throw notConfigured() },
  async createDownloadUrl() { throw notConfigured() },
  async describeObject() { throw notConfigured() },
  async readObjectText() { throw notConfigured() },
}

function notConfigured() {
  return new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not set up on the server.')
}
