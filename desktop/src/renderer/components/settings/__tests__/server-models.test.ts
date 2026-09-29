/**
 * The default-model list is ONE server's. The bug: it was the union of every
 * connected server's models, so a model that exists only on another machine
 * was offered as a default for this one.
 */
import { describe, expect, it } from 'vitest'
import type { ModelEntry, ProviderEntry } from '@ion/shared/types-models'
import { groupServerModels, serverOffersModel } from '../server-models'

const model = (id: string, providerId: string): ModelEntry => ({ id, providerId, contextWindow: 200000, costPer1kInput: 0, costPer1kOutput: 0 })
const provider = (id: string, hasAuth: boolean): ProviderEntry => ({ id, hasAuth })

const thisServer = {
  models: [model('claude-sonnet-5', 'anthropic'), model('gpt-x', 'openai'), model('acme/claude', 'acme-gateway')],
  providers: [provider('anthropic', true), provider('openai', false), provider('acme-gateway', true)],
}

describe('groupServerModels', () => {
  it('lists only models whose provider is signed in on that server', () => {
    const ids = [...groupServerModels(thisServer, undefined).values()].flat().map((m) => m.id)
    expect(ids).toEqual(['claude-sonnet-5', 'acme/claude'])
  })

  it('applies that server\'s allowlist when one is in force', () => {
    const ids = [...groupServerModels(thisServer, { allowedModels: ['acme/claude'] }).values()].flat().map((m) => m.id)
    expect(ids).toEqual(['acme/claude'])
  })

  it('drops a model that server blocks, even when the allowlist names it', () => {
    const ids = [...groupServerModels(thisServer, { allowedModels: ['claude-sonnet-5', 'acme/claude'], blockedModels: ['acme/claude'] }).values()].flat().map((m) => m.id)
    expect(ids).toEqual(['claude-sonnet-5'])
  })

  it('treats an empty allowlist as no allowlist', () => {
    expect([...groupServerModels(thisServer, { allowedModels: [] }).values()].flat()).toHaveLength(2)
  })

  it('never offers a model the slice does not contain', () => {
    const grouped = groupServerModels(thisServer, undefined)
    expect(serverOffersModel(grouped, 'claude-sonnet-5')).toBe(true)
    // A default saved from another machine: present as a value, not as a choice.
    expect(serverOffersModel(grouped, 'other-machine-only-model')).toBe(false)
    // Its provider is not signed in here, so it is not a choice either.
    expect(serverOffersModel(grouped, 'gpt-x')).toBe(false)
  })
})
