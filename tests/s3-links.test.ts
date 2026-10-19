import { S3Client } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createS3Storage, downloadSigningDate } from '../src/integrations/storage/s3.js'

// Signing happens on this computer; these made-up keys never reach AWS.
const client = new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'test-secret' } })
const storage = createS3Storage({ region: 'ap-south-1', bucket: 'test-bucket' }, client)

describe('picture links', () => {
  afterEach(() => { vi.useRealTimers() })

  it('signs at the start of the current half hour', () => {
    expect(downloadSigningDate(new Date('2026-10-19T05:43:48.123Z')).toISOString()).toBe('2026-10-19T05:30:00.000Z')
    expect(downloadSigningDate(new Date('2026-10-19T06:00:00.000Z')).toISOString()).toBe('2026-10-19T06:00:00.000Z')
  })

  it('gives the same picture the same link within a half hour, so phones can reuse the downloaded picture', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-19T05:31:00Z') })
    const first = await storage.createDownloadUrl('products/a.webp')
    vi.setSystemTime(new Date('2026-10-19T05:59:59Z'))
    expect(await storage.createDownloadUrl('products/a.webp')).toBe(first)
    vi.setSystemTime(new Date('2026-10-19T06:00:01Z'))
    expect(await storage.createDownloadUrl('products/a.webp')).not.toBe(first)
  })

  it('keeps every link valid for at least 90 minutes after it is handed out', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-19T05:59:59Z') })
    const query = new URL(await storage.createDownloadUrl('products/a.webp')).searchParams
    expect(query.get('X-Amz-Date')).toBe('20261019T053000Z')
    expect(Number(query.get('X-Amz-Expires'))).toBe(7200)
  })
})
