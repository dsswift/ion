import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('./engine/engine-bridge-fs', () => ({ getEnterprisePolicy: vi.fn() }))
vi.mock('./config/current', () => ({ isSharedTenancy: () => false }))

import { publishEnterprisePolicy } from './enterprise-policy-publish'
import {
  newConversationDefaultsFor,
  rememberNewConversationDefaults,
  sessionPrincipalForSubject,
} from './enterprise-policy-principal'
import { registerPrincipal, _resetPrincipalRegistryForTest } from './identity/principal-registry'

beforeEach(() => {
  _resetPrincipalRegistryForTest()
})

describe('per-principal new-conversation defaults', () => {
  it('keeps each subject\'s defaults under that subject and drops them when the policy changes', () => {
    publishEnterprisePolicy({ allowedModels: ['model-a'] })
    const contractor = { baseDirectory: '/contractors', engineProfileId: 'locked', locked: true }
    rememberNewConversationDefaults('contractor@example.com', contractor)
    rememberNewConversationDefaults('staff@example.com', null)

    expect(newConversationDefaultsFor('contractor@example.com')).toEqual(contractor)
    expect(newConversationDefaultsFor('staff@example.com')).toBeNull()
    expect(newConversationDefaultsFor('other@example.com')).toBeUndefined()

    publishEnterprisePolicy({ allowedModels: ['model-b'] })
    expect(newConversationDefaultsFor('contractor@example.com')).toBeUndefined()
  })
})

describe('sessionPrincipalForSubject', () => {
  it('builds the engine principal, with claims, for a registered subject only', () => {
    registerPrincipal({ subject: 'contractor@example.com', displayName: 'A contractor', provider: 'entra', kind: 'operator' }, { groups: ['contractors'] })
    expect(sessionPrincipalForSubject('contractor@example.com')).toMatchObject({
      subject: 'contractor@example.com',
      provider: 'entra',
      kind: 'operator',
      claims: { groups: ['contractors'] },
    })
    expect(sessionPrincipalForSubject('nobody@example.com')).toBeUndefined()
  })
})
