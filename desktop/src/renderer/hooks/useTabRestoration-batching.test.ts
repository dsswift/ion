import { describe, expect, it } from 'vitest'
import { SESSION_ATTACH_BATCH_SIZE } from '../../shared/session-attach-policy'
import {
  orderSessionCandidates,
  startSessionsInBatches,
} from './useTabRestoration-helpers'

describe('restored session attach batching', () => {
  it('starts the active session first and caps each batch at five', async () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
      tabId: `tab-${index}`,
      index,
    }))
    const ordered = orderSessionCandidates(items, 7)
    const started: string[] = []
    const resolvers: Array<() => void> = []
    let inFlight = 0
    let maxInFlight = 0

    const done = startSessionsInBatches(ordered, (item) => {
      started.push(item.tabId)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          inFlight--
          resolve()
        })
      })
    })

    await Promise.resolve()
    expect(started).toEqual(['tab-7', 'tab-0', 'tab-1', 'tab-2', 'tab-3'])
    expect(maxInFlight).toBe(SESSION_ATTACH_BATCH_SIZE)

    resolvers.splice(0, SESSION_ATTACH_BATCH_SIZE).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toHaveLength(10)

    resolvers.splice(0).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toHaveLength(11)

    resolvers.splice(0).forEach((resolve) => resolve())
    await done
    expect(maxInFlight).toBe(SESSION_ATTACH_BATCH_SIZE)
  })

  it('reports each completed attach and continues after an attach failure', async () => {
    const progress: Array<[number, number]> = []
    const started: string[] = []

    await startSessionsInBatches(['a', 'b', 'c'], async (item) => {
      started.push(item)
      if (item === 'b') throw new Error('attach failed')
    }, (completed, total) => progress.push([completed, total]))

    expect(started).toEqual(['a', 'b', 'c'])
    expect(progress).toHaveLength(3)
    expect(progress.map(([completed]) => completed).sort()).toEqual([1, 2, 3])
    expect(progress.every(([, total]) => total === 3)).toBe(true)
  })
})
