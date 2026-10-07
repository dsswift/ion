// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { newConversationLockOf } from '../new-conversation-lock'

describe('newConversationLockOf', () => {
  it('is absent with no policy and with an unlocked one', () => {
    expect(newConversationLockOf(null)).toBeNull()
    expect(newConversationLockOf({ locked: false, baseDirectory: '/o', engineProfileId: 'orion' })).toBeNull()
  })

  it('takes folder choices away when the lock names a directory', () => {
    expect(newConversationLockOf({ locked: true, baseDirectory: '/o', engineProfileId: 'orion' })).toEqual({ directory: '/o', profileId: 'orion', foldersLocked: true })
  })

  it('leaves folder choices alone when the lock names a profile only', () => {
    expect(newConversationLockOf({ locked: true, baseDirectory: '', engineProfileId: 'orion' })).toEqual({ directory: '', profileId: 'orion', foldersLocked: false })
  })
})
