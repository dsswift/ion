import { describe, expect, it, beforeEach } from 'vitest'
import { activeNewConversationLock, refusedUnderNewConversationLock } from '../new-conversation-lock'
import { enterprisePolicyCache } from '../enterprise-policy-state'

beforeEach(() => { enterprisePolicyCache.newConversationDefaults = null })

describe('activeNewConversationLock', () => {
  it('is absent with no policy and with an unlocked one', () => {
    expect(activeNewConversationLock()).toBeNull()
    enterprisePolicyCache.newConversationDefaults = { baseDirectory: '/o', engineProfileId: 'orion', locked: false }
    expect(activeNewConversationLock()).toBeNull()
  })

  it('carries the directory and profile when locked', () => {
    enterprisePolicyCache.newConversationDefaults = { baseDirectory: '/o', engineProfileId: 'orion', locked: true }
    expect(activeNewConversationLock()).toEqual({ baseDirectory: '/o', engineProfileId: 'orion' })
  })
})

describe('refusedUnderNewConversationLock', () => {
  const lock = { baseDirectory: '/o', engineProfileId: 'orion' }

  it('refuses project creation and directory changes under a lock', () => {
    for (const action of ['environment.projects.add', 'environment.projects.clone', 'setBaseDirectory', 'addDirectory']) {
      expect(refusedUnderNewConversationLock(action, lock)).toBe(true)
    }
  })

  it('leaves folder choices alone when the lock names a profile but no directory', () => {
    expect(refusedUnderNewConversationLock('environment.projects.add', { baseDirectory: '', engineProfileId: 'orion' })).toBe(false)
    expect(refusedUnderNewConversationLock('setBaseDirectory', { baseDirectory: '', engineProfileId: 'orion' })).toBe(false)
  })

  it('leaves everything else, and every action with no lock, alone', () => {
    expect(refusedUnderNewConversationLock('submit', lock)).toBe(false)
    expect(refusedUnderNewConversationLock('environment.projects.list', lock)).toBe(false)
    expect(refusedUnderNewConversationLock('environment.projects.add', null)).toBe(false)
  })
})
