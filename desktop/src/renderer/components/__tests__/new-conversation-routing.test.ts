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

  it('opens the picker for an explicit ask override', () => {
    expect(resolveConversationProfileAction(profiles, { kind: 'ask' }, { profileId: 'dev', status: 'resolved' }, null)).toEqual({ kind: 'picker', source: 'user-project-ask' })
  })
})
