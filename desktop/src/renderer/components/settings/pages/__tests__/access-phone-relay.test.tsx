// @vitest-environment jsdom
/**
 * Phone & relay on Access & pairing. Every value here is an Environment
 * setting, so every read and write must go through the Settings target
 * store (`useSettingsPreferences`), never the app-wide store directly.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, flush, type Harness } from './page-harness'

const target = vi.hoisted(() => {
  const setters = {
    setRelayUrl: vi.fn(), setRelayApiKey: vi.fn(), setStreamThinkingToRemote: vi.fn(), setPushConversationTitles: vi.fn(), setRemoteDisplay: vi.fn(),
  }
  let state: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  const reset = (patch: Record<string, unknown>): void => {
    state = { relayUrl: '', relayApiKey: '', streamThinkingToRemote: true, pushConversationTitles: false, remoteDisplay: null, ...setters, ...patch }
  }
  const setState = vi.fn((patch: Record<string, unknown>) => { state = { ...state, ...patch }; for (const l of listeners) l() })
  return { setters, reset, setState, get: () => state, listeners }
})
vi.mock('../../settings-target', async () => {
  const { useSyncExternalStore } = await import('react')
  const useFakeSettingsPreferences = <T,>(selector: (s: Record<string, unknown>) => T): T => useSyncExternalStore(
    (l) => { target.listeners.add(l); return () => { target.listeners.delete(l) } },
    () => selector(target.get()),
  )
  return { useSettingsPreferences: Object.assign(useFakeSettingsPreferences, { getState: target.get, setState: target.setState }) }
})
// The app-wide store must not be written by this section at all.
const appWide = vi.hoisted(() => ({ setState: vi.fn() }))
vi.mock('../../../../preferences', () => ({ usePreferencesStore: Object.assign(() => { throw new Error('read the app-wide store') }, appWide) }))

const shell = vi.hoisted(() => ({
  remoteStopDiscovery: vi.fn(), remoteDiscoverRelays: vi.fn(), remoteTestRelay: vi.fn(), remoteRelayAuthConfig: vi.fn(),
  entraIdentity: vi.fn(), entraSignIn: vi.fn(), remoteSetDisplay: vi.fn(),
}))
// Live updates must come from the server Settings is editing, heard through
// its own event channels, never through a local-only shell listener.
const channels = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const on = vi.fn((channel: string, cb: (payload: unknown) => void) => { listeners.set(channel, cb); return () => { listeners.delete(channel) } })
  return { listeners, on, emit: (channel: string, payload: unknown) => listeners.get(channel)?.(payload) }
})
vi.mock('../../settings-shell', () => ({ useSettingsShell: () => ({ environmentId: 'env-a', shell, on: channels.on }) }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))

const { PhoneRelaySection } = await import('../access/PhoneRelaySection')

const input = (h: Harness, label: string): HTMLInputElement => h.container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); await flush() })
}

describe('PhoneRelaySection', () => {
  let h: Harness
  beforeEach(() => {
    vi.clearAllMocks()
    target.reset({})
    channels.listeners.clear()
    shell.remoteRelayAuthConfig.mockResolvedValue({ oidc: false, issuer: '', audience: '', requiredScope: '', psk: true })
    shell.remoteDiscoverRelays.mockResolvedValue([])
    h = createHarness()
  })
  afterEach(() => h.unmount())
  const mount = async (): Promise<void> => { await h.render(<PhoneRelaySection />); await act(async () => { await flush() }) }

  it('carries relay settings only: pairing and the list of paired devices live under Devices', async () => {
    await mount()
    expect(h.container.textContent).toContain('Relay server')
    expect(h.container.textContent).toContain('No relay server configured. LAN only.')
    expect(h.container.textContent).not.toContain('Paired devices')
    expect([...h.container.querySelectorAll('button')].some((b) => /pair/i.test(b.textContent ?? ''))).toBe(false)
  })

  it('tests a PSK relay, then saves its URL and key through the Settings target store', async () => {
    shell.remoteTestRelay.mockResolvedValue({ success: true })
    await mount()
    await h.click('Add relay server')
    await type(input(h, 'Relay URL'), ' ws://relay.example.org:8080 ')
    await type(input(h, 'API Key'), 'secret')
    await h.click('Test & Save')
    expect(shell.remoteTestRelay).toHaveBeenCalledWith('ws://relay.example.org:8080', 'secret')
    expect(target.setters.setRelayUrl).toHaveBeenCalledWith('ws://relay.example.org:8080')
    expect(target.setters.setRelayApiKey).toHaveBeenCalledWith('secret')
    expect(appWide.setState).not.toHaveBeenCalled()
    expect(h.container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the panel open with the reason when the relay test fails', async () => {
    shell.remoteTestRelay.mockResolvedValue({ success: false, error: 'bad key' })
    await mount()
    await h.click('Add relay server')
    await type(input(h, 'Relay URL'), 'ws://relay.example.org:8080')
    await h.click('Test & Save')
    expect(h.container.textContent).toContain('bad key')
    expect(target.setters.setRelayUrl).not.toHaveBeenCalled()
  })

  it('an OIDC relay needs sign-in, then connects with no stored key', async () => {
    shell.remoteRelayAuthConfig.mockResolvedValue({ oidc: true, issuer: 'https://login.example.org', audience: 'a', requiredScope: 's', psk: false })
    shell.entraIdentity.mockResolvedValue({ identity: null })
    shell.entraSignIn.mockResolvedValue({ ok: true, identity: { username: 'user@example.com' } })
    await mount()
    await h.click('Add relay server')
    await type(input(h, 'Relay URL'), 'wss://relay.example.org')
    expect(input(h, 'API Key')).toBeNull()
    expect((h.control('Connect') as HTMLButtonElement).disabled).toBe(true)
    await h.click('Sign in with Microsoft')
    expect(h.container.textContent).toContain('Signed in as user@example.com')
    await h.click('Connect')
    expect(target.setters.setRelayUrl).toHaveBeenCalledWith('wss://relay.example.org')
    expect(target.setters.setRelayApiKey).toHaveBeenCalledWith('')
  })

  it('shows the configured relay with its OIDC identity, and Remove clears URL and key', async () => {
    target.reset({ relayUrl: 'wss://relay.example.org', relayApiKey: '' })
    shell.remoteRelayAuthConfig.mockResolvedValue({ oidc: true, issuer: 'https://login.example.org', audience: 'a', requiredScope: 's', psk: false })
    shell.entraIdentity.mockResolvedValue({ identity: { username: 'user@example.com' } })
    await mount()
    expect(h.container.textContent).toContain('wss://relay.example.org')
    expect(h.container.textContent).toContain('Relay identity: user@example.com · https://login.example.org')
    await h.click('Remove')
    expect(target.setters.setRelayUrl).toHaveBeenCalledWith('')
    expect(target.setters.setRelayApiKey).toHaveBeenCalledWith('')
  })

  it('discovers relays on the LAN, fills the URL from a pick, and stops discovery when the panel closes', async () => {
    await mount()
    await h.click('Add relay server')
    await h.click('Discover')
    expect(shell.remoteDiscoverRelays).toHaveBeenCalledTimes(1)
    expect(h.container.textContent).toContain('Searching for relays on your network…')
    await act(async () => { channels.emit('ion:remote-relays-changed', [{ id: 'r1', name: 'Office relay', host: 'relay.local', port: 8080, addresses: ['fe80::1', '192.168.1.5'] }]); await flush() })
    const row = [...h.container.querySelectorAll<HTMLElement>('[role="listitem"]')].find((r) => r.textContent?.includes('Office relay'))!
    await act(async () => { row.click(); await flush() })
    expect(input(h, 'Relay URL').value).toBe('ws://192.168.1.5:8080')
    shell.remoteStopDiscovery.mockClear()
    await h.click('Cancel')
    expect(shell.remoteStopDiscovery).toHaveBeenCalledTimes(1)
  })

  it('saves the phone name through remoteSetDisplay and the Settings target store, keeping the icon', async () => {
    target.reset({ remoteDisplay: { customName: null, customIcon: 'laptop', updatedAt: 1 } })
    const saved = { customName: 'Desk', customIcon: 'laptop', updatedAt: 2 }
    shell.remoteSetDisplay.mockResolvedValue(saved)
    await mount()
    expect(h.container.textContent).toContain('OS hostname')
    await h.click('Edit')
    await type(input(h, 'Custom name'), '  Desk  ')
    await h.click('Save')
    expect(shell.remoteSetDisplay).toHaveBeenCalledWith('Desk', 'laptop')
    expect(target.setState).toHaveBeenCalledWith({ remoteDisplay: saved })
    expect(target.setters.setRemoteDisplay).toHaveBeenCalledWith('Desk', 'laptop')
    expect(h.container.textContent).toContain('syncs to all paired iPhones')
  })

  it('changes the icon from a grid in its own panel; the page itself has no grid', async () => {
    shell.remoteSetDisplay.mockResolvedValue({ customName: null, customIcon: 'house', updatedAt: 2 })
    await mount()
    expect(h.container.querySelector('[role="radiogroup"][aria-label="Icon"]')).toBeNull()
    await h.click('Change')
    await h.click('Home')
    await h.click('Save')
    expect(shell.remoteSetDisplay).toHaveBeenCalledWith(null, 'house')
  })

  it('applies a display change the edited server broadcasts to the Settings target store', async () => {
    await mount()
    const value = { customName: 'From iPhone', customIcon: null, updatedAt: 5 }
    await act(async () => { channels.emit('ion:remote-display-changed', value); await flush() })
    expect(target.setState).toHaveBeenCalledWith({ remoteDisplay: value })
    expect(h.container.textContent).toContain('From iPhone')
  })

  it('writes the low-bandwidth switches through the Settings target store', async () => {
    await mount()
    await h.click('Stream reasoning to phone')
    await h.click('Conversation titles in notifications')
    expect(target.setters.setStreamThinkingToRemote).toHaveBeenCalledWith(false)
    expect(target.setters.setPushConversationTitles).toHaveBeenCalledWith(true)
  })
})
