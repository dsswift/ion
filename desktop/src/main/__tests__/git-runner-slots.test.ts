/**
 * Pins the git-subprocess semaphore: a caller storm is bounded to the cap and
 * drains as an ordered queue instead of saturating the event loop — the
 * backstop behind the worktree-inventory spawn-storm fix.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { withGitSlot } from '../git-runner'

describe('withGitSlot', () => {
  it('bounds concurrency to the cap while completing every task', async () => {
    let active = 0
    let peak = 0
    let completed = 0

    await Promise.all(Array.from({ length: 20 }, () =>
      withGitSlot(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active--
        completed++
      })))

    expect(completed).toBe(20)
    expect(peak).toBeLessThanOrEqual(6)
    // The cap must actually admit parallelism, not serialize everything.
    expect(peak).toBeGreaterThan(1)
  })

  it('releases the slot when the task rejects, so failures cannot leak the pool dry', async () => {
    const failures = Array.from({ length: 12 }, (_, i) =>
      withGitSlot(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        throw new Error(`boom ${i}`)
      }).catch((err: Error) => err.message))
    expect(await Promise.all(failures)).toHaveLength(12)

    // Every slot must be free again: a full-width batch still bounds and completes.
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 6 }, () =>
      withGitSlot(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active--
      })))
    expect(peak).toBe(6)
  })

  it('returns the task result', async () => {
    expect(await withGitSlot(async () => 'stdout')).toBe('stdout')
  })
})
