/**
 * One resolver decides which model a conversation runs on, and it reads the
 * conversation OWNER's defaults.
 *
 * The bug this pins: a conversation on a shared server showed and sent one
 * person's default model while it belonged to another, because every reader
 * resolved the defaults of whoever happened to be the ambient caller (with no
 * request in context, the host account). Two resolvers also disagreed about
 * `engineDefaultModel`, so the phone was told one model and sent another.
 *
 * Revert proof: reading `accountModelDefaults()` with no subject makes the
 * owner cases below return the host account's model and fail.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionPrincipal } from '@ion/shared/types-engine'
import type { ConversationPane, TabState } from '@ion/shared/types'

// The send slice reaches `dataDir()` while it is being imported, so the
// directory has to exist before any import runs.
const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))
const LOCAL: SessionPrincipal = { subject: 'local:host', provider: 'os', kind: 'local', displayName: 'host' }
vi.mock('../identity/local-principal', () => ({ localPrincipal: () => LOCAL }))

import { writeSettingsForSubject } from '../persistence/user-settings-store'
import { accountModelDefaults, resolveConversationModel, resolveModelForTab } from '../model-resolution'
import { registerEnterprisePolicySource } from '../enterprise-policy-source'
import { projectResolvedModels } from '../store/resolved-model-projection'
import { resolvePromptModel } from '../store/slices/send-slice'

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-model-resolution-'))
  writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({}))
  writeSettingsForSubject('local:host', { preferredModel: 'claude-sonnet-5', engineDefaultModel: 'host-engine-model' })
  writeSettingsForSubject('user:guest', { preferredModel: 'acme-gateway/claude-sonnet-5' })
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

const none = { modelOverride: null, modelOverrideSource: null, modelOverrideProviderId: null }
const defaults = { engineDefaultModel: 'engine-default', preferredModel: 'preferred' }

describe('resolveConversationModel', () => {
  it('puts the conversation selection above every default', () => {
    const r = resolveConversationModel({ ...none, modelOverride: 'picked', modelOverrideSource: 'automatic' }, true, defaults)
    expect(r).toEqual({ model: 'picked', wireModel: 'picked', source: 'selection' })
  })

  it('qualifies a bare user pick with its provider on the wire only', () => {
    const r = resolveConversationModel({ modelOverride: 'claude-sonnet-5', modelOverrideSource: 'user', modelOverrideProviderId: 'acme-gateway' }, false, defaults)
    expect(r.model).toBe('claude-sonnet-5')
    expect(r.wireModel).toBe('acme-gateway/claude-sonnet-5')
  })

  it('applies engineDefaultModel only when a harness governs the conversation', () => {
    expect(resolveConversationModel(none, true, defaults).model).toBe('engine-default')
    expect(resolveConversationModel(none, false, defaults).model).toBe('preferred')
  })

  it('resolves nothing rather than inventing a model', () => {
    expect(resolveConversationModel(none, true, { engineDefaultModel: '', preferredModel: '' }))
      .toEqual({ model: '', wireModel: undefined, source: 'none' })
  })

  it('agrees with the send path wrapper on the same inputs', () => {
    for (const selection of [none, { modelOverride: 'm', modelOverrideSource: 'user' as const, modelOverrideProviderId: 'p' }]) {
      expect(resolvePromptModel({ ...selection, sessionModel: null }, 'preferred'))
        .toBe(resolveConversationModel(selection, false, { engineDefaultModel: '', preferredModel: 'preferred' }).wireModel)
    }
  })
})

describe('owner-scoped defaults', () => {
  it('reads the named owner, not the host account', () => {
    expect(accountModelDefaults('user:guest').preferredModel).toBe('acme-gateway/claude-sonnet-5')
    expect(accountModelDefaults().preferredModel).toBe('claude-sonnet-5')
  })

  it("resolves a guest's conversation to the guest's default with no request in context", () => {
    const tab = { engineProfileId: null, principalSubject: 'user:guest' }
    expect(resolveModelForTab(tab, none).model).toBe('acme-gateway/claude-sonnet-5')
  })

  it('publishes each conversation with its own owner default', () => {
    const tabs = [
      { id: 'host-tab', engineProfileId: null, principalSubject: 'local:host' },
      { id: 'guest-tab', engineProfileId: null, principalSubject: 'user:guest' },
      { id: 'host-engine-tab', engineProfileId: 'profile-1', principalSubject: 'local:host' },
    ] as unknown as TabState[]
    const pane = (over: Partial<typeof none> = {}) => ({ instances: [{ id: 'main', ...none, ...over }] }) as unknown as ConversationPane
    const panes = new Map<string, ConversationPane>([
      ['host-tab', pane()],
      ['guest-tab', pane()],
      ['host-engine-tab', pane()],
    ])
    expect(projectResolvedModels(tabs, panes)).toEqual({
      'host-tab': { main: 'claude-sonnet-5' },
      'guest-tab': { main: 'acme-gateway/claude-sonnet-5' },
      'host-engine-tab': { main: 'host-engine-model' },
    })
  })
})

describe('enterprise model policy', () => {
  // The engine refuses a prompt on a forbidden model outright. A default
  // saved before the policy arrived would fail every prompt, so it is not
  // carried forward.
  it('drops a saved default the policy forbids, and keeps one it permits', () => {
    try {
      registerEnterprisePolicySource(() => ({ allowedModels: ['acme-gateway/claude-sonnet-5'] }))
      expect(accountModelDefaults().preferredModel).toBe('')
      expect(accountModelDefaults('user:guest').preferredModel).toBe('acme-gateway/claude-sonnet-5')
      registerEnterprisePolicySource(() => ({ blockedModels: ['acme-gateway/claude-sonnet-5'] }))
      expect(accountModelDefaults('user:guest').preferredModel).toBe('')
      expect(accountModelDefaults().preferredModel).toBe('claude-sonnet-5')
    } finally {
      registerEnterprisePolicySource(() => null)
    }
  })

  it('leaves an explicit pick for the engine to refuse', () => {
    try {
      registerEnterprisePolicySource(() => ({ allowedModels: ['acme-gateway/claude-sonnet-5'] }))
      const resolved = resolveModelForTab({ engineProfileId: null }, { modelOverride: 'forbidden-model', modelOverrideSource: 'user', modelOverrideProviderId: undefined } as never)
      expect(resolved.model).toBe('forbidden-model')
    } finally {
      registerEnterprisePolicySource(() => null)
    }
  })
})
