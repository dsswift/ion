// @vitest-environment jsdom
/**
 * Devices for a person without admin on the server, as a web Studio sign-in
 * has: the section shows in the browser host, lists only their own devices,
 * and pairs a phone or another desktop through the non-admin action.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, flush, type Harness } from './page-harness'

const client = vi.hoisted(() => ({ listOwnDevices: vi.fn(), mintOwnPairingLink: vi.fn(), listClients: vi.fn(), mintPairingLink: vi.fn(), revokeClient: vi.fn() }))
vi.mock('../../environment/environment-client', () => ({
  environmentClient: client,
  onEnvironmentEvent: () => () => {},
  formatAgo: () => 'just now',
  useEnvironmentResource: (env: string, load: (e: string) => Promise<unknown>) => {
    const [data, setData] = React.useState<unknown>(null)
    const [error, setError] = React.useState<string | null>(null)
    const refresh = React.useCallback(() => { void load(env).then(setData, (err: Error) => setError(err.message)) }, [env, load])
    React.useEffect(() => { refresh() }, [refresh])
    return { data, loading: data === null && error === null, error, refresh }
  },
}))
vi.mock('../../settings-servers', () => ({ useSettingsEnvironment: () => ({ id: 'env-1', label: 'Studio', isLocal: false, justAdded: false }) }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../../../host/web-storage', () => ({
  getDeviceSettings: vi.fn(async () => ({})),
  setDeviceSetting: vi.fn(async () => {}),
  getEnvCache: vi.fn(async () => null),
  setEnvCache: vi.fn(async () => {}),
}))
vi.mock('../../../../host/host-instance', () => ({ host: { capabilities: () => [], onFrame: () => () => {}, getEnvCache: vi.fn(async () => null) }, action: vi.fn() }))
const panel = vi.hoisted(() => ({ access: null as null | { kind: string } }))
vi.mock('../access/PairPhonePanel', () => ({
  PairPhonePanel: (props: { access: { kind: string } }) => { panel.access = props.access; return <div data-testid="pair-phone-panel" /> },
}))

const { DevicesSection } = await import('../access/DevicesSection')
const { useEnvironmentSettingsStore } = await import('../../../../studio/state/environment-settings-store')
const { SETTINGS_PAGES, visibleSections } = await import('../../settings-catalog')
const { BrowserStudioHost } = await import('../../../../host/BrowserStudioHost')

const OWN = [
  { clientId: 'phone-1', label: 'Pocket phone', kind: 'mobile', pairedAt: 1, lastSeen: 2, connected: true, connectedAt: 1, admin: false, self: false },
  { clientId: 'web-1', label: null, kind: 'desktop', pairedAt: 1, lastSeen: 2, connected: false, connectedAt: null, admin: false, self: true },
]

describe('the browser host', () => {
  it('shows Devices on a server\'s Access & pairing page, though it is not the local desktop', () => {
    const capabilities = new BrowserStudioHost().capabilities()
    expect(capabilities).not.toContain('local')
    const access = SETTINGS_PAGES.find((p) => p.id === 'access')!
    expect(visibleSections(access, { hiddenGroups: [], capabilities }).map((s) => s.id)).toEqual(['devices'])
  })
})

describe('DevicesSection without admin', () => {
  let h: Harness
  beforeEach(() => {
    for (const fn of Object.values(client)) fn.mockReset()
    panel.access = null
    client.listOwnDevices.mockResolvedValue(OWN)
    client.mintOwnPairingLink.mockResolvedValue({ url: 'ion-studio://pair?code=own', code: 'own', expiresAt: Date.now() + 5 * 60_000 })
    useEnvironmentSettingsStore.getState().hydrate('env-1', {}, ['conversations:read', 'conversations:operate', 'terminal:operate', 'git:write'])
    h = createHarness()
  })
  afterEach(() => { h.unmount(); document.body.innerHTML = ''; useEnvironmentSettingsStore.getState().clear('env-1') })
  const mount = async (): Promise<void> => { await h.render(<DevicesSection />); await act(async () => { await flush() }) }
  const rowOf = (label: string): HTMLElement => [...h.container.querySelectorAll<HTMLElement>('[role="listitem"]')].find((r) => r.textContent?.includes(label))!

  it('lists only the person\'s own devices, never every pairing', async () => {
    await mount()
    expect(client.listOwnDevices).toHaveBeenCalledWith('env-1')
    expect(client.listClients).not.toHaveBeenCalled()
    expect(rowOf('Pocket phone').textContent).toContain('connected now')
    expect(rowOf('Unnamed device').textContent).toContain('this device')
  })

  it('offers no Revoke, which stays with an admin', async () => {
    await mount()
    await act(async () => { (rowOf('Pocket phone').querySelector('[aria-label="More actions"]') as HTMLButtonElement).click(); await flush() })
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].map((b) => b.textContent)
    expect(items).toEqual(['Copy id'])
  })

  it('pairs a phone as the person', async () => {
    await mount()
    await h.click('Pair a phone')
    expect(h.container.querySelector('[data-testid="pair-phone-panel"]')).not.toBeNull()
    expect(panel.access?.kind).toBe('own')
  })

  it('mints a pairing link through the non-admin action', async () => {
    await mount()
    await h.click('Pairing link')
    expect(client.mintOwnPairingLink).toHaveBeenCalledWith('env-1', 'another device')
    expect(client.mintPairingLink).not.toHaveBeenCalled()
    expect((h.container.querySelector('textarea[aria-label="Pairing link"]') as HTMLTextAreaElement).value).toBe('ion-studio://pair?code=own')
  })

  it('waits for the server\'s welcome before choosing a view', async () => {
    useEnvironmentSettingsStore.getState().clear('env-1')
    await mount()
    expect(h.container.textContent).toContain('Loading…')
    expect(client.listOwnDevices).not.toHaveBeenCalled()
  })
})
