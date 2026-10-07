import { beforeEach, describe, expect, it, vi } from 'vitest'

const createConversationTab = vi.fn().mockResolvedValue('new-tab')
const prefs = { enterpriseNewConversationDefaults: null as null | { locked: boolean; baseDirectory: string; engineProfileId: string } }

vi.mock('../preferences', () => ({ usePreferencesStore: Object.assign(() => undefined, { getState: () => prefs }) }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({ createConversationTab }) } }))
vi.mock('../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))
vi.mock('./settings/environment/environment-client', () => ({ environmentClient: { listProjects: vi.fn().mockResolvedValue([]) } }))
vi.mock('../studio/connection/catalog', () => ({ readConversationCatalog: vi.fn().mockResolvedValue([]) }))
vi.mock('../studio/connection/fleet-reports', () => ({ readFleetReport: vi.fn() }))
vi.mock('../studio/connection/placement', () => ({ placeAmong: vi.fn(), savedPlacementMode: () => 'same' }))
vi.mock('../studio/connection/select-when-present', () => ({ selectTabWhenPresent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../studio/connection/tab-environment', () => ({ tabEnvironmentId: () => 'local', withTargetEnvironment: (_id: string, fn: () => unknown) => fn() }))
vi.mock('../studio/connection/policy-store', () => ({ policyStore: { devicePolicy: () => null, developerSurfacesFor: () => ({ worktrees: true }) } }))

import { openSiblingConversation } from './composer-send-modes'

const tab = { id: 'abcdef123456', workingDirectory: '/data/home/jdoe', engineProfileId: null, worktree: { repoPath: '/data/home/jdoe', sourceBranch: 'main' } } as never

beforeEach(() => { createConversationTab.mockClear(); prefs.enterpriseNewConversationDefaults = null })

describe('openSiblingConversation (send in the background)', () => {
  it('under a directory lock, opens the fresh conversation in the locked folder on the locked profile, with no worktree', async () => {
    prefs.enterpriseNewConversationDefaults = { locked: true, baseDirectory: '/data/home/jdoe/orion', engineProfileId: 'orion' }
    await openSiblingConversation(tab)

    expect(createConversationTab).toHaveBeenCalledWith('/data/home/jdoe/orion', expect.objectContaining({ profileId: 'orion', projectDirectory: '/data/home/jdoe/orion' }))
    expect(createConversationTab.mock.calls[0][1]).not.toHaveProperty('useWorktree')
  })

  it('with no lock, opens beside the conversation it was sent from, worktree included', async () => {
    await openSiblingConversation(tab)

    expect(createConversationTab).toHaveBeenCalledWith('/data/home/jdoe', expect.objectContaining({ useWorktree: true, sourceBranch: 'main' }))
  })
})
