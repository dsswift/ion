// @vitest-environment jsdom
/**
 * Paired devices on Access & pairing: the list, the row menu's Revoke, the
 * detail panel, Pair a phone, and the pairing link panel.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, flush, type Harness } from './page-harness'

const client = vi.hoisted(() => ({ listClients: vi.fn(), revokeClient: vi.fn(), mintPairingLink: vi.fn() }))
const events = vi.hoisted(() => ({ channels: [] as string[] }))
vi.mock('../../environment/environment-client', () => ({
  environmentClient: client,
  onEnvironmentEvent: (_env: string, channel: string) => { events.channels.push(channel); return () => {} },
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
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('../../../../host/host-instance', () => ({ host: { getEnvCache: vi.fn(async () => ({ welcome: { type: 'studio_welcome', pairedClientId: 'desk-1' } })) } }))
const panel = vi.hoisted(() => ({ onClose: null as null | ((outcome: string) => void) }))
vi.mock('../access/PairPhonePanel', () => ({
  PairPhonePanel: (props: { onClose: (outcome: string) => void }) => { panel.onClose = props.onClose; return <div data-testid="pair-phone-panel" /> },
}))

const { DevicesSection } = await import('../access/DevicesSection')

const CLIENTS = [
  { clientId: 'desk-1', kind: 'desktop', label: 'Office Mac', scopes: ['conversations:read', 'admin'], subject: 'local', createdAt: 1, lastSeen: 2, revokedAt: null },
  { clientId: 'phone-1', kind: 'mobile', label: 'Pocket phone', scopes: ['conversations:read', 'conversations:operate'], subject: 'local', createdAt: 1, lastSeen: 2, revokedAt: null, connected: true },
  { clientId: 'gone-1', kind: 'mobile', label: 'Old phone', scopes: [], subject: 'local', createdAt: 1, lastSeen: 2, revokedAt: 3 },
]

describe('DevicesSection', () => {
  let h: Harness
  beforeEach(() => {
    for (const fn of Object.values(client)) fn.mockReset()
    events.channels.length = 0
    client.listClients.mockResolvedValue(CLIENTS)
    client.revokeClient.mockResolvedValue({ revoked: true })
    h = createHarness()
  })
  afterEach(() => { h.unmount(); document.body.innerHTML = '' })
  const mount = async (): Promise<void> => { await h.render(<DevicesSection />); await act(async () => { await flush() }) }
  const rowOf = (label: string): HTMLElement => [...h.container.querySelectorAll<HTMLElement>('[role="listitem"]')].find((r) => r.textContent?.includes(label))!
  const openMenu = async (label: string): Promise<void> => {
    await act(async () => { (rowOf(label).querySelector('[aria-label="More actions"]') as HTMLButtonElement).click(); await flush() })
  }
  const menuItem = (label: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((b) => b.textContent === label)!

  it('says a device that is connected now is connected, and the rest when they were last seen', async () => {
    await mount()
    expect(rowOf('Pocket phone').textContent).toContain('connected now')
    expect(rowOf('Office Mac').textContent).not.toContain('connected now')
    expect(rowOf('Office Mac').textContent).toContain('just now')
  })

  it('lists a desktop and a phone from one auth.listClients result, and leaves out a revoked pairing', async () => {
    await mount()
    expect(client.listClients).toHaveBeenCalledWith('env-1')
    expect(h.container.textContent).toContain('Office Mac')
    expect(h.container.textContent).toContain('Pocket phone')
    expect(h.container.textContent).not.toContain('Old phone')
    expect(rowOf('Office Mac').textContent).toContain('desktop')
    expect(rowOf('Office Mac').textContent).toContain('admin')
    expect(rowOf('Office Mac').textContent).toContain('this desktop')
    expect(rowOf('Pocket phone').textContent).toContain('phone')
  })

  it('listens for pairings changing and discovery codes being used', async () => {
    await mount()
    expect(events.channels).toEqual(expect.arrayContaining(['ion:discovery', 'ion:clients-changed']))
  })

  it('revokes the row it was asked to from the row menu, by clientId, then lists again', async () => {
    await mount()
    await openMenu('Pocket phone')
    await act(async () => { menuItem('Revoke').click(); await flush() })
    expect(client.revokeClient).toHaveBeenCalledWith('env-1', 'phone-1')
    expect(client.listClients).toHaveBeenCalledTimes(2)
  })

  it('does not offer to revoke the pairing this desktop is connected through', async () => {
    await mount()
    await openMenu('Office Mac')
    const revoke = menuItem('Revoke')
    expect(revoke.disabled).toBe(true)
    await act(async () => { revoke.click(); await flush() })
    expect(client.revokeClient).not.toHaveBeenCalled()
  })

  it('opens the full record on row click, with every scope and a Revoke that works', async () => {
    await mount()
    await act(async () => { rowOf('Pocket phone').click(); await flush() })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute('aria-label')).toBe('Pocket phone')
    expect(dialog.querySelector('[data-testid="scopes-phone-1"]')?.textContent).toBe('conversations:readconversations:operate')
    expect(dialog.textContent).toContain('phone-1')
    await h.click('Revoke phone-1')
    expect(client.revokeClient).toHaveBeenCalledWith('env-1', 'phone-1')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the own pairing unrevocable in its detail panel too', async () => {
    await mount()
    await act(async () => { rowOf('Office Mac').click(); await flush() })
    expect((h.control('Revoke desk-1') as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens Pair a phone, and lists again when it closes', async () => {
    await mount()
    expect(h.container.querySelector('[data-testid="pair-phone-panel"]')).toBeNull()
    await h.click('Pair a phone')
    expect(h.container.querySelector('[data-testid="pair-phone-panel"]')).not.toBeNull()
    await act(async () => { panel.onClose?.('paired'); await flush() })
    expect(h.container.querySelector('[data-testid="pair-phone-panel"]')).toBeNull()
    expect(client.listClients).toHaveBeenCalledTimes(2)
  })

  it('mints a pairing link when its panel opens and shows it with the expiry', async () => {
    client.mintPairingLink.mockResolvedValue({ url: 'ion-studio://pair?code=abc', expiresAt: Date.now() + 10 * 60_000 })
    await mount()
    await h.click('Pairing link')
    expect(client.mintPairingLink).toHaveBeenCalledWith('env-1', 'another device')
    const link = h.container.querySelector('textarea[aria-label="Pairing link"]') as HTMLTextAreaElement
    expect(link.value).toBe('ion-studio://pair?code=abc')
    expect(h.container.textContent).toContain('Treat it as a password; it expires in 10 min')
  })

  it('says the list needs the admin scope when listing is refused', async () => {
    client.listClients.mockRejectedValue(new Error('forbidden'))
    await mount()
    expect(h.container.textContent).toContain('Devices need the admin scope on this environment. forbidden')
  })
})
