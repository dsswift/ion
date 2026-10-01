// @vitest-environment jsdom
/**
 * Dropping an Environment's slice of the union store — the rule that an
 * Environment this desktop cannot reach shows nothing at all, rather than a
 * photograph of what it last said.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { hydrateTabsFromSync } from '../secondary-store'
import { dropEnvironmentState } from '../secondary-store-purge'

vi.mock('../../../components/TerminalInstance', () => ({ destroyTerminalInstance: vi.fn() }))

function snapshot(ids: string[], revision?: number): Record<string, unknown> {
  return {
    schemaVersion: 4,
    activeTabIndex: 0,
    ...(revision === undefined ? {} : { revision }),
    tabs: ids.map((id) => ({
      id, conversationId: `${id}-conversation`, title: id, customTitle: null,
      workingDirectory: '/repo', hasChosenDirectory: true, additionalDirs: [],
      conversationPane: { instances: [{ id: 'main', messageCount: 2 }], activeInstanceId: 'main' },
    })),
  }
}

describe('dropEnvironmentState', () => {
  beforeEach(() => {
    useSessionStore.setState({ tabs: [], settledHistory: [], activeTabId: undefined, conversationPanes: new Map(), terminalPanes: new Map(), terminalOpenTabIds: new Set(), tabsReady: false })
    hydrateTabsFromSync(snapshot(['local-1']), 'local')
    hydrateTabsFromSync(snapshot(['devbox-1', 'devbox-2']), 'devbox')
  })

  it('removes every row, pane and worktree slice the environment published, and leaves the others alone', () => {
    useSessionStore.setState({ activeTabId: 'local-1' })
    dropEnvironmentState('devbox')

    const state = useSessionStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(['local-1'])
    expect(state.conversationPanes.has('devbox-1')).toBe(false)
    expect(state.conversationPanes.has('devbox-2')).toBe(false)
    expect(state.conversationPanes.has('local-1')).toBe(true)
  })

  /**
   * Removing the row under the operator's eyes would move the window
   * somewhere it was not asked to go, mid read. The row survives; the
   * transcript does not, and ConversationView renders the offline panel in
   * its place.
   */
  it('keeps the conversation being read as an empty shell rather than yanking the window', () => {
    useSessionStore.setState({ activeTabId: 'devbox-1' })
    const result = dropEnvironmentState('devbox')

    const state = useSessionStore.getState()
    expect(result.keptActiveTabId).toBe('devbox-1')
    expect(state.activeTabId).toBe('devbox-1')
    expect(state.tabs.map((t) => t.id)).toEqual(['local-1', 'devbox-1'])
    // The tab is a shell: its transcript is exactly the stale state.
    expect(state.conversationPanes.has('devbox-1')).toBe(false)
  })

  it('refuses to drop the local environment, which would leave a blank window with nothing to return to', () => {
    useSessionStore.setState({ activeTabId: 'local-1' })
    dropEnvironmentState('local')
    expect(useSessionStore.getState().tabs.map((t) => t.id)).toEqual(['local-1', 'devbox-1', 'devbox-2'])
  })

  /**
   * Revisions are minted per server and restart with it. A cursor kept
   * across a disconnect makes the first snapshot after a restart look stale
   * and drops it, so the rows would not come back until some later revision
   * climbed past the old high-water mark.
   */
  it('clears the environment revision cursor so a restarted server is believed again', () => {
    hydrateTabsFromSync(snapshot(['devbox-1'], 50), 'devbox')
    expect(useSessionStore.getState().tabs.some((t) => t.id === 'devbox-1')).toBe(true)

    dropEnvironmentState('devbox')
    // Revision 1 from a server that restarted its counters: applied, not dropped.
    hydrateTabsFromSync(snapshot(['devbox-3'], 1), 'devbox')
    expect(useSessionStore.getState().tabs.some((t) => t.id === 'devbox-3')).toBe(true)
  })
})
