import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRecurringJob } from '../src/jobs/recurring-job.js'

const options = { name: 'Payment background check', firstRunMs: 1_000, intervalMs: 10_000, timeoutMs: 5_000 }
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a background job', () => {
  it('runs soon after start-up and then again and again, logging only passes that found something', async () => {
    const results = [{ checked: 2, failures: 0 }, { checked: 0, failures: 0 }, { checked: 1, failures: 1 }]
    const run = vi.fn(async () => results.shift() ?? { checked: 0, failures: 0 })
    const log = vi.fn()
    const stop = startRecurringJob({ ...options, run, log })
    await vi.advanceTimersByTimeAsync(999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(3)
    expect(log.mock.calls.map(([entry]) => [entry.level, entry.checked, entry.failures])).toEqual([['info', 2, 0], ['error', 1, 1]])
    stop()
  })

  it('keeps going after a pass throws', async () => {
    const run = vi.fn<() => Promise<{ checked: number; failures: number }>>()
    run.mockRejectedValueOnce(new Error('database down')).mockResolvedValue({ checked: 1, failures: 0 })
    const log = vi.fn()
    const stop = startRecurringJob({ ...options, run, log })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(log).toHaveBeenCalledWith({ level: 'error', message: 'Payment background check failed', reason: 'database down' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenLastCalledWith({ level: 'info', message: 'Payment background check', checked: 1, failures: 0 })
    stop()
  })

  it('abandons a pass that hangs and carries on with the next one, so it can never freeze', async () => {
    const run = vi.fn<() => Promise<{ checked: number; failures: number }>>()
    run.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ checked: 1, failures: 0 })
    const log = vi.fn()
    const stop = startRecurringJob({ ...options, run, log })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(log).toHaveBeenCalledWith({ level: 'error', message: 'Payment background check failed', reason: 'the job did not finish within 5 seconds' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(2)
    stop()
  })

  it('never runs two passes at once and stops when asked', async () => {
    let active = 0
    let peak = 0
    const run = vi.fn(async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 3_000)); active -= 1; return { checked: 0, failures: 0 } })
    const stop = startRecurringJob({ ...options, intervalMs: 500, run, log: vi.fn() })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(peak).toBe(1)
    const calls = run.mock.calls.length
    stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run.mock.calls.length).toBe(calls)
  })
})
