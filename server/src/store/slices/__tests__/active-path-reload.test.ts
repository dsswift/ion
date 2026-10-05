/**
 * A branch switch names no rows: the store rebuilds the active instance's
 * transcript from the engine's history of the new path and hands every
 * attached client the replacement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../session-store-helpers', () => {
  let n = 0
  return { nextMsgId: vi.fn(() => `msg-${++n}`) }
})
const host = vi.hoisted(() => ({
  loadChainHistory: vi.fn(),
  engineBroadcastHistory: vi.fn(async () => undefined),
}))
vi.mock('../../host-api', () => host)
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))

import { reloadActivePath } from '../active-path-reload'
import type { State } from '../../session-store-types'

type Pane = { instances: Array<Record<string, unknown>>; activeInstanceId: string }

function store(conversationId: string | null) {
  const state = {
    tabs: [{ id: 'tab-1', conversationId, historicalSessionIds: ['old-conv'] }],
    conversationPanes: new Map<string, Pane>([['tab-1', {
      activeInstanceId: 'main',
      instances: [{ id: 'main', messages: [{ id: 'x', role: 'user', content: 'plan B' }], messageCount: 1, permissionDenied: null }],
    }]]),
  }
  const get = () => state as unknown as State
  const set = (fn: (s: State) => Partial<State>) => { Object.assign(state, fn(state as unknown as State)) }
  return { state, get, set }
}

beforeEach(() => {
  host.loadChainHistory.mockReset()
  host.engineBroadcastHistory.mockClear()
})

describe('reloadActivePath', () => {
  it('replaces the transcript with the new path and broadcasts it', async () => {
    host.loadChainHistory.mockResolvedValue([
      { id: 'e1', role: 'user', content: 'hello' },
      { id: 'e2', role: 'assistant', content: 'hi' },
      { id: 'e3', role: 'user', content: 'plan A' },
    ])
    const { state, get, set } = store('conv-1')

    await reloadActivePath(set as never, get, 'tab-1', { type: 'active_path_changed', conversationId: 'conv-1', leafId: 'e3', previousLeafId: 'x' })

    expect(host.loadChainHistory).toHaveBeenCalledWith(['old-conv', 'conv-1'])
    const inst = state.conversationPanes.get('tab-1')!.instances[0] as { messages: Array<{ content: string }>; messageCount: number; historyHydrated: boolean }
    expect(inst.messages.map((m) => m.content)).toEqual(['hello', 'hi', 'plan A'])
    expect(inst.messageCount).toBe(3)
    expect(inst.historyHydrated).toBe(true)
    expect(host.engineBroadcastHistory).toHaveBeenCalledWith('tab-1', null)
  })

  it('leaves the transcript alone when the event names another conversation or the load fails', async () => {
    const other = store('conv-1')
    await reloadActivePath(other.set as never, other.get, 'tab-1', { type: 'active_path_changed', conversationId: 'conv-9', leafId: 'e3' })
    expect(host.loadChainHistory).not.toHaveBeenCalled()

    host.loadChainHistory.mockRejectedValue(new Error('engine down'))
    const failing = store('conv-1')
    await reloadActivePath(failing.set as never, failing.get, 'tab-1', { type: 'active_path_changed', conversationId: 'conv-1', leafId: 'e3' })
    const inst = failing.state.conversationPanes.get('tab-1')!.instances[0] as { messages: Array<{ content: string }> }
    expect(inst.messages.map((m) => m.content)).toEqual(['plan B'])
    expect(host.engineBroadcastHistory).not.toHaveBeenCalled()
  })
})
