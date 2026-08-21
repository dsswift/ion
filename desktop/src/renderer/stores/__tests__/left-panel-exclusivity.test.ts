import { describe, expect, it } from 'vitest'
import { createInboxSlice } from '../slices/inbox-slice'
import { createFileExplorerSlice } from '../slices/file-explorer-slice'

function harness(overrides: Record<string, unknown> = {}) {
  const state: Record<string, any> = {
    tabs: [{ id: 'tab-1', workingDirectory: '/repo' }],
    activeTabId: 'tab-1',
    inboxPanelOpen: false,
    fileExplorerOpenDirs: new Set<string>(),
    ...overrides,
  }
  const set = (update: any) => Object.assign(state, typeof update === 'function' ? update(state) : update)
  const get = () => state
  return {
    state,
    inbox: createInboxSlice(set as any, get as any) as any,
    explorer: createFileExplorerSlice(set as any, get as any) as any,
  }
}

describe('left panel exclusivity', () => {
  it('opening Inbox closes active Explorer', () => {
    const { state, inbox } = harness({ fileExplorerOpenDirs: new Set(['/repo']) })
    inbox.toggleInboxPanel()
    expect(state.inboxPanelOpen).toBe(true)
    expect(state.fileExplorerOpenDirs.has('/repo')).toBe(false)
  })

  it('opening Explorer closes Inbox', () => {
    const { state, explorer } = harness({ inboxPanelOpen: true })
    explorer.toggleFileExplorer('tab-1')
    expect(state.fileExplorerOpenDirs.has('/repo')).toBe(true)
    expect(state.inboxPanelOpen).toBe(false)
  })

  it('closing either panel does not restore its sibling', () => {
    const { state, inbox, explorer } = harness({ inboxPanelOpen: true })
    inbox.toggleInboxPanel()
    expect(state.fileExplorerOpenDirs.size).toBe(0)
    explorer.toggleFileExplorer('tab-1')
    explorer.toggleFileExplorer('tab-1')
    expect(state.inboxPanelOpen).toBe(false)
  })
})
