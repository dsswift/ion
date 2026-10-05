// @vitest-environment jsdom
/**
 * Sending in the background opens a fresh conversation like the one sent
 * to; queueing for spare quota hands the prompt to the server to hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ createConversationTab: vi.fn(), deferSend: vi.fn(), tabs: [] as unknown[] }))
const wire = vi.hoisted(() => ({ target: '', catalog: [] as Array<{ id: string; label: string }>, projects: {} as Record<string, unknown[]>, pick: null as null | { id: string; reason: string }, select: vi.fn(async () => {}), worktrees: true }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => store } }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../settings/environment/environment-client', () => ({ environmentClient: { listProjects: async (env: string) => wire.projects[env] ?? [] } }))
vi.mock('../../studio/connection/catalog', () => ({ readConversationCatalog: async () => wire.catalog }))
vi.mock('../../studio/connection/draft-lock', () => ({ refusalForDraftEnvironment: () => null }))
vi.mock('../../studio/connection/fleet-reports', () => ({ readFleetReport: async () => {} }))
vi.mock('../../studio/connection/placement', () => ({ savedPlacementMode: () => localStorage.getItem('mode') ?? 'manual', placeAmong: () => ({ pick: wire.pick, scores: [] }) }))
vi.mock('../../studio/connection/policy-store', () => ({ policyStore: { devicePolicy: () => null, developerSurfacesFor: () => ({ worktrees: wire.worktrees }) } }))
vi.mock('../../studio/connection/select-when-present', () => ({ selectTabWhenPresent: wire.select }))
vi.mock('../../studio/connection/tab-environment', () => ({
  tabEnvironmentId: (tab: { environmentId?: string }) => tab.environmentId ?? 'local',
  withTargetEnvironment: (env: string, fn: () => unknown) => { wire.target = env; return fn() },
}))

const { openSiblingConversation, queueForSpareQuota } = await import('../composer-send-modes')

const plain = { id: 'tab-1', workingDirectory: '/src/app', worktree: null, engineProfileId: 'p1', environmentId: 'local' } as never
const inWorktree = { id: 'tab-2', workingDirectory: '/wt/app-1', worktree: { repoPath: '/src/app', sourceBranch: 'main', worktreePath: '/wt/app-1', branchName: 'wt/1' }, engineProfileId: null, environmentId: 'local' } as never

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  store.createConversationTab.mockResolvedValue('new-tab')
  wire.catalog = [{ id: 'local', label: 'This Mac' }, { id: 'env-g', label: 'devbox' }]
  wire.projects = { local: [{ dir: '/src/app', entry: { repoRemote: 'example.org/org/app' } }], 'env-g': [{ dir: '/home/u/app', entry: { repoRemote: 'example.org/org/app' } }] }
  wire.pick = null
})

describe('a background send', () => {
  it('opens and selects a fresh conversation in the same project, with the same profile, on the same machine', async () => {
    expect(await openSiblingConversation(plain)).toBe('new-tab')
    expect(wire.target).toBe('local')
    expect(store.createConversationTab).toHaveBeenCalledWith('/src/app', { profileId: 'p1', projectDirectory: '/src/app' })
    expect(wire.select).toHaveBeenCalledWith('new-tab')
  })

  it('cuts a new worktree from the same branch when the source lives in one', async () => {
    await openSiblingConversation(inWorktree)
    expect(store.createConversationTab).toHaveBeenCalledWith('/src/app', { useWorktree: true, sourceBranch: 'main', projectDirectory: '/src/app' })
  })

  it('on Auto opens on the checkout with the most room, by that machine\'s own path and without a profile from another server', async () => {
    localStorage.setItem('mode', 'auto')
    wire.pick = { id: 'env-g', reason: '80% room' }
    await openSiblingConversation(plain)
    expect(wire.target).toBe('env-g')
    expect(store.createConversationTab).toHaveBeenCalledWith('/home/u/app', { projectDirectory: '/home/u/app' })
  })

  it('stays beside its source on Auto when no other machine has the repository', async () => {
    localStorage.setItem('mode', 'auto')
    wire.projects['env-g'] = []
    wire.pick = { id: 'env-g', reason: 'x' }
    await openSiblingConversation(plain)
    expect(wire.target).toBe('local')
  })
})

describe('queueing for spare quota', () => {
  it('has the server hold the trimmed prompt, and reports a refusal so the text is kept', async () => {
    store.deferSend.mockReturnValueOnce(true)
    expect(await queueForSpareQuota('tab-1', ' run the audit ')).toBe(true)
    expect(store.deferSend).toHaveBeenCalledWith('tab-1', 'run the audit', 'spare-quota')
    store.deferSend.mockReturnValueOnce(Promise.resolve(false))
    expect(await queueForSpareQuota('tab-1', 'again')).toBe(false)
    expect(await queueForSpareQuota('tab-1', '   ')).toBe(false)
  })
})
