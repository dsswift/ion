/**
 * The finished push rings once per run, only after the conversation has stayed
 * truly at rest for the whole settle window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rTrace: vi.fn() }))
vi.mock('../questions-read', () => ({ activeQuestionsCount: () => 0 }))
vi.mock('../../thin-view/push-doorbell', () => ({ ringOfflineThinClients: vi.fn() }))

import { FINISHED_PUSH_KIND, setupConversationFinishedPush } from '../conversation-finished-push'
import type { State } from '../session-store-types'

const SETTLE_MS = 5_000

interface InstanceOver {
  agentStates?: Array<{ status: string }>
  statusFields?: Record<string, unknown>
  planFilePath?: string | null
  permissionQueue?: unknown[]
}

function tab(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id, title: `Title ${id}`, customTitle: null, status, isTerminalOnly: false,
    settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null,
    lastCompletionAt: null, lastMessageAt: null, lastActivityAt: null, manualUnread: false, ...over,
  }
}

function pane(over: InstanceOver = {}) {
  return {
    activeInstanceId: 'main',
    instances: [{
      id: 'main', agentStates: [], statusFields: null, planFilePath: null,
      permissionQueue: [], elicitationQueue: [], permissionDenied: null, ...over,
    }],
  }
}

function harness(title: (tab: { id: string }) => string | null = () => null) {
  const listeners = new Set<(next: State, previous: State) => void>()
  let state = { tabsReady: true, tabs: [tab('a', 'idle')], conversationPanes: new Map([['a', pane()]]) } as unknown as State
  const store = {
    getState: () => state,
    subscribe: (listener: (next: State, previous: State) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as StoreApi<State>
  const set = (patch: Record<string, unknown>): void => {
    const previous = state
    state = { ...state, ...patch } as State
    for (const listener of listeners) listener(state, previous)
  }
  const setTab = (status: string, over: Record<string, unknown> = {}): void => set({ tabs: [tab('a', status, over)] })
  const setPane = (over: InstanceOver): void => set({ conversationPanes: new Map([['a', pane(over)]]) })
  const ring = vi.fn()
  const stop = setupConversationFinishedPush(store, { ring, host: () => 'jolteon', title, settleMs: SETTLE_MS })
  return { set, setTab, setPane, ring, stop }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('conversation finished push', () => {
  it('rings once, with the conversation id and the host but no conversation content, after the run stays at rest for the window', () => {
    const h = harness()
    h.setTab('running')
    h.setTab('completed')
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(h.ring).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.ring).toHaveBeenCalledTimes(1)
    expect(h.ring).toHaveBeenCalledWith({ pushTitle: 'Conversation finished', pushBody: 'On jolteon', pushTabId: 'a', notifyKind: FINISHED_PUSH_KIND })

    // The engine's idle tick after a completion is not a second finish.
    h.setTab('idle')
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(h.ring).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it('names the conversation when this server allows titles in pushes', () => {
    const h = harness((tab) => `Title ${tab.id}`)
    h.setTab('running')
    h.setTab('completed')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(h.ring).toHaveBeenCalledWith({ pushTitle: 'Title a', pushBody: 'Finished on jolteon', pushTabId: 'a', notifyKind: FINISHED_PUSH_KIND })
    h.stop()
  })

  it('rings when background work ends a run that was waiting on it', () => {
    const h = harness()
    h.setTab('running')
    // The foreground turn stopped while a background agent still works.
    h.setTab('waiting')
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(h.ring).not.toHaveBeenCalled()
    h.setTab('completed')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(h.ring).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it('never rings for a run that restarts inside the window', () => {
    const h = harness()
    h.setTab('running')
    h.setTab('completed')
    vi.advanceTimersByTime(SETTLE_MS - 100)
    h.setTab('running')
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(h.ring).not.toHaveBeenCalled()
    h.stop()
  })

  it('restarts the window when background work flickers on, and rings only after it has been quiet the whole window', () => {
    const h = harness()
    h.setTab('running')
    h.setTab('completed')
    vi.advanceTimersByTime(SETTLE_MS - 100)
    // A dispatched agent reports running just after the orchestrator idled.
    h.setPane({ agentStates: [{ status: 'running' }] })
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(h.ring).not.toHaveBeenCalled()

    h.setPane({ agentStates: [{ status: 'done' }] })
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(h.ring).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.ring).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it('holds for engine-reported pending work, a pending plan, and a pending ask', () => {
    for (const over of [{ statusFields: { hasPendingWork: true } }, { planFilePath: '/tmp/plan.md' }, { permissionQueue: [{ questionId: 'q' }] }]) {
      const h = harness()
      h.setTab('running')
      h.setPane(over)
      h.setTab('completed')
      vi.advanceTimersByTime(SETTLE_MS * 3)
      expect(h.ring).not.toHaveBeenCalled()
      h.stop()
    }
  })

  it('does not ring for a failed run, an engine starting, or tabs restored at boot', () => {
    const h = harness()
    h.setTab('running')
    h.setTab('failed')
    h.setTab('connecting')
    h.setTab('idle')
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(h.ring).not.toHaveBeenCalled()

    h.set({ tabsReady: false })
    h.setTab('running')
    h.set({ tabsReady: true, tabs: [tab('a', 'completed')] })
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(h.ring).not.toHaveBeenCalled()
    h.stop()
  })

  it('drops the push when the conversation closes inside the window', () => {
    const h = harness()
    h.setTab('running')
    h.setTab('completed')
    h.set({ tabs: [] })
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(h.ring).not.toHaveBeenCalled()
    h.stop()
  })
})
