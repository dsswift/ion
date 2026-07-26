// @vitest-environment jsdom
//
// ProviderCliAuth renders the delegated-CLI auth surface: install guidance when
// the binary is missing, a sign-in button when installed but unauthenticated
// (with live login state), and the account + sign-out when authed.
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const loginHolder: { states: Record<string, unknown> } = { states: {} }
vi.mock('../../../stores/model-store', () => ({
  useModelStore: (sel: (s: { loginStates: Record<string, unknown> }) => unknown) => sel({ loginStates: loginHolder.states }),
}))

import { ProviderCliAuth } from '../ProviderCliAuth'
import type { ProviderEntry } from '../../../../shared/types-models'

const colors = new Proxy({}, { get: () => '#000000' }) as any

const ion = {
  providerLogin: vi.fn(async () => ({ ok: true })),
  providerLogout: vi.fn(async () => ({ ok: true })),
  providerLoginCancel: vi.fn(async () => ({ ok: true })),
  providerLoginCode: vi.fn(async () => ({ ok: true })),
  openExternal: vi.fn(async () => undefined),
}

let container: HTMLDivElement
let root: Root

function render(provider: ProviderEntry) {
  act(() => { root.render(<ProviderCliAuth provider={provider} colors={colors} />) })
}

beforeEach(() => {
  loginHolder.states = {}
  ;(window as any).ion = ion
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const openaiCodex = (over: Partial<ProviderEntry>): ProviderEntry => ({
  id: 'openai', hasAuth: false, backend: 'codex', ...over,
})

/**
 * Set a controlled React input's value. Assigning `.value` directly bypasses
 * React's value tracker, so the change event is ignored; the native setter is
 * the supported way to drive a controlled input from a test.
 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ProviderCliAuth', () => {
  it('shows install guidance with the command when the CLI is not installed', () => {
    render(openaiCodex({ cli: { backend: 'codex', installed: false, authenticated: false } }))
    expect(container.textContent).toContain('Codex CLI not installed')
    expect(container.textContent).toContain('npm install -g @openai/codex')
  })

  it('offers sign-in when installed but not authenticated, and calls providerLogin', () => {
    render(openaiCodex({ cli: { backend: 'codex', installed: true, authenticated: false } }))
    const btn = container.querySelector('button')!
    expect(btn.textContent).toContain('Sign in with Codex')
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ion.providerLogin).toHaveBeenCalledWith('openai')
  })

  it('renders the waiting state with a Cancel action', () => {
    loginHolder.states = { openai: { phase: 'waiting' } }
    render(openaiCodex({ cli: { backend: 'codex', installed: true, authenticated: false } }))
    expect(container.textContent).toContain('Waiting for browser sign-in')
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    act(() => { cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ion.providerLoginCancel).toHaveBeenCalledWith('openai')
  })

  it('shows the account and a Sign out action when authenticated', () => {
    render(openaiCodex({ hasAuth: true, cli: { backend: 'codex', installed: true, authenticated: true, label: 'ChatGPT Pro', email: 'j@x.io' } }))
    expect(container.textContent).toContain('ChatGPT Pro')
    expect(container.textContent).toContain('j@x.io')
    const out = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')!
    act(() => { out.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ion.providerLogout).toHaveBeenCalledWith('openai')
  })

  it('still renders CLI sign-in when the effective backend is api (capability-gated, not backend-gated)', () => {
    // Under credential-derived routing an API key wins the backend, but the
    // CLI sign-in must stay reachable — signing in is how the user enables
    // the CLI fallback path, and sign-out must remain available too.
    render({ id: 'openai', hasAuth: true, backend: 'api', cli: { backend: 'codex', installed: true, authenticated: false } })
    expect(container.textContent).toContain('Sign in')
  })

  it('renders nothing for a provider with no CLI capability', () => {
    render({ id: 'google', hasAuth: true })
    expect(container.textContent).toBe('')
  })

  // The engine returns a nil CLI status until the first probe lands, so `cli` is
  // undefined on a fresh install. Offering "Sign in" there advertises an action
  // that cannot succeed (the dead-button defect); the row must say it is still
  // resolving instead.
  it('shows a checking state instead of a sign-in button before the CLI is probed', () => {
    render({ id: 'anthropic', hasAuth: false })
    expect(container.textContent).toContain('Checking Claude Code CLI')
    expect(container.querySelector('button')).toBeNull()
  })

  // claude-code parks on await_auth_code: the provider issues a code in the
  // browser and the CLI waits for it on stdin.
  it('renders the auth-code input on await_code and submits through the bridge', async () => {
    loginHolder.states = { anthropic: { phase: 'await_code', url: 'https://claude.com/cai/oauth/authorize?x=1' } }
    render({ id: 'anthropic', hasAuth: false, cli: { backend: 'claude-code', installed: true, authenticated: false } })

    expect(container.textContent).toContain('paste the authorization code')
    const input = container.querySelector('input')!
    act(() => { setInputValue(input, 'code-abc123') })
    const submit = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Submit')!
    await act(async () => { submit.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ion.providerLoginCode).toHaveBeenCalledWith('anthropic', 'code-abc123')
  })

  it('offers cancel while awaiting the auth code', () => {
    loginHolder.states = { anthropic: { phase: 'await_code' } }
    render({ id: 'anthropic', hasAuth: false, cli: { backend: 'claude-code', installed: true, authenticated: false } })
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    act(() => { cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ion.providerLoginCancel).toHaveBeenCalledWith('anthropic')
  })

  it('surfaces a rejected auth code instead of failing silently', async () => {
    ion.providerLoginCode.mockResolvedValueOnce({ ok: false, error: 'invalid code' } as never)
    loginHolder.states = { anthropic: { phase: 'await_code' } }
    render({ id: 'anthropic', hasAuth: false, cli: { backend: 'claude-code', installed: true, authenticated: false } })

    const input = container.querySelector('input')!
    act(() => { setInputValue(input, 'bad') })
    const submit = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Submit')!
    await act(async () => { submit.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('invalid code')
  })
})
