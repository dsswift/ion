// @vitest-environment jsdom
/**
 * GitAccessPage — credentials are one row each, not a card; adding one
 * happens in a side panel, never an always-open form; a minted key's
 * public half is shown to paste into the git host; the commit author is a
 * one-line summary until edited; every call goes to the server on screen.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ action: vi.fn() }))

vi.mock('../../../../host/host-instance', () => ({
  host: { onFrame: () => () => {}, deviceSettings: async () => ({}), setDeviceSetting: async () => {}, capabilities: () => ['local'], shell: {}, openExternal: vi.fn(async () => {}) },
  action: (...args: unknown[]) => mocks.action(...args),
}))
vi.mock('../../../../studio/connection/catalog', () => ({ readCatalog: async () => [], addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: vi.fn(), onCatalogChange: () => () => {} }))
vi.mock('../../../../studio/connection/registry', () => ({ registry: { connectAll: vi.fn(), forget: vi.fn() } }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }) }))
vi.mock('../../../../rendererLogger', () => ({ rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn() }))

const { GitAccessPage } = await import('../GitAccessPage')
const { SettingsEnvironmentProvider } = await import('../../settings-servers')
const { PopoverLayerProvider } = await import('../../../PopoverLayer')

const devbox = { id: 'devbox', label: 'devbox', target: { kind: 'lan' } } as unknown as EnvironmentCatalogEntry
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
let container: HTMLDivElement
let root: Root
const calls: Array<{ env: string; name: string; args: unknown[] }> = []
const stored = { host: 'github.com', kind: 'ssh', source: 'user', publicKey: 'ssh-ed25519 AAAA devbox' }
let identities: unknown[] = [stored]

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}
async function click(el: HTMLElement): Promise<void> { await act(async () => { el.click(); await flush(); await flush() }) }
function type(label: string, value: string): void {
  const el = document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  calls.length = 0
  mocks.action.mockImplementation(async (env: string, name: string, args: unknown[] = []) => {
    calls.push({ env, name, args })
    switch (name) {
      case 'gitIdentity.list': return identities
      case 'environment.git.author.get': return { name: 'A User', email: 'user@example.com' }
      case 'gitIdentity.mintSshKey': return { publicKey: 'ssh-ed25519 BBBB minted' }
      default: return null
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<PopoverLayerProvider><SettingsEnvironmentProvider entry={devbox}><GitAccessPage /></SettingsEnvironmentProvider></PopoverLayerProvider>)
    await flush(); await flush()
  })
})
afterEach(() => { act(() => root.unmount()); container.remove(); identities = [stored] })

async function rerender(): Promise<void> {
  act(() => root.unmount())
  root = createRoot(container)
  await act(async () => {
    root.render(<PopoverLayerProvider><SettingsEnvironmentProvider entry={devbox}><GitAccessPage /></SettingsEnvironmentProvider></PopoverLayerProvider>)
    await flush(); await flush()
  })
}

describe('GitAccessPage', () => {
  it('lists each credential as one row and summarizes the author on one line', () => {
    const rows = container.querySelectorAll('[role="listitem"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('github.com')
    expect(rows[0].textContent).toContain('ssh key')
    expect(container.textContent).toContain('A User <user@example.com>')
    expect(container.querySelector('[aria-label="Git host"]')).toBeNull()
  })

  it('lists the host\'s own keys and cli sign-ins as credentials, not as an empty state', async () => {
    identities = [
      { host: '*', kind: 'ssh', source: 'host', publicKey: 'ssh-ed25519 CCCC user@example.com', file: 'id_ed25519.pub' },
      { host: '*', kind: 'ssh', source: 'host', publicKey: 'ssh-rsa DDDD user@example.com', file: 'id_rsa.pub' },
      { host: 'github.com', kind: 'https-token', source: 'host', username: 'example-user', tool: 'gh' },
    ]
    await rerender()
    const rows = [...container.querySelectorAll('[role="listitem"]')].map((r) => r.textContent ?? '')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('Every host')
    expect(rows[0]).toContain('id_ed25519.pub in ~/.ssh on devbox')
    expect(rows[2]).toContain('Signed in with gh as example-user')
    expect(container.textContent).not.toContain('No git credentials')
  })

  it('adds a credential from a side panel and shows the minted public key', async () => {
    await click(button('Add credential'))
    type('Git host', 'gitlab.com')
    await click(button('Add'))
    expect(calls.find((c) => c.name === 'gitIdentity.mintSshKey')).toEqual({ env: 'devbox', name: 'gitIdentity.mintSshKey', args: [{ host: 'gitlab.com' }] })
    expect(document.body.querySelector<HTMLTextAreaElement>('[aria-label="Public key"]')?.value).toBe('ssh-ed25519 BBBB minted')
  })

  it('saves the commit author on the server on screen', async () => {
    await click(button('Edit'))
    type('Git author name', 'B User')
    await click(button('Save'))
    expect(calls.find((c) => c.name === 'environment.git.author.set')).toEqual({ env: 'devbox', name: 'environment.git.author.set', args: [{ name: 'B User', email: 'user@example.com' }] })
  })
})
