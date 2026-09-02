import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { State } from './session-store-types'
import { setupStudioConversationTerminalSync } from './session-store-terminal-sync'

function storeHarness() {
  const listeners = new Set<(state: State, previous: State) => void>()
  let state = {
    tabsReady: false,
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
  } as unknown as State
  return {
    store: {
      getState: () => state,
      subscribe: (listener: (next: State, previous: State) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as StoreApi<State>,
    set(patch: Partial<State>): void {
      const previous = state
      state = { ...state, ...patch }
      for (const listener of listeners) listener(state, previous)
    },
  }
}

describe('owner Conversation Terminal Panel sync', () => {
  it('publishes once readiness is reached and after terminal state changes', () => {
    const publish = vi.fn()
    ;(globalThis as unknown as { window: { ion: unknown } }).window = {
      ion: { studioPublishConversationTerminals: publish },
    }
    const harness = storeHarness()
    setupStudioConversationTerminalSync(harness.store)
    expect(publish).not.toHaveBeenCalled()

    harness.set({ tabsReady: true })
    expect(publish).toHaveBeenLastCalledWith({ panes: [], openTabIds: [] })

    harness.set({
      terminalPanes: new Map([['tab-a', {
        instances: [{ id: 'service-1', label: 'API', kind: 'user', readOnly: false, cwd: '/repo/api' }],
        activeInstanceId: 'service-1',
      }]]),
      terminalOpenTabIds: new Set(['tab-a']),
    })
    expect(publish).toHaveBeenLastCalledWith({
      panes: [{
        tabId: 'tab-a',
        instances: [{ id: 'service-1', label: 'API', kind: 'user', readOnly: false, cwd: '/repo/api' }],
        activeInstanceId: 'service-1',
      }],
      openTabIds: ['tab-a'],
    })
  })

  it('does not publish for unrelated owner state changes', () => {
    const publish = vi.fn()
    ;(globalThis as unknown as { window: { ion: unknown } }).window = {
      ion: { studioPublishConversationTerminals: publish },
    }
    const harness = storeHarness()
    harness.set({ tabsReady: true })
    setupStudioConversationTerminalSync(harness.store)
    publish.mockClear()

    harness.set({ activeTabId: 'tab-b' })
    expect(publish).not.toHaveBeenCalled()
  })
})
