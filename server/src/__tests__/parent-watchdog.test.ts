import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { processIsAlive, startParentWatchdog, supervisorPidFromEnv } from '../parent-watchdog'

describe('parent watchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('exits once the supervisor stops answering and not before', () => {
    let alive = true
    const exit = vi.fn()
    const isAlive = vi.fn(() => alive)
    startParentWatchdog({ pid: 4242, intervalMs: 1000, isAlive, exit })

    vi.advanceTimersByTime(3500)
    expect(isAlive).toHaveBeenCalledTimes(3)
    expect(exit).not.toHaveBeenCalled()

    alive = false
    vi.advanceTimersByTime(1000)
    expect(exit).toHaveBeenCalledWith(0)
    // Stopped after firing: no further probes.
    vi.advanceTimersByTime(5000)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('stop() ends the watch without exiting', () => {
    const exit = vi.fn()
    const stop = startParentWatchdog({ pid: 4242, intervalMs: 1000, isAlive: () => false, exit })
    stop()
    vi.advanceTimersByTime(5000)
    expect(exit).not.toHaveBeenCalled()
  })

  it('reads the supervisor pid from the environment the desktop sets', () => {
    expect(supervisorPidFromEnv({ ION_SUPERVISOR_PID: '123' })).toBe(123)
    expect(supervisorPidFromEnv({})).toBeNull()
    expect(supervisorPidFromEnv({ ION_SUPERVISOR_PID: 'abc' })).toBeNull()
    expect(supervisorPidFromEnv({ ION_SUPERVISOR_PID: '0' })).toBeNull()
  })

  it('treats this process as alive and a never-assigned pid as gone', () => {
    expect(processIsAlive(process.pid)).toBe(true)
    // Beyond any real pid range on every supported platform.
    expect(processIsAlive(2 ** 22 - 7)).toBe(false)
  })
})
