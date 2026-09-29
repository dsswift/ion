/**
 * A client's per-instance tab settings must land on the store this process
 * owns. Renaming and pill colour reach the store as ordinary forwarded Studio
 * actions (see FORWARDED_ACTIONS); permission mode and thinking effort do not,
 * because they are per-INSTANCE state the store exposes no single action for —
 * these two appliers are that seam, and are what the Studio action calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Instance = { id: string; permissionMode?: string; thinkingEffort?: string }
type Pane = { activeInstanceId: string | null; instances: Instance[] }

const h = vi.hoisted(() => ({
  renameTab: vi.fn(),
  renameTerminalInstance: vi.fn(),
  setTabPillColor: vi.fn(),
  broadcast: vi.fn(),
  storeState: {
    tabs: [] as Array<{ id: string }>,
    conversationPanes: new Map<string, { activeInstanceId: string | null; instances: Array<{ id: string; permissionMode?: string; thinkingEffort?: string }> }>(),
  },
}))

vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      ...h.storeState,
      renameTab: h.renameTab,
      renameTerminalInstance: h.renameTerminalInstance,
      setTabPillColor: h.setTabPillColor,
    }),
    setState: (fn: (s: typeof h.storeState) => Partial<typeof h.storeState>) => {
      Object.assign(h.storeState, fn(h.storeState))
    },
  },
}))
vi.mock('../../../broadcast', () => ({ broadcast: h.broadcast }))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../../terminal/terminal-manager-instance', () => ({ terminalManager: {} }))

import { applyRemotePermissionMode, applyRemoteThinkingEffort } from '../remote-instance-state'

function activeInstance(tabId: string): Instance {
  const pane = h.storeState.conversationPanes.get(tabId) as Pane
  return pane.instances.find((i) => i.id === pane.activeInstanceId) as Instance
}

beforeEach(() => {
  vi.clearAllMocks()
  h.storeState.tabs = [{ id: 'tab-1' }]
  h.storeState.conversationPanes = new Map([
    ['tab-1', { activeInstanceId: 'i2', instances: [{ id: 'i1', permissionMode: 'auto' }, { id: 'i2', permissionMode: 'auto' }] }],
  ])
})

describe('applyRemotePermissionMode', () => {
  it('records the mode on the named tab active instance only', () => {
    expect(applyRemotePermissionMode('tab-1', 'plan')).toBe(true)
    expect(activeInstance('tab-1').permissionMode).toBe('plan')
    expect((h.storeState.conversationPanes.get('tab-1') as Pane).instances[0].permissionMode).toBe('auto')
  })

  it('reports false for a tab with no pane', () => {
    expect(applyRemotePermissionMode('missing', 'plan')).toBe(false)
  })

})

describe('applyRemoteThinkingEffort', () => {
  it('records the effort on the named tab active instance', () => {
    expect(applyRemoteThinkingEffort('tab-1', 'high')).toBe(true)
    expect(activeInstance('tab-1').thinkingEffort).toBe('high')
  })

  it('reports false for a tab with no pane', () => {
    expect(applyRemoteThinkingEffort('missing', 'high')).toBe(false)
  })
})
