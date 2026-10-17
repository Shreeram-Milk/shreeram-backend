export type RecurringJobOptions = {
  /** Shown in the log, for example "Payment background check". */
  name: string
  /** One pass. Returns how many things it looked at and how many failed, plus any other counts worth logging. */
  run: () => Promise<{ checked: number; failures: number }>
  /** Delay before the first pass after start-up, and between the end of one pass and the start of the next. */
  firstRunMs: number
  intervalMs: number
  /** A pass that has not finished by then is abandoned (it may be hung on the network or database) and the next one is scheduled. */
  timeoutMs: number
  log: (entry: { level: 'info' | 'error'; message: string; [key: string]: unknown }) => void
}

/**
 * Runs a background job over and over for as long as the server lives: first soon after start-up, then every `intervalMs`
 * after the previous pass ends. Passes never overlap, a failed pass never stops the job, and a pass that hangs is abandoned
 * after `timeoutMs`, so the job cannot silently freeze. Returns a function that stops it.
 */
export function startRecurringJob({ name, run, firstRunMs, intervalMs, timeoutMs, log }: RecurringJobOptions): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  async function pass(): Promise<void> {
    let abandon: NodeJS.Timeout | undefined
    try {
      const timedOut = new Promise<never>((_resolve, reject) => { abandon = setTimeout(() => reject(new Error(`the job did not finish within ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs) })
      const result = await Promise.race([run(), timedOut])
      if (result.checked > 0 || result.failures > 0) log({ level: result.failures > 0 ? 'error' : 'info', message: name, ...result })
    } catch (error) {
      log({ level: 'error', message: `${name} failed`, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      if (abandon) clearTimeout(abandon)
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return
    timer = setTimeout(() => { void pass().finally(() => schedule(intervalMs)) }, delayMs)
    // A background job alone must never keep a shutting-down server alive.
    timer.unref()
  }

  schedule(firstRunMs)
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
