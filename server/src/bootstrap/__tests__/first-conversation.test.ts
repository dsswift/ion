import { describe, expect, it, vi, beforeEach } from 'vitest'

let homeProject: unknown = { directory: '/h/orion' }
const createConversationTab = vi.fn(async (..._a: unknown[]) => 'tab-1')
let storeState: Record<string, unknown> = {}

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../config/current', () => ({ currentServerConfig: () => ({ homeProject }) }))
vi.mock('../../store/sessionStore', () => ({ useSessionStore: { getState: () => storeState } }))
vi.mock('../../store/new-tab-defaults', () => ({ newTabDefaults: () => ({ workingDirectory: '/h/orion', hasChosenDirectory: true, engineProfileId: 'orion' }) }))

import { ensureFirstConversation } from '../first-conversation'

const person = { subject: 'sub-1', displayName: 'Owner' }

beforeEach(() => {
  createConversationTab.mockClear()
  homeProject = { directory: '/h/orion' }
  storeState = { tabsReady: true, tabs: [], staticInfo: { homePath: '/h' }, createConversationTab }
})

describe('ensureFirstConversation', () => {
  it('opens the first conversation in the home project on its profile for a person with none', async () => {
    await ensureFirstConversation(person)
    expect(createConversationTab).toHaveBeenCalledWith('/h/orion', { profileId: 'orion' })
  })

  it('does nothing when the person already has a conversation', async () => {
    storeState.tabs = [{ id: 't', principalSubject: 'sub-1' }]
    await ensureFirstConversation(person)
    expect(createConversationTab).not.toHaveBeenCalled()
  })

  it('does nothing on an instance with no home project, or before the workspace is ready', async () => {
    homeProject = null
    await ensureFirstConversation(person)
    homeProject = { directory: '/h/orion' }
    storeState.tabsReady = false
    await ensureFirstConversation(person)
    expect(createConversationTab).not.toHaveBeenCalled()
  })

  it('opens only one when two connections sign in at once', async () => {
    await Promise.all([ensureFirstConversation(person), ensureFirstConversation(person)])
    expect(createConversationTab).toHaveBeenCalledTimes(1)
  })
})
