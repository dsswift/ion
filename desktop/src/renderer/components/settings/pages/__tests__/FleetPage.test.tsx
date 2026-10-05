// @vitest-environment jsdom
/**
 * FleetPage — the totals, the accounts across every server with their
 * usage, and one row per server with its reach, facts, and phase; a row
 * opens its Overview; the `…` menu offers Rename, Manage only, and Remove
 * only where they apply; the sidebar's + opens the Add server panel; the
 * panel's doors
 * (Nearby hidden under a LAN-discovery seal), the SSH door's filtered
 * progress log and verbatim failure, the Nearby door's pairing, and the
 * hidden-and-blocked list.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry, EnvironmentPhaseState } from '@ion/shared/types-environments'
import type { SshAddEnvironmentProgress } from '@ion/shared/types-ssh-environment'
import { createHarness, flush, type Harness } from './page-harness'
import { HIDDEN_FLEET_EMAIL } from '@ion/shared/fleet-view'

const wire = vi.hoisted(() => ({
  states: new Map<string, EnvironmentPhaseState>(),
  progress: null as null | ((p: SshAddEnvironmentProgress) => void),
  frames: new Set<(environmentId: string, frame: unknown) => void>(),
  fleet: null as null | ((p: unknown) => void),
  devicePolicy: null as unknown,
}))
const hostMock = vi.hoisted(() => ({
  pairEnvironment: vi.fn(),
  sshAddEnvironment: vi.fn(),
  browseNearby: vi.fn(),
  getEnvCache: vi.fn(async () => ({ welcome: { type: 'studio_welcome', environmentId: 'env-self' }, cachedAt: 0 })),
  onSshProgress: (cb: (p: SshAddEnvironmentProgress) => void) => { wire.progress = cb; return () => { wire.progress = null } },
  onFrame: (cb: (environmentId: string, frame: unknown) => void) => { wire.frames.add(cb); return () => { wire.frames.delete(cb) } },
  fleetRun: vi.fn(async (request: { kind: string }) => ({ ok: true as const, runId: `run-${request.kind}` })),
  fleetRuns: vi.fn(async () => []),
  cancelFleetRun: vi.fn(),
  pickDirectory: vi.fn(async () => null as string | null),
  onFleetProgress: (cb: (p: unknown) => void) => { wire.fleet = cb; return () => { wire.fleet = null } },
}))
const reports = vi.hoisted(() => ({ byServer: {} as Record<string, unknown>, action: vi.fn() }))
vi.mock('../../../../host/host-instance', () => ({ host: hostMock, action: reports.action }))
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

vi.mock('../fleet/SwitchAccountPanel', () => ({
  SwitchAccountPanel: ({ entry, onClose }: { entry: EnvironmentCatalogEntry | null; onClose(): void }) => (entry ? <div data-testid="switch-account">Accounts on {entry.label}<button onClick={onClose}>Done</button></div> : null),
}))

const { FleetPage, _resetFleetPageForTest } = await import('../FleetPage')
const { _resetFleetForTest } = await import('../../fleet/use-fleet')
const { nearbyPairingLink } = await import('../add-server-nearby')
const { parsePairingLink } = await import('@ion/shared/pairing-link')
const { SettingsServersProvider } = await import('../../settings-servers')
const { SettingsNavProvider } = await import('../../settings-nav')
const { registry } = await import('../../../../studio/connection/registry')

const local: EnvironmentCatalogEntry = { id: 'local', label: 'This Mac', target: { kind: 'local' } }
const devbox: EnvironmentCatalogEntry = { id: 'env-g', label: 'devbox', target: { kind: 'paired', label: 'devbox', url: 'http://127.0.0.1:7331', credentialRef: 'c', via: 'ssh', ssh: { destination: 'user@devbox.local', remotePort: 7331 } } }
const managed: EnvironmentCatalogEntry = { id: 'env-m', label: 'corp', target: { kind: 'bearer', label: 'corp', url: 'https://ion.example.org', managed: true } }
const sshTarget = { kind: 'paired', label: 'lab', url: 'http://127.0.0.1:7332', credentialRef: 'e', via: 'ssh', ssh: { destination: 'user@lab.local', remotePort: 7331 } }

const servers = { entries: [local, devbox, managed] as EnvironmentCatalogEntry[], justAddedId: null, add: vi.fn(), relabel: vi.fn(), forget: vi.fn(async () => {}), setManageOnly: vi.fn(async () => {}) }
const navigate = vi.fn()
let h: Harness

async function mount(anchor: string | null = null): Promise<void> {
  await h.render(
    <SettingsServersProvider value={servers}>
      <SettingsNavProvider value={{ location: { pageId: 'servers', environmentId: null, anchor }, navigate }}>
        <FleetPage />
      </SettingsNavProvider>
    </SettingsServersProvider>,
  )
}
/** The Fleet tab each named part of the page is on. */
const TAB_OF: Record<string, string> = { 'Moving a conversation': 'compatibility', Servers: 'servers', 'Fleet totals': 'servers', 'Hidden and blocked': 'servers', Accounts: 'quota', Quota: 'quota', 'Quota summary': 'quota' }
const selectedTab = (): string | undefined => h.container.querySelector<HTMLElement>('[role="tablist"][aria-label="Fleet views"] [role="tab"][aria-selected="true"]')?.dataset.tab
/** Opens a Fleet tab; the page shows one at a time. */
function openTab(tab: string | undefined): void {
  if (!tab || selectedTab() === tab) return
  act(() => { h.container.querySelector<HTMLElement>(`[role="tablist"][aria-label="Fleet views"] [role="tab"][data-tab="${tab}"]`)!.click() })
}
const rowsOf = (list: string): HTMLElement[] => {
  openTab(TAB_OF[list])
  return [...h.container.querySelectorAll<HTMLElement>(`section[aria-label="${list}"] [role="listitem"]`)]
}
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
  _resetFleetForTest()
  reports.byServer = {}
  servers.setManageOnly.mockClear()
  reports.action.mockReset().mockImplementation(async (environmentId: string, name: string) => {
    if (name === 'fleet.refreshAccounts') return { accounts: [] }
    if (name.startsWith('environment.server.')) return { scheduled: true }
    const report = reports.byServer[environmentId]
    if (!report) throw new Error('unknown_action')
    return report
  })
})
afterEach(() => h.unmount())

describe('FleetPage list', () => {
  it('shows each server with how it is reached and its phase, and a row opens its Overview', async () => {
    await mount()
    const rows = rowsOf('Servers')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('The server on this Mac'),
      expect.stringContaining('ssh user@devbox.local · port 7331'),
      expect.stringContaining('Managed'),
    ])
    expect(rows[0].textContent).toContain('local')
    expect(rows[1].textContent).toContain('connected')
    await act(async () => { rows[1].click(); await flush() })
    expect(navigate).toHaveBeenCalledWith({ pageId: 'overview', environmentId: 'env-g', anchor: null })
  })

  it('offers Rename, Manage only, and Remove only for a remote server, no Remove for a managed one, and custom providers on a connected one', async () => {
    await mount()
    const menuOf = async (row: HTMLElement): Promise<string[]> => {
      await act(async () => { (row.querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
      const items = [...document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')].map((b) => b.textContent?.trim() ?? '')
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush() })
      return items
    }
    const [l, g, m] = rowsOf('Servers')
    expect(await menuOf(l)).toEqual(['Open', 'New conversations: prefer', 'New conversations: less often', 'New conversations: never', 'Switch account…', 'Custom providers…', 'Fleet hubs…'])
    expect(await menuOf(g)).toEqual(['Open', 'Rename', 'Manage only', 'New conversations: prefer', 'New conversations: less often', 'New conversations: never', 'Switch account…', 'Custom providers…', 'Fleet hubs…', 'Restart', 'Update to latest release', 'Deploy from source…', 'Remove…'])
    expect(await menuOf(m)).toEqual(['Open', 'Rename', 'Manage only', 'New conversations: prefer', 'New conversations: less often', 'New conversations: never', 'Restart', 'Update to latest release', 'Deploy from source…'])
  })

  it('makes a server manage-only from its menu, and offers the way back on one that is', async () => {
    const vm: EnvironmentCatalogEntry = { id: 'env-vm', label: 'test-vm', target: { kind: 'paired', label: 'test-vm', url: 'http://vm.example:7331', credentialRef: 'v', via: 'lan', manageOnly: true } }
    servers.entries = [local, devbox, vm]
    try {
      await mount()
      const [, g, v] = rowsOf('Servers')
      expect(v.textContent).toContain('Manage only')
      const pick = async (row: HTMLElement, name: string): Promise<void> => {
        await act(async () => { (row.querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
        const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menu"] [role="menuitem"]')].find((b) => b.textContent?.trim() === name)
        if (!item) throw new Error(`no menu item named "${name}"`)
        await act(async () => { item.click(); await flush() })
      }
      await pick(g, 'Manage only')
      expect(servers.setManageOnly).toHaveBeenCalledWith(devbox, true)
      await pick(v, 'Use for conversations')
      expect(servers.setManageOnly).toHaveBeenCalledWith(vm, false)
    } finally {
      servers.entries = [local, devbox, managed]
    }
  })

  it('lists only hidden and blocked servers, with the reason, and Refresh asks the registry', async () => {
    wire.states = new Map([['env-g', { phase: 'blocked', reason: 'protocol_version' } as EnvironmentPhaseState], ['env-m', { phase: 'connected' } as EnvironmentPhaseState]])
    await mount()
    const rows = rowsOf('Hidden and blocked')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('devbox')
    expect(rows[0].textContent).toContain('protocol_version')
    await h.click('Refresh')
    expect(registry.refresh).toHaveBeenCalled()
  })

  it('says so when nothing is hidden or blocked', async () => {
    await mount()
    openTab('servers')
    expect(h.container.querySelector('section[aria-label="Hidden and blocked"]')?.textContent).toContain('No hidden or blocked environments.')
  })
})

describe('FleetPage fleet', () => {
  const NOW = Date.now()
  const HOUR = 3_600_000
  const account = (email: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    provider: 'anthropic', backend: 'claude-code', email, orgId: `org-${email}`, label: 'Claude Max', firstSeen: NOW - 9 * HOUR, lastSeen: NOW, signedIn: true, limits: [], ...over,
  })
  const report = (over: Record<string, unknown>, accounts: unknown[]): unknown => ({
    generatedAt: NOW,
    server: { serverVersion: '1.2.0', engineVersion: '1.9.0', runningConversations: 2, formats: [], ...over },
    metrics: { host: { cpuUtilization: 0.25, memoryTotalBytes: 100, memoryAvailableBytes: 40 } },
    devices: { paired: 2, connected: 1 },
    providers: [], defaultProvider: 'anthropic', modelTiers: [{ name: 'standard', model: 'model-one', fallbacks: [] }],
    accounts,
  })
  const future = new Date(NOW + 3 * HOUR).toISOString()
  const text = (label: string): string => {
    openTab(TAB_OF[label])
    return h.container.querySelector(`section[aria-label="${label}"]`)?.textContent ?? ''
  }

  it('adds the servers up: totals, each server\'s facts, and one row per account', async () => {
    reports.byServer = {
      local: report({ runningConversations: 2 }, [account('a@example.com', { limits: [
        { kind: 'session', percent: 16, resetsAt: future, fetchedAt: NOW },
        { kind: 'weekly', percent: 63, resetsAt: future, fetchedAt: NOW },
        { kind: 'weekly_model', label: 'Model One', percent: 91, resetsAt: future, fetchedAt: NOW },
      ] })]),
      'env-g': report({ serverVersion: '1.1.0', runningConversations: 3 }, [
        account('a@example.com', { signedIn: false, lastSeen: NOW - 2 * HOUR }),
        account('b@example.com'),
      ]),
    }
    await mount()
    await act(async () => { await flush(); await flush() })

    const totals = text('Fleet totals')
    expect(totals).toContain('Servers online2 of 3')
    expect(totals).toContain('Running conversations5')
    expect(totals).toContain('1.1.0 ×1')
    expect(text('Quota summary')).toContain('2 accounts · 2 signed in')

    // Emails stay hidden until asked for, in both lists, so the page can be shared.
    expect(text('Accounts')).not.toContain('@example.com')
    expect(text('Servers')).not.toContain('@example.com')
    expect(rowsOf('Accounts')[0].textContent).toContain(HIDDEN_FLEET_EMAIL)
    await h.click('Show emails')
    const accounts = rowsOf('Accounts')
    expect(accounts.map((r) => r.textContent)).toEqual([expect.stringContaining('a@example.com'), expect.stringContaining('b@example.com')])
    expect(text('Accounts')).toContain('7-day Model One')
    expect(accounts[0].textContent).toContain('91%')
    expect(accounts[0].textContent).toContain('16%')
    expect(accounts[0].textContent).toContain('63%')
    // Signed in on this Mac now, seen on devbox before: both named, told apart in the tooltip.
    const chips = [...accounts[0].querySelectorAll('span')].map((s) => s.textContent)
    expect(chips).toContain('This Mac')
    expect(chips).toContain('devbox')

    const [l, g] = rowsOf('Servers')
    expect(l.textContent).toContain('1.2.0')
    expect(l.textContent).toContain('cpu 25% · mem 60%')
    expect(l.textContent).toContain('2 · 1 on')
    expect(l.textContent).toContain('model-one')
    expect(l.textContent).toContain('a@example.com')
    expect(g.textContent).toContain('1.1.0')
    expect(g.textContent).toContain('b@example.com')

    // The burn-down: 37% of the weekly limit resets unused in 3 hours.
    expect(text('Quota summary')).toContain('1 with weekly quota about to reset unused')
    expect(accounts[0].textContent).toContain('37% unused')
    expect(accounts[1].textContent).not.toContain('unused')
    // Where new work would go: the tightest limit leaves 9% on this Mac; devbox has no limits read.
    expect(l.textContent).toContain('9% room')
    expect(g.textContent).toContain('100% room')
    // A server's report reads as labelled facts under its line; one with no report shows only where new work stands.
    expect(l.textContent).toContain('Engine')
    expect(l.textContent).toContain('Default model')
    expect(rowsOf('Servers')[2].textContent).toContain('New work')
    expect(rowsOf('Servers')[2].textContent).not.toContain('Engine')
  })

  it('sums each provider\'s limits over its accounts into one quota pool', async () => {
    reports.byServer = {
      local: report({}, [
        account('a@example.com', { limits: [{ kind: 'weekly', percent: 100, resetsAt: future, fetchedAt: NOW }] }),
        account('b@example.com', { signedIn: false, limits: [{ kind: 'weekly', percent: 76, resetsAt: future, fetchedAt: NOW }] }),
      ]),
    }
    await mount()
    await act(async () => { await flush(); await flush() })

    const quota = text('Quota')
    expect(quota).toContain('Anthropic2 accounts')
    expect(quota).toContain('7-day176%of 200% used')
    expect(quota).toContain('24% left')
  })

  it('opens a connected server\'s accounts from its menu and from an account on it, and reads usage again on close', async () => {
    reports.byServer = {
      local: report({}, [account('a@example.com')]),
      'env-g': report({}, [account('a@example.com', { signedIn: false, lastSeen: NOW - 2 * HOUR })]),
      'env-m': report({}, [account('a@example.com')]),
    }
    await mount()
    await act(async () => { await flush(); await flush() })
    const menu = async (row: HTMLElement): Promise<HTMLElement[]> => {
      await act(async () => { (row.querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
      return [...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menu"] [role="menuitem"]')]
    }
    const panel = (): string | undefined => h.container.querySelector('[data-testid="switch-account"]')?.textContent ?? document.querySelector('[data-testid="switch-account"]')?.textContent ?? undefined

    // The account row offers each connected server it is on; corp is not connected.
    const items = await menu(rowsOf('Accounts')[0])
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Switch account on This Mac…', 'Switch account on devbox…'])
    await act(async () => { items[1].click(); await flush() })
    expect(panel()).toContain('Accounts on devbox')

    reports.action.mockClear()
    await h.click('Done')
    await act(async () => { await flush(); await flush() })
    expect(panel()).toBeUndefined()
    expect(reports.action.mock.calls.filter(([, name]) => name === 'fleet.refreshAccounts').map(([id]) => id).sort()).toEqual(['env-g', 'local'])

    const serverItems = await menu(rowsOf('Servers')[0])
    await act(async () => { serverItems.find((i) => i.textContent?.trim() === 'Switch account…')!.click(); await flush() })
    expect(panel()).toContain('Accounts on This Mac')
    expect((await menu(rowsOf('Servers')[2])).map((i) => i.textContent?.trim())).not.toContain('Switch account…')
  })

  it('weights a server for new conversations from its menu, on this device only', async () => {
    localStorage.clear()
    reports.byServer = { 'env-g': report({}, [account('b@example.com')]) }
    await mount()
    await act(async () => { await flush(); await flush() })
    const row = rowsOf('Servers')[1]
    await act(async () => { (row.querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
    const never = [...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menu"] [role="menuitem"]')].find((b) => b.textContent?.trim() === 'New conversations: never')
    await act(async () => { never?.click(); await flush() })
    expect(JSON.parse(localStorage.getItem('ion.placement.weights') ?? '{}')).toEqual({ 'env-g': 'never' })
    expect(rowsOf('Servers')[1].textContent).toContain('set to never')
  })

  it('keeps an account signed in nowhere, with how long ago it was seen and its last numbers', async () => {
    reports.byServer = {
      local: report({}, [account('gone@example.com', { signedIn: false, lastSeen: NOW - 3 * 24 * HOUR, limits: [{ kind: 'weekly', percent: 40, resetsAt: future, fetchedAt: NOW - 3 * 24 * HOUR }] })]),
    }
    await mount()
    await act(async () => { await flush(); await flush() })
    await h.click('Show emails')
    const [row] = rowsOf('Accounts')
    expect(row.textContent).toContain('gone@example.com')
    expect(row.textContent).toContain('last seen 3d ago')
    expect(row.textContent).toContain('40%')
    expect(text('Quota summary')).toContain('1 account · 0 signed in')
  })

  it('says a limit reset since it was last read instead of showing a number that is no longer true', async () => {
    const past = new Date(NOW - HOUR).toISOString()
    reports.byServer = { local: report({}, [account('a@example.com', { limits: [{ kind: 'session', percent: 80, resetsAt: past, fetchedAt: NOW - 5 * HOUR }] })]) }
    await mount()
    await act(async () => { await flush(); await flush() })
    const [row] = rowsOf('Accounts')
    expect(row.textContent).toContain('reset since last read')
    expect(row.textContent).not.toContain('80%')
  })

  it('Refresh usage has every connected server re-read its CLIs, then reads the reports again', async () => {
    reports.byServer = { local: report({}, []), 'env-g': report({}, []) }
    await mount()
    await act(async () => { await flush(); await flush() })
    reports.action.mockClear()
    await h.click('Refresh usage')
    await act(async () => { await flush(); await flush() })
    const calls = reports.action.mock.calls.map((c) => `${c[0]}:${c[1]}`)
    expect(calls.filter((c) => c.endsWith('fleet.refreshAccounts')).sort()).toEqual(['env-g:fleet.refreshAccounts', 'local:fleet.refreshAccounts'])
    expect(calls.filter((c) => c.endsWith('fleet.report')).sort()).toEqual(['env-g:fleet.report', 'local:fleet.report'])
    expect(calls.findIndex((c) => c.endsWith('fleet.report'))).toBeGreaterThan(calls.findIndex((c) => c.endsWith('fleet.refreshAccounts')))
  })

  it('shows one view at a time, opens on Quota, and narrows it to one provider', async () => {
    reports.byServer = {
      local: report({}, [account('a@example.com'), account('c@example.com', { provider: 'openai', backend: 'codex', label: 'ChatGPT Plus' })]),
    }
    await mount()
    await act(async () => { await flush(); await flush() })
    expect(selectedTab()).toBe('quota')
    expect(h.container.querySelector('section[aria-label="Servers"]')).toBeNull()
    const accounts = (): number => h.container.querySelectorAll('section[aria-label="Accounts"] [role="listitem"]').length
    expect(accounts()).toBe(2)
    // A known provider shows its own mark; one with none shows its initial.
    expect(h.container.querySelector('section[aria-label="Quota"] [data-provider-icon="anthropic"] svg')).not.toBeNull()
    act(() => { h.container.querySelector<HTMLElement>('[role="tablist"][aria-label="Provider"] [role="tab"][data-tab="openai"]')!.click() })
    expect(accounts()).toBe(1)
    expect(text('Quota')).not.toContain('Anthropic')
    openTab('servers')
    expect(h.container.querySelector('section[aria-label="Accounts"]')).toBeNull()
    expect(h.container.querySelector('section[aria-label="Servers"]')).not.toBeNull()
    // Emails are on both views, so the control is beside the tabs, not inside one.
    expect(h.control('Show emails')).toBeTruthy()
  })

  it('opens the tab a linked part of the page is on', async () => {
    await mount('fleet-compatibility')
    expect(selectedTab()).toBe('compatibility')
  })

  it('draws the transfer grid once two servers report the format', async () => {
    const fmt = (version: string): unknown => ({ id: 'transfer-archive', owner: 'server', version, rule: 'exact', meaning: 'm' })
    reports.byServer = { local: report({ formats: [fmt('3')] }, []), 'env-g': report({ formats: [fmt('2')] }, []) }
    await mount()
    await act(async () => { await flush(); await flush() })
    expect(text('Moving a conversation')).toContain('blocked')
  })
})

describe('FleetPage host installs', () => {
  const pick = async (row: HTMLElement, name: string): Promise<void> => {
    await act(async () => { (row.querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menu"] [role="menuitem"]')].find((b) => b.textContent?.trim() === name)
    if (!item) throw new Error(`no menu item named "${name}"`)
    await act(async () => { item.click(); await flush(); await flush() })
  }
  const notices = (): string => [...h.container.querySelectorAll('[role="status"], [role="alert"]')].map((n) => n.textContent).join(' | ')

  it('asks the server to restart or update itself, and shows what the host reports', async () => {
    await mount()
    const [, g] = rowsOf('Servers')
    await pick(g, 'Restart')
    expect(reports.action).toHaveBeenCalledWith('env-g', 'environment.server.restart', [])
    await pick(g, 'Update to latest release')
    expect(reports.action).toHaveBeenCalledWith('env-g', 'environment.server.update', [])

    await act(async () => {
      for (const cb of wire.frames) cb('env-g', { type: 'studio_event', channel: 'ion:host-install-progress', payload: { stage: 'restarting', kind: 'release', at: 1 } })
      await flush()
    })
    expect(notices()).toContain('devbox is restarting')
    await act(async () => {
      for (const cb of wire.frames) cb('env-g', { type: 'studio_event', channel: 'ion:host-install-progress', payload: { stage: 'refused', kind: 'release', code: 'not_admin', message: 'updates come from its device management', at: 2 } })
      await flush()
    })
    expect(notices()).toContain('devbox will not update: updates come from its device management')
  })

  it('shows the server\'s own refusal when it answers the request with one', async () => {
    reports.action.mockImplementation(async (_env: string, name: string) => {
      if (name === 'environment.server.restart') throw new Error('this server runs as system services, and restarting them needs sudo with a password; update it over SSH')
      throw new Error('unknown_action')
    })
    await mount()
    const [, g] = rowsOf('Servers')
    await pick(g, 'Restart')
    expect(notices()).toContain('devbox will not restart: this server runs as system services')
  })

  it('opens the Deploy panel for a server, and offers a running deploy from above the servers', async () => {
    await mount()
    const [, g] = rowsOf('Servers')
    await pick(g, 'Deploy from source…')
    const boxes = [...h.container.querySelectorAll<HTMLInputElement>('[aria-label="Servers to deploy to"] input[type="checkbox"]')]
    // The server the panel was opened for is ticked; this device's own server is not offered.
    expect(boxes.map((b) => [b.parentElement?.textContent, b.checked])).toEqual([['devbox', true], ['corp', false]])
    await h.click('Close')
    expect(h.container.querySelector('[aria-label="Servers to deploy to"]')).toBeNull()

    // This device's own server says a deploy is running: it shows above the servers, and opens in the panel.
    const deploy = { id: 'd1', source: 'build of ion', startedAt: Date.now(), updatedAt: Date.now(), receivedAt: Date.now(), state: 'running', targets: [{ host: 'devbox', label: 'devbox', environmentId: 'env-g', stage: 'building', detail: 'building on this machine', updatedAt: Date.now() }, { host: 'corp', label: 'corp', stage: 'done', detail: '1.2.3', updatedAt: Date.now() }] }
    await act(async () => { for (const cb of wire.frames) cb('local', { type: 'studio_event', channel: 'ion:fleet-deploys', payload: [deploy] }); await flush() })
    expect(notices()).toContain('Deploying build of ion: 1 of 2 done.')
    await h.click('View')
    expect(h.container.querySelector('section[aria-label="Deploy of build of ion"]')?.textContent).toContain('building on this machine')
    // A deploy that is not this panel's own is followed, not stopped.
    expect(h.maybeControl('Stop')).toBeUndefined()

    await act(async () => { for (const cb of wire.frames) cb('local', { type: 'studio_event', channel: 'ion:fleet-deploys', payload: [{ ...deploy, state: 'failed', endedAt: Date.now(), targets: [{ ...deploy.targets[0], stage: 'failed', detail: undefined, error: 'the build failed' }, deploy.targets[1]] }] }); await flush() })
    expect(notices()).toContain('The deploy of build of ion ended with failures: 1 of 2 done, 1 failed.')
  })

  it('moves an earlier fleet file\'s hosts into the list once per session', async () => {
    _resetFleetPageForTest()
    hostMock.fleetRun.mockClear()
    await mount()
    h.unmount()
    h = createHarness()
    await mount()
    expect(hostMock.fleetRun.mock.calls.filter((c) => (c[0] as { kind: string }).kind === 'migrate')).toHaveLength(1)
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
    openTab('servers')
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
    hostMock.browseNearby.mockResolvedValue([found('env-n', 'nova'), found('env-self', 'self'), found('env-g', 'devbox')])
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
