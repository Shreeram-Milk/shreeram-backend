/**
 * Remembers one answer for a short time, so thousands of phones asking for the same public content cost the database
 * one query per interval instead of one per phone. Phones that ask while it is being fetched share that one fetch.
 *
 * It lives in this server's memory. With several servers each keeps its own copy, so a change shows up everywhere
 * within one interval at most; that is acceptable for public content (banners, slides, settings), never for orders
 * or balances. A failed fetch is never remembered.
 */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now) {
  type Entry = { key: string; expiresAt: number; value: Promise<T> }
  let entry: Entry | null = null
  return {
    /** The remembered value for `key` if it is still fresh; otherwise runs `load` once and remembers its result. */
    get(key: string, load: () => Promise<T>): Promise<T> {
      if (entry && entry.key === key && entry.expiresAt > now()) return entry.value
      const created: Entry = { key, expiresAt: now() + ttlMs, value: load() }
      entry = created
      created.value.catch(() => { if (entry === created) entry = null })
      return created.value
    },
    /** Forgets the value. Called after an admin change, so this server shows the change immediately. */
    clear(): void { entry = null },
  }
}
