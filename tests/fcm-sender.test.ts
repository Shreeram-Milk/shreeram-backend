import { describe, expect, it, vi } from 'vitest'
import { createFcmSender, type MulticastClient } from '../src/integrations/push/fcm.js'

const message = { title: 'Hello', body: 'World', link: '/notifications', channel: 'offers' as const }
const phones = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `phone-token-${from + index}-0000000000`)
type Outcome = { success: boolean; error?: { code: string } }
const ok: Outcome = { success: true }
const failed = (code: string): Outcome => ({ success: false, error: { code } })

/** A stand-in for Firebase that answers each call from a script; a thrown error means the whole request failed. */
function scripted(steps: Array<(tokens: string[]) => Outcome[] | Error>) {
  const calls: string[][] = []
  const client: MulticastClient = {
    async sendEachForMulticast({ tokens }) {
      calls.push(tokens)
      const step = steps[calls.length - 1] ?? (() => tokens.map(() => ok))
      const answer = step(tokens)
      if (answer instanceof Error) throw answer
      return { responses: answer }
    },
  }
  return { client, calls }
}
const sender = (client: MulticastClient) => createFcmSender({}, { client, retryDelayMs: 0 })

describe('sending to phones through Firebase', () => {
  it('counts every phone reached and switches off addresses that no longer exist', async () => {
    const { client } = scripted([tokens => tokens.map((_, index) => (index === 1 ? failed('messaging/registration-token-not-registered') : ok))])
    const result = await sender(client).send(phones(3), message)
    expect(result).toEqual({ sent: 2, invalidTokens: [phones(3)[1]] })
  })

  it('tries phones that failed for a temporary reason once more, and counts them when they then succeed', async () => {
    const { client, calls } = scripted([tokens => tokens.map((_, index) => (index === 0 ? failed('messaging/server-unavailable') : ok)), tokens => tokens.map(() => ok)])
    const result = await sender(client).send(phones(3), message)
    expect(result.sent).toBe(3)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([phones(3)[0]])
  })

  it('tries a batch again when the whole request fails, and does not lose it', async () => {
    const { client, calls } = scripted([() => new Error('network down'), tokens => tokens.map(() => ok)])
    const result = await sender(client).send(phones(4), message)
    expect(result.sent).toBe(4)
    expect(calls).toHaveLength(2)
  })

  it('never lets one batch that keeps failing stop the batches after it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 501 phones is two batches: the first fails twice, the second must still go out.
    const { client, calls } = scripted([() => new Error('down'), () => new Error('still down'), tokens => tokens.map(() => ok)])
    const result = await sender(client).send(phones(501), message)
    expect(result.sent).toBe(1)
    expect(calls).toHaveLength(3)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('gives up quietly on a phone that keeps failing for a temporary reason, without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const busy = (tokens: string[]) => tokens.map(() => failed('messaging/internal-error'))
    const { client } = scripted([busy, busy])
    await expect(sender(client).send(phones(2), message)).resolves.toEqual({ sent: 0, invalidTokens: [] })
    warn.mockRestore()
  })

  it('does not retry a phone that failed for a lasting reason other than a removed address', async () => {
    const { client, calls } = scripted([tokens => tokens.map(() => failed('messaging/third-party-auth-error'))])
    const result = await sender(client).send(phones(2), message)
    expect(result).toEqual({ sent: 0, invalidTokens: [] })
    expect(calls).toHaveLength(1)
  })

  it('sends delivery messages with high priority and offers with normal priority, on their own channel', async () => {
    const seen: Array<{ priority: string; channelId: string }> = []
    const client: MulticastClient = { async sendEachForMulticast(m) { seen.push({ priority: m.android.priority, channelId: m.android.notification.channelId }); return { responses: m.tokens.map(() => ok) } } }
    await sender(client).send(phones(1), { ...message, channel: 'deliveries' })
    await sender(client).send(phones(1), message)
    expect(seen).toEqual([{ priority: 'high', channelId: 'deliveries' }, { priority: 'normal', channelId: 'offers' }])
  })
})
