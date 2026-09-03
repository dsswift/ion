// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioConversationTerminalSnapshot } from '../../../../shared/studio-conversation-terminal-sync'

const { destroyed } = vi.hoisted(() => ({ destroyed: vi.fn() }))
vi.mock('../../../components/TerminalInstance', () => ({
  destroyTerminalInstance: destroyed,
  serializeTerminalBuffer: vi.fn(),
}))

const ion = {
  studioGetConversationTerminals: vi.fn(),
  onStudioConversationTerminals: vi.fn(() => () => {}),
}
;(globalThis as unknown as { window: { ion: unknown } }).window = {
  ion: ion as unknown,
}

import { useSessionStore } from '../../../stores/sessionStore'
import { hydrateConversationTerminals } from '../secondary-store'

function snapshot(revision: number, overrides: Partial<StudioConversationTerminalSnapshot> = {}): StudioConversationTerminalSnapshot {
  return {
    revision,
    panes: [{
      tabId: 'tab-a',
      instances: [{ id: 'service-1', label: 'API', kind: 'user', readOnly: false, cwd: '/repo/api' }],
      activeInstanceId: 'service-1',
    }],
    openTabIds: ['tab-a'],
    ...overrides,
  }
}

describe('Conversation Terminal Panel Studio sync', () => {
  beforeEach(() => {
    destroyed.mockClear()
    useSessionStore.setState({
      terminalPanes: new Map(),
      terminalOpenTabIds: new Set(),
      terminalTallTabId: null,
      terminalBigScreenTabId: null,
    })
  })

  it('hydrates the exact owner terminal identity and panel visibility', () => {
    expect(hydrateConversationTerminals(snapshot(100))).toBe(true)

    const state = useSessionStore.getState()
    expect(state.terminalOpenTabIds).toEqual(new Set(['tab-a']))
    expect(state.terminalPanes.get('tab-a')).toEqual({
      instances: [{ id: 'service-1', label: 'API', kind: 'user', readOnly: false, cwd: '/repo/api' }],
      activeInstanceId: 'service-1',
    })
    expect(`tab-a:${state.terminalPanes.get('tab-a')!.instances[0].id}`).toBe('tab-a:service-1')
    expect(`tab-a:${state.terminalPanes.get('tab-a')!.instances[0].id}`).not.toContain(':surface:')
  })

  it('replaces metadata, selection, order, and open state from a newer snapshot', () => {
    hydrateConversationTerminals(snapshot(200))
    const next = snapshot(201, {
      panes: [{
        tabId: 'tab-a',
        instances: [
          { id: 'service-2', label: 'Web', kind: 'user', readOnly: true, cwd: '/repo/web' },
          { id: 'service-1', label: 'API renamed', kind: 'user', readOnly: false, cwd: '/repo/api' },
        ],
        activeInstanceId: 'service-2',
      }],
      openTabIds: [],
    })

    expect(hydrateConversationTerminals(next)).toBe(true)
    const state = useSessionStore.getState()
    expect(state.terminalPanes.get('tab-a')?.instances.map((instance) => instance.id))
      .toEqual(['service-2', 'service-1'])
    expect(state.terminalPanes.get('tab-a')?.activeInstanceId).toBe('service-2')
    expect(state.terminalPanes.get('tab-a')?.instances[1].label).toBe('API renamed')
    expect(state.terminalPanes.get('tab-a')?.instances[0].readOnly).toBe(true)
    expect(state.terminalOpenTabIds.size).toBe(0)
  })

  it('disposes only the local viewer when the owner removes a terminal', () => {
    hydrateConversationTerminals(snapshot(300))
    hydrateConversationTerminals(snapshot(301, { panes: [], openTabIds: [] }))

    expect(destroyed).toHaveBeenCalledWith('tab-a:service-1')
    expect(useSessionStore.getState().terminalPanes.size).toBe(0)
  })

  it('rejects stale and malformed snapshots without changing valid state', () => {
    hydrateConversationTerminals(snapshot(400))
    expect(hydrateConversationTerminals(snapshot(399, { panes: [], openTabIds: [] }))).toBe(false)
    expect(hydrateConversationTerminals({ revision: 401, panes: 'bad', openTabIds: [] })).toBe(false)

    expect(useSessionStore.getState().terminalPanes.get('tab-a')?.instances[0].id).toBe('service-1')
  })
})
