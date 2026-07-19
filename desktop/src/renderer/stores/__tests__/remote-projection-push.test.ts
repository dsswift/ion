/**
 * Tests for startRemoteProjectionPush — the debounced renderer-push wiring.
 *
 * Pins the push semantics of the renderer-push snapshot architecture:
 *   - one push at startup (seeds the main-process cache)
 *   - N rapid store changes collapse to ONE push after the trailing window
 *   - unchanged projection → push suppressed (fingerprint gate)
 *   - changed projection → pushed
 *   - stop() unsubscribes and cancels a pending timer
 *
 * Uses the injected-deps seam (startRemoteProjectionPush) so no zustand store
 * or preload bridge is involved; fake timers drive the debounce.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startRemoteProjectionPush, PUSH_DEBOUNCE_MS } from '../remote-projection-push'
import type { ProjectionStoreState } from '../remote-projection'

// Node-pure import of remote-projection (transitively TabStripShared) — same
// stubs as remote-projection.test.ts.
vi.mock('@phosphor-icons/react', () => ({
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))
vi.mock('../sessionStore', () => ({
  useSessionStore: { getState: () => ({}), subscribe: () => () => {} },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

function makeState(tabIds: string[]): ProjectionStoreState {
  return {
    tabs: tabIds.map((id) => ({
      id,
      title: `Tab ${id}`,
      customTitle: null,
      status: 'idle',
      workingDirectory: '/p',
      conversationId: null,
      contextTokens: null,
      contextWindow: null,
      queuedPrompts: [],
      groupId: null,
      groupPinned: false,
      pillColor: null,
      pillIcon: null,
      engineProfileId: null,
      isTerminalOnly: false,
      lastResult: null,
    })) as any,
    terminalPanes: new Map(),
    conversationPanes: new Map(),
    resources: {},
    readResourceIds: new Set(),
    engineModelFallbacks: new Map(),
    computeConvFingerprint: () => '',
  }
}

describe('startRemoteProjectionPush', () => {
  let listeners: Array<() => void>
  let pushed: unknown[]
  let current: ProjectionStoreState
  let stop: (() => void) | null

  const deps = () => ({
    getState: () => current,
    subscribe: (l: () => void) => {
      listeners.push(l)
      return () => {
        listeners = listeners.filter((x) => x !== l)
      }
    },
    push: (payload: unknown) => {
      pushed.push(payload)
    },
  })

  const fireStoreChange = () => listeners.forEach((l) => l())

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = []
    pushed = []
    current = makeState(['t1'])
    stop = null
  })

  afterEach(() => {
    stop?.()
    vi.useRealTimers()
  })

  it('pushes once immediately at startup', () => {
    stop = startRemoteProjectionPush(deps())
    expect(pushed).toHaveLength(1)
    expect((pushed[0] as any).tabs[0].id).toBe('t1')
  })

  it('collapses N rapid store changes into ONE push after the trailing window', () => {
    stop = startRemoteProjectionPush(deps())
    pushed.length = 0
    current = makeState(['t1', 't2'])
    // Burst: 10 store mutations inside the debounce window.
    for (let i = 0; i < 10; i++) fireStoreChange()
    expect(pushed).toHaveLength(0) // nothing until the window elapses
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS)
    expect(pushed).toHaveLength(1)
    expect((pushed[0] as any).tabs).toHaveLength(2)
  })

  it('suppresses the push when the projection is unchanged (fingerprint gate)', () => {
    stop = startRemoteProjectionPush(deps())
    pushed.length = 0
    // Store changed (e.g. per-window UI state) but projection output identical.
    fireStoreChange()
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS)
    expect(pushed).toHaveLength(0)
  })

  it('pushes again when the projection changes after a suppressed cycle', () => {
    stop = startRemoteProjectionPush(deps())
    pushed.length = 0
    fireStoreChange()
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS)
    expect(pushed).toHaveLength(0)
    current = makeState(['t1', 't2', 't3'])
    fireStoreChange()
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS)
    expect(pushed).toHaveLength(1)
    expect((pushed[0] as any).tabs).toHaveLength(3)
  })

  it('debounce is trailing: a change mid-window does not reset the timer start', () => {
    stop = startRemoteProjectionPush(deps())
    pushed.length = 0
    current = makeState(['t1', 't2'])
    fireStoreChange()
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS - 50)
    fireStoreChange() // second change inside the pending window
    vi.advanceTimersByTime(50) // original window elapses
    expect(pushed).toHaveLength(1)
  })

  it('stop() unsubscribes and cancels the pending timer', () => {
    stop = startRemoteProjectionPush(deps())
    pushed.length = 0
    current = makeState(['t1', 't2'])
    fireStoreChange()
    stop()
    stop = null
    expect(listeners).toHaveLength(0)
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS * 2)
    expect(pushed).toHaveLength(0)
  })

  it('a projection failure is swallowed (logged) and does not break the subscription', () => {
    stop = startRemoteProjectionPush(deps())
    pushed.length = 0
    // Poison getState so projection throws.
    const good = current
    current = null as unknown as ProjectionStoreState
    fireStoreChange()
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS)
    expect(pushed).toHaveLength(0)
    // Recovery: next change with a valid state pushes normally.
    current = makeState(['t1', 't2'])
    void good
    fireStoreChange()
    vi.advanceTimersByTime(PUSH_DEBOUNCE_MS)
    expect(pushed).toHaveLength(1)
  })
})
