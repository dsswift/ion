import { describe, expect, it } from 'vitest'
import { resolveConversationProfileAction } from '../new-conversation-routing'

const profiles = [{ id: 'dev', name: 'Development', extensions: [] }]

describe('resolveConversationProfileAction', () => {
  it('honors locked enterprise policy before user overrides', () => {
    expect(resolveConversationProfileAction(profiles, { kind: 'plain' }, undefined, { baseDirectory: '/corp', engineProfileId: 'dev', locked: true })).toEqual({ kind: 'profile', profileId: 'dev', source: 'enterprise-lock' })
  })

  it('uses an explicit plain Project override before recommendation', () => {
    expect(resolveConversationProfileAction(profiles, { kind: 'plain' }, { profileId: 'dev', status: 'resolved', source: 'project' }, null)).toEqual({ kind: 'plain', source: 'user-project-override' })
  })

  it('uses a resolved recommendation when the Project does not override it', () => {
    expect(resolveConversationProfileAction(profiles, undefined, { profileId: 'dev', status: 'resolved', source: 'project' }, null)).toEqual({ kind: 'profile', profileId: 'dev', source: 'project' })
  })

  // The unlocked enterprise policy seeds this preference as a managed default,
  // so honoring the preference is what honors the unlocked policy.
  it('uses the default profile when the Project says nothing', () => {
    const unlocked = { baseDirectory: '', engineProfileId: 'dev', locked: false }
    expect(resolveConversationProfileAction(profiles, undefined, undefined, unlocked, 'dev')).toEqual({ kind: 'profile', profileId: 'dev', source: 'default-profile' })
  })

  it('never reads an unlocked enterprise policy directly', () => {
    const unlocked = { baseDirectory: '', engineProfileId: 'dev', locked: false }
    expect(resolveConversationProfileAction(profiles, undefined, undefined, unlocked, '')).toEqual({ kind: 'picker', source: 'no-default' })
  })

  it('puts a Project choice ahead of the default profile', () => {
    expect(resolveConversationProfileAction(profiles, { kind: 'plain' }, undefined, null, 'dev')).toEqual({ kind: 'plain', source: 'user-project-override' })
    expect(resolveConversationProfileAction(profiles, { kind: 'ask' }, undefined, null, 'dev')).toEqual({ kind: 'picker', source: 'user-project-ask' })
  })

  it('opens the picker when the default profile no longer exists', () => {
    expect(resolveConversationProfileAction(profiles, undefined, undefined, null, 'gone')).toEqual({ kind: 'picker', source: 'no-default' })
  })

  it('opens the picker for an explicit ask override', () => {
    expect(resolveConversationProfileAction(profiles, { kind: 'ask' }, { profileId: 'dev', status: 'resolved' }, null)).toEqual({ kind: 'picker', source: 'user-project-ask' })
  })
})
