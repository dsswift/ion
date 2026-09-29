// @vitest-environment jsdom
/**
 * ServersPage — one row per server with its reach and phase; a row opens
 * its Overview; the `…` menu offers Rename and Remove only where they
 * apply; the sidebar's + opens the Add server panel; the panel's doors
 * (Nearby hidden under a LAN-discovery seal), the SSH door's filtered
 * progress log and verbatim failure, the Nearby door's pairing, and the
 * hidden-and-blocked list.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry, EnvironmentPhaseState } from '@ion/shared/types-environments'
import type { SshAddEnvironmentProgress } from '@ion/shared/types-ssh-environment'
import { createHarness, flush, type Harness } from './page-harness'

const wire = vi.hoisted(() => ({
  states: new Map<string, EnvironmentPhaseState>(),
  progress: null as null | ((p: SshAddEnvironmentProgress) => void),
  devicePolicy: null as unknown,
}))
const hostMock = vi.hoisted(() => ({
  pairEnvironment: vi.fn(),
  sshAddEnvironment: vi.fn(),
  browseNearby: vi.fn(),
  getEnvCache: vi.fn(async () => ({ welcome: { type: 'studio_welcome', environmentId: 'env-self' }, cachedAt: 0 })),
  onSshProgress: (cb: (p: SshAddEnvironmentProgress) => void) => { wire.progress = cb; return () => { wire.progress = null } },
  onFrame: () => () => {},
}))
vi.mock('../../../../host/host-instance', () => ({ host: hostMock, action: vi.fn() }))
vi.mock('../../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../../studio/connection/policy-store', () => ({ policyStore: { devicePolicy: () => wire.devicePolicy } }))
vi.mock('../../../../studio/connection/catalog', () => ({ readCatalog: vi.fn(async () => []), addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: vi.fn(), onCatalogChange: () => () => {} }))
vi.mock('../../../../studio/connection/registry', () => ({
  registry: {
    phaseStates: () => wire.states,
    subscribe: (cb: (s: Map<string, EnvironmentPhaseState>) => void) => { cb(wire.states); return () => {} },
    refresh: vi.fn(),
    connectAll: vi.fn(async () => {}),
    forget: vi.fn(),
  },
}))

const { ServersPage } = await import('../ServersPage')
const { nearbyPairingLink } = await import('../add-server-nearby')
const { parsePairingLink } = await import('@ion/shared/pairing-link')
const { SettingsServersProvider } = await import('../../settings-servers')
const { SettingsNavProvider } = await import('../../settings-nav')
const { registry } = await import('../../../../studio/connection/registry')

const local: EnvironmentCatalogEntry = { id: 'local', label: 'This Mac', target: { kind: 'local' } }
const grover: EnvironmentCatalogEntry = { id: 'env-g', label: 'grover', target: { kind: 'paired', label: 'grover', url: 'http://127.0.0.1:7331', credentialRef: 'c', via: 'ssh', ssh: { destination: 'user@grover.local', remotePort: 7331 } } }
const managed: EnvironmentCatalogEntry = { id: 'env-m', label: 'corp', target: { kind: 'bearer', label: 'corp', url: 'https://ion.example.org', managed: true } }
const sshTarget = { kind: 'paired', label: 'lab', url: 'http://127.0.0.1:7332', credentialRef: 'e', via: 'ssh', ssh: { destination: 'user@lab.local', remotePort: 7331 } }

const servers = { entries: [local, grover, managed], justAddedId: null, add: vi.fn(), relabel: vi.fn(), forget: vi.fn(async () => {}) }
const navigate = vi.fn()
let h: Harness

async function mount(anchor: string | null = null): Promise<void> {
  await h.render(
    <SettingsServersProvider value={servers}>
      <SettingsNavProvider value={{ location: { pageId: 'servers', environmentId: null, anchor }, navigate }}>
        <ServersPage />
      </SettingsNavProvider>
    </SettingsServersProvider>,
  )
}
const rowsOf = (list: string): HTMLElement[] => [...h.container.querySelectorAll<HTMLElement>(`section[aria-label="${list}"] [role="listitem"]`)]
const doors = (): string[] => [...h.container.querySelectorAll('[role="radiogroup"][aria-label="How to connect"] [role="radio"]')].map((r) => r.textContent ?? '')
function type(label: string, value: string): void {
  const input = h.container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  h = createHarness()
  wire.states = new Map([['env-g', { phase: 'connected' } as EnvironmentPhaseState]])
  wire.devicePolicy = null
  navigate.mockReset(); servers.add.mockReset(); servers.forget.mockClear()
  hostMock.sshAddEnvironment.mockReset(); hostMock.pairEnvironment.mockReset(); hostMock.browseNearby.mockReset()
  hostMock.browseNearby.mockResolvedValue([])
})
afterEach(() => h.unmount())

describe('ServersPage list', () => {
  it('shows each server with how it is reached and its phase, and a row opens its Overview', async () => {
    await mount()
    const rows = rowsOf('Servers')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('The server on this Mac'),
      expect.stringContaining('ssh user@grover.local · port 7331'),
      expect.stringContaining('Managed'),
    ])
    expect(rows[0].textContent).toContain('local')
    expect(rows[1].textContent).toContain('connected')
    await act(async () => { rows[1].click(); await flush() })
    expect(navigate).toHaveBeenCalledWith({ pageId: 'overview', environmentId: 'env-g', anchor: null })
  })

  it('offers Rename and Remove only for a remote server, and no Remove for a managed one', async () => {
    await mount()
    const menuOf = async (row: HTMLElement): Promise<string[]> => {
      await act(async () => { (row.querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
      const items = [...document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')].map((b) => b.textContent?.trim() ?? '')
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush() })
      return items
    }
    const [l, g, m] = rowsOf('Servers')
    expect(await menuOf(l)).toEqual(['Open'])
    expect(await menuOf(g)).toEqual(['Open', 'Rename', 'Remove…'])
    expect(await menuOf(m)).toEqual(['Open', 'Rename'])
  })

  it('lists only hidden and blocked servers, with the reason, and Refresh asks the registry', async () => {
    wire.states = new Map([['env-g', { phase: 'blocked', reason: 'protocol_version' } as EnvironmentPhaseState], ['env-m', { phase: 'connected' } as EnvironmentPhaseState]])
    await mount()
    const rows = rowsOf('Hidden and blocked')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('grover')
    expect(rows[0].textContent).toContain('protocol_version')
    await h.click('Refresh')
    expect(registry.refresh).toHaveBeenCalled()
  })

  it('says so when nothing is hidden or blocked', async () => {
    await mount()
    expect(h.container.querySelector('section[aria-label="Hidden and blocked"]')?.textContent).toContain('No hidden or blocked environments.')
  })
})

describe('Add server panel', () => {
  it('opens when the sidebar navigates here with the add-server anchor', async () => {
    await mount('add-server')
    expect(h.container.querySelector('[role="dialog"][aria-label="Add server"]')).not.toBeNull()
    expect(doors()).toEqual(['Pairing link', 'Nearby', 'SSH', 'Sign in'])
  })

  it('does not offer Nearby when the device policy seals LAN discovery', async () => {
    wire.devicePolicy = { customFields: { 'ion-studio': { lanDiscovery: 'disabled' } } }
    await mount()
    await h.click('Add server')
    expect(doors()).toEqual(['Pairing link', 'SSH', 'Sign in'])
  })

  it('runs the SSH door, streams progress for its own destination only, then adds the server and opens its Overview', async () => {
    let resolveDoor: (v: unknown) => void = () => {}
    hostMock.sshAddEnvironment.mockImplementation(() => new Promise((r) => { resolveDoor = r }))
    servers.add.mockResolvedValue({ id: 'env-lab', label: 'lab', target: sshTarget })
    await mount('add-server')
    await h.click('SSH')
    await act(async () => { type('SSH destination', 'user@lab.local') })
    await h.click('Add')
    expect(hostMock.sshAddEnvironment).toHaveBeenCalledWith('user@lab.local', undefined)
    await act(async () => {
      wire.progress?.({ destination: 'user@lab.local', stage: 'installing', message: '==> installing 0.2.0' })
      wire.progress?.({ destination: 'someone-else', stage: 'installing', message: 'not mine' })
    })
    const log = h.container.querySelector('[role="log"]')
    expect(log?.textContent).toContain('==> installing 0.2.0')
    expect(log?.textContent).not.toContain('not mine')
    expect((h.control('Setting up…') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { resolveDoor({ ok: true, target: sshTarget }); await flush(); await flush() })
    expect(servers.add).toHaveBeenCalledWith(sshTarget)
    expect(navigate).toHaveBeenCalledWith({ pageId: 'overview', environmentId: 'env-lab', anchor: null })
    expect(h.container.querySelector('[role="dialog"][aria-label="Add server"]')).toBeNull()
  })

  it('shows an SSH failure verbatim and re-enables Add', async () => {
    hostMock.sshAddEnvironment.mockResolvedValue({ ok: false, error: 'SSH to user@h needs key-based authentication' })
    await mount('add-server')
    await h.click('SSH')
    await act(async () => { type('SSH destination', 'user@h') })
    await h.click('Add')
    expect(h.container.textContent).toContain('needs key-based authentication')
    expect((h.control('Add') as HTMLButtonElement).disabled).toBe(false)
    expect(servers.add).not.toHaveBeenCalled()
  })

  it('pairs a nearby server with the typed code, refusing this desktop and ones already added', async () => {
    const found = (id: string, label: string) => ({ environmentId: id, label, serverVersion: '0.1.0', host: `${label}.local`, port: 7331, url: `http://${label}.local:7331` })
    hostMock.browseNearby.mockResolvedValue([found('env-n', 'nova'), found('env-self', 'self'), found('env-g', 'grover')])
    const target = { kind: 'paired', label: 'nova', url: 'http://nova.local:7331', credentialRef: 'env-n', via: 'lan' }
    hostMock.pairEnvironment.mockResolvedValue({ ok: true, target })
    servers.add.mockResolvedValue({ id: 'env-n', label: 'nova', target })
    await mount('add-server')
    await h.click('Nearby')
    await act(async () => { await flush() })
    const rows = rowsOf('Nearby servers')
    expect(rows.map((r) => [r.textContent?.includes('this desktop'), r.textContent?.includes('already added')])).toEqual([[false, false], [true, false], [false, true]])
    await act(async () => { rows[1].click(); await flush() })
    expect(h.container.querySelector('[aria-label="Pairing code"]')).toBeNull()
    await act(async () => { rows[0].click(); await flush() })
    await act(async () => { type('Pairing code', 'abcd-efgh') })
    await h.click('Pair')
    expect(hostMock.pairEnvironment).toHaveBeenCalledWith('ion-studio://pair?code=abcd-efgh&url=http%3A%2F%2Fnova.local%3A7331&env=nova', 'nova')
    expect(servers.add).toHaveBeenCalledWith(target)
  })

  it('builds a nearby link the shared pairing parser accepts', () => {
    const server = { environmentId: 'env-w', label: 'work', serverVersion: '0.1.0', host: 'work.local', port: 7331, url: 'http://work.local:7331' }
    expect(nearbyPairingLink(server, ' ABCD-EFGH ')).toBe('ion-studio://pair?code=ABCD-EFGH&url=http%3A%2F%2Fwork.local%3A7331&env=work')
    expect(parsePairingLink(nearbyPairingLink(server, 'FSSE-2S5J'))).toMatchObject({ ok: true, link: { code: 'FSSE2S5J', url: 'http://work.local:7331', label: 'work' } })
  })

  it('says nothing is discoverable, the normal case', async () => {
    await mount('add-server')
    await h.click('Nearby')
    expect(h.container.textContent).toContain('Nothing is discoverable on this network right now.')
  })
})
