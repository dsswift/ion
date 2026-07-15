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
    render({ id: 'openai', hasAuth: true, backend: 'api' })
    expect(container.textContent).toContain('Sign in')
  })

  it('renders nothing for a provider with no CLI capability', () => {
    render({ id: 'google', hasAuth: true })
    expect(container.textContent).toBe('')
  })
})
