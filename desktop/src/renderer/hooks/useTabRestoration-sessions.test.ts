import { describe, expect, it, vi } from 'vitest'

vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(),
}))

import { startRestoredSessions } from './useTabRestoration-sessions'

describe('startRestoredSessions', () => {
  it('attaches the active restored session first and limits concurrent attaches to five', async () => {
    const resolvers: Array<() => void> = []
    const calls: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const ensureEngineSession = vi.fn(({ tabId }: { tabId: string }) => {
      calls.push(tabId)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<{ ok: true }>((resolve) => {
        resolvers.push(() => {
          inFlight--
          resolve({ ok: true })
        })
      })
    })
    globalThis.window = { ion: { ensureEngineSession } } as never

    const savedTabs = Array.from({ length: 6 }, (_, index) => ({
      conversationId: `conversation-${index}`,
      workingDirectory: `/workspace/${index}`,
    })) as never
    const restoredTabs = Array.from({ length: 6 }, (_, index) => ({
      tabId: `tab-${index}`,
      index,
    }))

    const done = startRestoredSessions(
      restoredTabs,
      savedTabs,
      4,
      new Map(),
      () => false,
    )

    await Promise.resolve()
    expect(calls).toEqual(['tab-4', 'tab-0', 'tab-1', 'tab-2', 'tab-3'])
    expect(maxInFlight).toBe(5)

    resolvers.splice(0, 5).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['tab-4', 'tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-5'])

    resolvers.splice(0).forEach((resolve) => resolve())
    await done
    expect(maxInFlight).toBe(5)
  })
})
