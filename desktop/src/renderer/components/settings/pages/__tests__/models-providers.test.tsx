// @vitest-environment jsdom
/**
 * Providers on Providers & models: the list (order, policy filter, empty
 * messages), the provider panel's key and sign-in actions, and the CLI
 * sign-in states. Host verbs run through the fake wire, so each assertion
 * also pins the action's packed shape and the server it went to.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderEntry } from '@ion/shared/types-models'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { createHarness, flush, type Harness } from './page-harness'
import { installFakeWire } from '../../../../host/__tests__/fake-wire'

const store = vi.hoisted(() => ({
  state: {
    models: [] as Array<{ id: string; providerId: string }>,
    providers: [] as unknown[],
    loading: false,
    loginStates: {} as Record<string, Record<string, unknown>>,
    onHost: {} as Record<string, boolean>,
    fetchModelsFor: async (): Promise<void> => undefined,
  },
}))
vi.mock('@ion/server/store/model-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ion/server/store/model-store')>()
  const useModelStore = Object.assign((sel: (s: typeof store.state) => unknown) => sel(store.state), { getState: () => store.state })
  return { ...actual, environmentModels: (s: unknown) => s, useModelStore }
})
const env = vi.hoisted(() => ({ id: 'local', label: 'This Mac', isLocal: true }))
vi.mock('../../settings-servers', () => ({ useSettingsEnvironment: () => ({ ...env, justAdded: false }) }))
const policy = vi.hoisted(() => ({ value: null as null | import('@ion/shared/types-enterprise').EnterprisePolicy }))
vi.mock('../../use-environment-enterprise-policy', () => ({ useEnvironmentEnterprisePolicy: () => policy.value }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

const { ProvidersSection } = await import('../models/ProvidersSection')
const { ProviderPanel } = await import('../models/ProviderPanel')
const { ProviderCliSignIn } = await import('../models/ProviderCliSignIn')
const { describeProviderActionError } = await import('../models/provider-action-error')

const stub = {
  storeCredential: vi.fn(async () => ({ ok: true })),
  refreshModels: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  providerLogin: vi.fn(async () => ({ ok: true })),
  providerLogout: vi.fn(async () => ({ ok: true })),
  providerLoginCancel: vi.fn(async () => ({ ok: true })),
  providerLoginCode: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
}
/** Every studio_action sent, with the server it was sent to. */
let sent: Array<{ environmentId: string; action: string }>

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const labels = (h: Harness): string[] => [...h.container.querySelectorAll('button')].map((b) => b.textContent ?? '')
const keyInput = (h: Harness): HTMLInputElement | null => h.container.querySelector('input[type="password"]')

describe('Providers', () => {
  let h: Harness
  beforeEach(() => {
    for (const fn of Object.values(stub)) fn.mockClear()
    Object.assign(env, { id: 'local', label: 'This Mac', isLocal: true })
    policy.value = null
    store.state.providers = []
    store.state.loginStates = {}
    store.state.onHost = { local: true }
    sent = []
    const wire = installFakeWire(stub) as unknown as { hostSendFrame(environmentId: string, frame: StudioFrame): void }
    const original = wire.hostSendFrame.bind(wire)
    wire.hostSendFrame = (environmentId, frame) => {
      if (frame.type === 'studio_action') sent.push({ environmentId, action: frame.action })
      original(environmentId, frame)
    }
    ;(window as unknown as { ion: unknown }).ion = wire
    h = createHarness()
  })
  afterEach(() => h.unmount())

  describe('list', () => {
    it('lists configured providers first, drops what the server policy disallows, and marks a custom gateway', async () => {
      store.state.providers = [
        { id: 'openai', hasAuth: false },
        { id: 'anthropic', hasAuth: true, authSource: 'filestore' },
        { id: 'gateway', hasAuth: true, authSource: 'filestore', baseURL: 'https://gw.example.org', displayName: 'Gateway' },
        { id: 'groq', hasAuth: false },
      ]
      policy.value = { allowedProviders: ['openai', 'anthropic', 'gateway'] }
      await h.render(<ProvidersSection />)
      const rows = [...h.container.querySelectorAll('[role="listitem"]')].map((r) => r.textContent ?? '')
      expect(rows).toHaveLength(3)
      expect(rows[0]).toContain('Anthropic')
      expect(rows[1]).toContain('Gateway')
      expect(rows[1]).toContain('custom gateway')
      expect(rows[2]).toContain('not configured')
    })

    it('marks a provider the organization pinned and names the providers its allowlist removed', async () => {
      store.state.providers = [
        { id: 'gateway', hasAuth: true, authSource: 'filestore', baseURL: 'https://gw.example.org', displayName: 'Gateway' },
        { id: 'anthropic', hasAuth: true, authSource: 'filestore' },
      ]
      policy.value = { overrides: [
        { field: 'providers.gateway.baseURL', reason: 'managed_provider_pinned', userValue: 'https://rogue.example.org', effectiveValue: 'https://gw.example.org' },
        { field: 'providers.rogue', reason: 'provider_not_allowed' },
      ] }
      await h.render(<ProvidersSection />)
      const rows = [...h.container.querySelectorAll('[role="listitem"]')].map((r) => r.textContent ?? '')
      expect(rows[0]).toContain('managed')
      expect(rows[1]).not.toContain('managed')
      expect(h.container.querySelector('[role="status"]')?.textContent).toBe('Your organization does not allow this provider, so its configuration on This Mac is not in effect: rogue.')
    })

    it('shows no policy notice without overrides', async () => {
      store.state.providers = [{ id: 'anthropic', hasAuth: true, authSource: 'filestore' }]
      policy.value = { allowedProviders: ['anthropic'] }
      await h.render(<ProvidersSection />)
      expect(h.container.querySelector('[role="status"]')).toBeNull()
      expect(h.container.textContent).not.toContain('managed')
    })

    it('opens the provider panel from a row', async () => {
      store.state.providers = [{ id: 'anthropic', hasAuth: false }]
      await h.render(<ProvidersSection />)
      await act(async () => { (h.container.querySelector('[role="listitem"]') as HTMLElement).click(); await flush() })
      expect(h.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Anthropic')
      expect(keyInput(h)).not.toBeNull()
    })

    it('says why the list is empty, locally and on a remote server', async () => {
      await h.render(<ProvidersSection />)
      expect(h.container.textContent).toContain('Start the engine to see providers')
      h.unmount()
      Object.assign(env, { id: 'devbox', label: 'Devbox', isLocal: false })
      h = createHarness()
      await h.render(<ProvidersSection />)
      expect(h.container.textContent).toContain('may not be an admin of it')
    })
  })

  describe('panel', () => {
    const renderPanel = (provider: ProviderEntry, environmentId = 'local'): Promise<void> =>
      h.render(<ProviderPanel provider={provider} environmentId={environmentId} onClose={() => {}} onCredentialSaved={() => {}} />)

    it('offers "Add API key" over a CLI subscription, and it reveals the key input', async () => {
      await renderPanel({ id: 'openai', hasAuth: true, authSource: 'codex', backend: 'codex', cli: { backend: 'codex', installed: true, authenticated: true, label: 'ChatGPT Free', email: 'user@example.com' } })
      expect(keyInput(h)).toBeNull()
      await h.click('Add API key')
      expect(keyInput(h)).not.toBeNull()
    })

    it('offers "Add API key" for a claude-code sign-in too', async () => {
      await renderPanel({ id: 'anthropic', hasAuth: true, authSource: 'claude-code', cli: { backend: 'claude-code', installed: true, authenticated: true } })
      expect(labels(h)).toContain('Add API key')
    })

    it('offers Change and Remove, not "Add API key", for a saved key', async () => {
      await renderPanel({ id: 'openai', hasAuth: true, authSource: 'filestore' })
      expect(labels(h)).not.toContain('Add API key')
      expect(labels(h)).toContain('Change')
      expect(labels(h)).toContain('Remove')
    })

    it('shows the key input for an unconfigured provider and a custom gateway, and none for an unknown provider', async () => {
      await renderPanel({ id: 'openai', hasAuth: false })
      expect(keyInput(h)).not.toBeNull()
      expect(labels(h)).not.toContain('Add API key')
      await renderPanel({ id: 'corp-gateway', hasAuth: false, baseURL: 'https://gw.example.org' })
      expect(keyInput(h)).not.toBeNull()
      await renderPanel({ id: 'corp-gateway', hasAuth: true, authSource: 'filestore', baseURL: 'https://gw.example.org' })
      expect(labels(h)).toEqual(expect.arrayContaining(['Change', 'Remove']))
      await renderPanel({ id: 'mystery-provider', hasAuth: false })
      expect(keyInput(h)).toBeNull()
    })

    it('stores a key on the server the page is about, not this device', async () => {
      await renderPanel({ id: 'anthropic', hasAuth: false }, 'devbox')
      act(() => setInput(keyInput(h)!, 'sk-test'))
      await h.click('Save')
      expect(stub.storeCredential).toHaveBeenCalledWith({ provider: 'anthropic', credential: 'sk-test' })
      expect(sent.filter((s) => s.action === 'provider.storeCredential').map((s) => s.environmentId)).toEqual(['devbox'])
    })

    it('shows why a model refresh failed', async () => {
      stub.refreshModels.mockResolvedValueOnce({ ok: false, error: 'discovery failed for 1 of 1 provider(s): openai: status 500' })
      await renderPanel({ id: 'openai', hasAuth: true, authSource: 'filestore' })
      await h.click('Refresh models')
      expect(sent).toEqual([{ environmentId: 'local', action: 'model.refresh' }])
      expect(h.container.textContent).toContain('discovery failed for 1 of 1 provider(s): openai: status 500')
      expect(labels(h)).toContain('Refresh models')
    })

    it('says which settings the organization set, without repeating a secret', async () => {
      policy.value = { overrides: [
        { field: 'providers.gateway.apiKey', reason: 'managed_provider_pinned' },
        { field: 'providers.gateway.baseURL', reason: 'managed_provider_pinned', userValue: 'https://rogue.example.org', effectiveValue: 'https://gw.example.org' },
        { field: 'providers.other.baseURL', reason: 'managed_provider_pinned', userValue: 'https://elsewhere.example.org' },
      ] }
      await renderPanel({ id: 'gateway', hasAuth: true, authSource: 'filestore', baseURL: 'https://gw.example.org' })
      const notices = [...h.container.querySelectorAll('[role="status"]')].map((n) => n.textContent)
      expect(notices).toEqual([
        'API key is set by your organization. The value in your configuration is not in effect.',
        'Gateway is set by your organization. The value in your configuration (https://rogue.example.org) is not in effect.',
      ])
    })

    it('warns about an OpenAI key that returns no models', async () => {
      await renderPanel({ id: 'openai', hasAuth: true, authSource: 'filestore', backend: 'api' })
      expect(h.container.textContent).toContain('isn’t returning models')
    })

    it('describes a scope refusal on a remote server as a missing admin grant', () => {
      expect(describeProviderActionError(new StudioActionFailure('provider.storeCredential requires scope admin', 'scope'), 'devbox')).toMatch(/not an admin of the devbox environment/)
      expect(describeProviderActionError(new StudioActionFailure('boom', 'scope'), 'local')).toBe('boom')
      expect(describeProviderActionError(new Error('network'), 'devbox')).toBe('network')
    })
  })

  describe('CLI sign-in', () => {
    const renderCli = (provider: ProviderEntry, environmentId = 'local'): Promise<void> => h.render(<ProviderCliSignIn provider={provider} environmentId={environmentId} />)
    const codex = (over: Partial<ProviderEntry>): ProviderEntry => ({ id: 'openai', hasAuth: false, backend: 'codex', ...over })
    const installed = { installed: true, authenticated: false }

    it('shows install guidance with the command when the CLI is missing', async () => {
      await renderCli(codex({ cli: { backend: 'codex', installed: false, authenticated: false } }))
      expect(h.container.textContent).toContain('Codex CLI not installed')
      expect(h.container.textContent).toContain('npm install -g @openai/codex')
    })

    it('signs in, and offers Cancel while waiting for the browser', async () => {
      await renderCli(codex({ cli: { backend: 'codex', ...installed } }))
      await h.click('Sign in with Codex')
      expect(stub.providerLogin).toHaveBeenCalledWith({ provider: 'openai' })
      store.state.loginStates = { local: { openai: { phase: 'waiting' } } }
      await renderCli(codex({ cli: { backend: 'codex', ...installed } }))
      expect(h.container.textContent).toContain('Waiting for browser sign-in')
      await h.click('Cancel')
      expect(stub.providerLoginCancel).toHaveBeenCalledWith({ provider: 'openai' })
    })

    it('shows the account and signs out', async () => {
      await renderCli(codex({ hasAuth: true, cli: { backend: 'codex', installed: true, authenticated: true, label: 'ChatGPT Pro', email: 'user@example.com' } }))
      expect(h.container.textContent).toContain('ChatGPT Pro · user@example.com')
      await h.click('Sign out')
      expect(stub.providerLogout).toHaveBeenCalledWith({ provider: 'openai' })
    })

    it('stays reachable while an API key wins routing, and is absent for a provider with no CLI', async () => {
      await renderCli({ id: 'openai', hasAuth: true, backend: 'api', cli: { backend: 'codex', ...installed } })
      expect(labels(h)).toContain('Sign in with Codex')
      await renderCli({ id: 'google', hasAuth: true })
      expect(h.container.textContent).toBe('')
    })

    it('says it is still checking instead of offering a sign-in before the CLI is probed', async () => {
      await renderCli({ id: 'anthropic', hasAuth: false })
      expect(h.container.textContent).toContain('Checking Claude Code CLI')
      expect(h.container.querySelector('button')).toBeNull()
    })

    it('submits a pasted authorization code, and shows a rejected one', async () => {
      store.state.loginStates = { local: { anthropic: { phase: 'await_code', url: 'https://example.org/authorize' } } }
      await renderCli({ id: 'anthropic', hasAuth: false, cli: { backend: 'claude-code', ...installed } })
      expect(h.container.textContent).toContain('paste the authorization code')
      act(() => setInput(h.container.querySelector('input')!, 'code-abc123'))
      await h.click('Submit')
      expect(stub.providerLoginCode).toHaveBeenCalledWith({ provider: 'anthropic', code: 'code-abc123' })

      stub.providerLoginCode.mockResolvedValueOnce({ ok: false, error: 'invalid code' })
      act(() => setInput(h.container.querySelector('input')!, 'bad'))
      await h.click('Submit')
      expect(h.container.textContent).toContain('invalid code')
      await h.click('Cancel')
      expect(stub.providerLoginCancel).toHaveBeenCalledWith({ provider: 'anthropic' })
    })

    it('refuses a host-only browser flow when this client is not on the server\'s host, but not a pasted-code flow or on the host', async () => {
      await renderCli({ id: 'xai', hasAuth: false, cli: { backend: 'grok', ...installed }, loginFlow: 'browser-callback' }, 'devbox')
      expect(h.maybeControl('Sign in with Grok')).toBeUndefined()
      expect(h.container.textContent).toMatch(/completes in a browser on the host itself/)
      await renderCli({ id: 'anthropic', hasAuth: false, cli: { backend: 'claude-code', ...installed }, loginFlow: 'browser-code' }, 'devbox')
      expect(h.maybeControl('Sign in with Claude Code')).toBeTruthy()
      await renderCli({ id: 'xai', hasAuth: false, cli: { backend: 'grok', ...installed }, loginFlow: 'browser-callback' }, 'local')
      expect(h.maybeControl('Sign in with Grok')).toBeTruthy()
    })

    it('refuses a host-only browser flow for a browser attached to a headless server, whose environment id is still local', async () => {
      store.state.onHost = { local: false }
      await renderCli({ id: 'xai', hasAuth: false, cli: { backend: 'grok', ...installed }, loginFlow: 'browser-callback' }, 'local')
      expect(h.maybeControl('Sign in with Grok')).toBeUndefined()
      expect(h.container.textContent).toMatch(/completes in a browser on the host itself/)
    })
  })
})
