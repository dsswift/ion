// @vitest-environment jsdom
//
// ProviderRow renders per-provider auth management. These tests pin the
// CLI-subscription + API key coexistence contract: a provider authed via a
// delegated CLI (codex/claude-code/grok/cursor) must still offer an
// "Add API key" entry point, because the engine's credential-derived routing
// lets an API key be layered on top of (and win over) the CLI subscription,
// and removing the key reverts to the CLI. Before this contract existed the
// key input was unreachable while a CLI session was active.
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../stores/model-store', () => ({
  useModelStore: (sel: (s: { models: unknown[]; loginStates: Record<string, unknown> }) => unknown) =>
    sel({ models: [], loginStates: {} }),
}))

import { ProviderRow } from '../ProviderRow'
import type { ProviderEntry } from '../../../../shared/types-models'

const colors = new Proxy({}, { get: () => '#000000' }) as any

const ion = {
  storeCredential: vi.fn(async () => ({ ok: true })),
  refreshModels: vi.fn(async () => ({ ok: true })),
  providerLogin: vi.fn(async () => ({ ok: true })),
  providerLogout: vi.fn(async () => ({ ok: true })),
  providerLoginCancel: vi.fn(async () => ({ ok: true })),
}

let container: HTMLDivElement
let root: Root

function render(provider: ProviderEntry) {
  act(() => {
    root.render(<ProviderRow provider={provider} colors={colors} onCredentialSaved={() => {}} />)
  })
}

function clickButton(label: string) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  expect(btn, `button "${label}" not found`).toBeTruthy()
  act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
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

describe('ProviderRow — API key alongside CLI subscription', () => {
  it('shows "Add API key" when authed via the codex CLI subscription', () => {
    render({
      id: 'openai', hasAuth: true, authSource: 'codex', backend: 'codex',
      cli: { backend: 'codex', installed: true, authenticated: true, authMethod: 'chatgpt', label: 'ChatGPT Free', email: 'user@example.com' },
    })
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toContain('Add API key')
  })

  it('clicking "Add API key" reveals the key input while CLI auth is active', () => {
    render({
      id: 'openai', hasAuth: true, authSource: 'codex', backend: 'codex',
      cli: { backend: 'codex', installed: true, authenticated: true, authMethod: 'chatgpt' },
    })
    expect(container.querySelector('input[type="password"]')).toBeNull()
    clickButton('Add API key')
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('does not show "Add API key" for a filestore-authed provider (Change/Remove cover it)', () => {
    render({ id: 'openai', hasAuth: true, authSource: 'filestore' })
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).not.toContain('Add API key')
    expect(labels).toContain('Change')
    expect(labels).toContain('Remove')
  })

  it('shows "Add API key" for claude-code CLI auth too (any CLI-backed provider)', () => {
    render({
      id: 'anthropic', hasAuth: true, authSource: 'claude-code', backend: 'claude-code',
      cli: { backend: 'claude-code', installed: true, authenticated: true },
    })
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toContain('Add API key')
  })

  it('does not show "Add API key" when the provider has no auth (plain input already shown)', () => {
    render({ id: 'openai', hasAuth: false })
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).not.toContain('Add API key')
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })
})

describe('ProviderRow — custom gateway provider key management', () => {
  it('renders the API key input for a custom gateway provider (baseURL, not in API_KEY_PROVIDERS)', () => {
    render({ id: 'dci-marketing', hasAuth: false, baseURL: 'https://ai.dcim.com' })
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('shows Change/Remove for a filestore-authed custom gateway provider', () => {
    render({ id: 'dci-marketing', hasAuth: true, authSource: 'filestore', baseURL: 'https://ai.dcim.com' })
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toContain('Change')
    expect(labels).toContain('Remove')
  })

  it('does not render a key input for an unknown provider without a baseURL', () => {
    render({ id: 'mystery-provider', hasAuth: false })
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })
})
