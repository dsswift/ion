/**
 * createTabForClient is how a client that is not the desktop makes a
 * conversation. Three behaviors set it apart from the store's own create
 * actions, and each is pinned here because a Studio client calling the raw
 * store action would get none of them:
 *   - the desktop's active tab is left where it was;
 *   - no directory means the configured default;
 *   - a repeated clientCmdId answers the tab the first delivery made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => {
  const store = {
    activeTabId: 'desk-tab' as string | null,
    createTabInDirectory: vi.fn(),
    createConversationTab: vi.fn(),
    createTerminalTab: vi.fn(),
    addTerminalInstance: vi.fn(async () => 'inst-1'),
    tabs: [] as Array<{ id: string }>,
    terminalPanes: new Map<string, { instances: Array<{ id: string; label: string; kind: string; cwd: string }> }>(),
  }
  return { store, settings: { defaultBaseDirectory: '/base' } as Record<string, unknown>, sendRemoteEvent: vi.fn() }
})
vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: { getState: () => deps.store, setState: (patch: Record<string, unknown>) => { Object.assign(deps.store, patch) } },
}))
vi.mock('../../../persistence/settings-store', () => ({ readSettings: () => deps.settings }))
vi.mock('../../../thin-view/remote-out', () => ({ sendRemoteEvent: deps.sendRemoteEvent }))
vi.mock('../../snapshot', () => ({ getRemoteTabStates: vi.fn(async () => ({ tabs: [] })), refreshRendererSnapshotCache: vi.fn(async () => undefined) }))
vi.mock('../../../state', () => ({ state: {}, terminalScrollback: new Map() }))
vi.mock('../../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../../terminal/terminal-manager-instance', () => ({ terminalManager: { activitySnapshot: () => [] } }))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { createTabForClient, createTerminalTabForClient } from '../tabs-create-echo'

/** A store create that does what the real one does: makes the new tab active. */
const creating = (tabId: string) => async () => { deps.store.activeTabId = tabId; return tabId }

beforeEach(() => {
  deps.store.activeTabId = 'desk-tab'
  deps.store.createTabInDirectory.mockReset().mockImplementation(creating('t-plain'))
  // One store entry point serves both kinds; the profile is what makes it an
  // extension-hosted conversation.
  deps.store.createConversationTab.mockReset().mockImplementation(async (_dir: string, opts?: { profileId?: string }) =>
    creating(opts?.profileId ? 't-ext' : 't-plain')())
  deps.store.createTerminalTab.mockReset().mockImplementation(creating('t-term'))
  deps.store.tabs = [{ id: 't-term' }]
})

describe('createTabForClient', () => {
  it('leaves the desktop on the tab it was on', async () => {
    expect(await createTabForClient({ workingDirectory: '/repo' })).toBe('t-plain')
    expect(deps.store.activeTabId).toBe('desk-tab')
  })

  it('creates a plain conversation with the placement the client named, skipping the duplicate check', async () => {
    await createTabForClient({ workingDirectory: '/repo', useWorktree: true, sourceBranch: 'main' })
    expect(deps.store.createConversationTab).toHaveBeenCalledWith('/repo', { setActive: true, useWorktree: true, sourceBranch: 'main', ephemeralWorktree: undefined })
    expect(deps.store.createTabInDirectory).not.toHaveBeenCalled()
  })

  it('passes an ephemeral worktree request through for both conversation kinds', async () => {
    await createTabForClient({ workingDirectory: '/repo', useWorktree: true, sourceBranch: 'main', ephemeralWorktree: true })
    expect(deps.store.createConversationTab).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ ephemeralWorktree: true }))
    await createTabForClient({ workingDirectory: '/repo', profileId: 'example-profile', useWorktree: true, ephemeralWorktree: false })
    expect(deps.store.createConversationTab).toHaveBeenLastCalledWith('/repo', expect.objectContaining({ profileId: 'example-profile', ephemeralWorktree: false }))
  })

  it('creates an extension-hosted conversation when a profile is named', async () => {
    expect(await createTabForClient({ workingDirectory: '/repo', profileId: 'example-profile', useWorktree: true, sourceBranch: 'main' })).toBe('t-ext')
    expect(deps.store.createConversationTab).toHaveBeenCalledWith('/repo', { profileId: 'example-profile', useWorktree: true, sourceBranch: 'main', ephemeralWorktree: undefined })
    expect(deps.store.createTabInDirectory).not.toHaveBeenCalled()
  })

  it('falls back to the configured default directory', async () => {
    await createTabForClient({})
    expect(deps.store.createConversationTab).toHaveBeenCalledWith('/base', { setActive: true, useWorktree: undefined, sourceBranch: undefined, ephemeralWorktree: undefined })
  })

  it('answers the first tab for a repeated clientCmdId instead of making another', async () => {
    expect(await createTabForClient({ workingDirectory: '/repo', clientCmdId: 'cmd-repeat' })).toBe('t-plain')
    expect(await createTabForClient({ workingDirectory: '/repo', clientCmdId: 'cmd-repeat' })).toBe('t-plain')
    expect(deps.store.createConversationTab).toHaveBeenCalledTimes(1)
  })

  it('answers null when the store refuses', async () => {
    deps.store.createConversationTab.mockRejectedValue(new Error('no such directory'))
    expect(await createTabForClient({ workingDirectory: '/gone' })).toBeNull()
  })
})

describe('createTerminalTabForClient', () => {
  it('makes the tab and its first shell without moving the desktop', async () => {
    expect(await createTerminalTabForClient({ workingDirectory: '/repo' })).toBe('t-term')
    expect(deps.store.createTerminalTab).toHaveBeenCalledWith('/repo')
    expect(deps.store.addTerminalInstance).toHaveBeenCalledWith('t-term', 'user', undefined, undefined, undefined)
    expect(deps.store.activeTabId).toBe('desk-tab')
  })
})
