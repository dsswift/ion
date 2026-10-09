// @vitest-environment jsdom
/**
 * The Fleet Hub portal: it shows what the hub holds, sends a person who is
 * not signed in to the hub's sign-in, and offers an action only to someone
 * who may manage, on a server that takes this hub's actions.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubFleet, HubServer } from '@ion/shared/fleet-hub'
import type { FleetDeploy } from '@ion/shared/types-fleet-deploy'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))

import { HubApp } from '../HubApp'
import { PopoverLayerProvider } from '../../components/PopoverLayer'

const NOW = Date.now()
const report = { generatedAt: NOW, server: { serverVersion: '1.2.0', engineVersion: '1.9.0', runningConversations: 2, formats: [] }, metrics: null, devices: { paired: 1, connected: 0 }, providers: [], defaultProvider: 'anthropic', modelTiers: [], accounts: [{ provider: 'anthropic', backend: 'claude-code', email: 'a@example.com', firstSeen: NOW, lastSeen: NOW, signedIn: true, limits: [] }] }
const server = (over: Partial<HubServer>): HubServer => ({ id: 'env-1', label: 'server one', online: true, manage: true, enrolledAt: NOW, lastSeenAt: NOW, readAt: NOW, report: report as never, ...over })
const fleetOf = (canManage: boolean, servers: HubServer[], deploys: FleetDeploy[] = [], quota = true): HubFleet => ({ hub: { label: 'Home fleet', authRequired: true, user: 'person@example.com', canManage, views: { quota } }, servers, deploys })

class FakeEvents {
  static last: FakeEvents | null = null
  listeners = new Map<string, (event: unknown) => void>()
  constructor(public url: string) { FakeEvents.last = this }
  addEventListener(name: string, fn: (event: unknown) => void): void { this.listeners.set(name, fn) }
  close(): void {}
}

let root: Root
let host: HTMLDivElement
let fetchMock: ReturnType<typeof vi.fn>
const assign = vi.fn()
const flush = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const tab = (name: string): void => act(() => { host.querySelector<HTMLElement>(`[role="tablist"][aria-label="Fleet views"] [data-tab="${name}"]`)!.click() })
const menu = async (row: number): Promise<string[]> => {
  await act(async () => { host.querySelectorAll<HTMLElement>('[role="listitem"] [aria-label="More actions"]')[row].click() })
  return [...document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')].map((b) => b.textContent?.trim() ?? '')
}

async function mount(response: { status: number; body?: unknown }): Promise<void> {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/fleet') return { status: response.status, ok: response.status === 200, json: async () => response.body }
    if (url === '/api/enrollment-tokens') return { status: 200, ok: true, json: async () => ({ token: 'one-time-token', expiresAt: NOW + 30 * 60_000 }) }
    if (init?.method === 'POST') return { status: 200, ok: true, json: async () => ({ ok: true, value: {} }) }
    return { status: 200, ok: true, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEvents)
  Object.defineProperty(window, 'location', { configurable: true, value: { pathname: '/', search: '', origin: 'https://hub.example.org', assign } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<PopoverLayerProvider><HubApp /></PopoverLayerProvider>) })
  await flush()
}

beforeEach(() => { assign.mockReset(); FakeEvents.last = null })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

describe('HubApp', () => {
  it('sends a person who is not signed in to the hub\'s sign-in', async () => {
    await mount({ status: 401 })
    expect(assign).toHaveBeenCalledWith('/auth/login?returnTo=%2F')
    expect(FakeEvents.last).toBeNull()
  })

  it('shows the hub\'s servers and accounts, and follows the hub\'s event stream', async () => {
    await mount({ status: 200, body: fleetOf(true, [server({})]) })
    expect(host.textContent).toContain('Home fleet')
    expect(host.textContent).toContain('person@example.com')
    // The window itself never scrolls in this renderer, so the page must scroll itself.
    expect(host.querySelector<HTMLElement>('[data-hub-scroller]')!.style.overflowY).toBe('auto')
    expect(host.querySelectorAll('section[aria-label="Accounts"] [role="listitem"]')).toHaveLength(1)
    expect(FakeEvents.last?.url).toBe('/api/events')
    // A second server reports: the stream carries the whole Fleet again.
    await act(async () => { FakeEvents.last!.listeners.get('fleet')!({ data: JSON.stringify(fleetOf(true, [server({}), server({ id: 'env-2', label: 'server two' })])) }) })
    tab('servers')
    expect(host.querySelectorAll('section[aria-label="Servers"] [role="listitem"]')).toHaveLength(2)
  })

  it('leaves the hub\'s name off the page on a phone, where there is no room for it', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
    await mount({ status: 200, body: fleetOf(true, [server({})]) })
    expect(host.querySelector('h1')).toBeNull()
    expect(document.title).toBe('Home fleet')
  })

  it('asks the hub to run an action, as the hub\'s own page', async () => {
    await mount({ status: 200, body: fleetOf(true, [server({})]) })
    tab('servers')
    expect(await menu(0)).toEqual(['Refresh usage', 'Restart', 'Update to latest release', 'Rename…', 'Remove from this hub…'])
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menu"] [role="menuitem"]')].find((b) => b.textContent?.trim() === 'Restart')!.click() })
    await flush()
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/servers/env-1/actions')!
    expect(call[1]).toMatchObject({ method: 'POST', headers: { 'x-ion-hub': '1' }, body: JSON.stringify({ action: 'environment.server.restart', args: [] }) })
    expect(host.textContent).toContain('server one is restarting.')
  })

  it('shows the hub\'s address and a new enrollment token to copy, on a phone too, to someone who may manage', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await mount({ status: 200, body: fleetOf(true, []) })
    tab('servers')
    const button = (name: string): HTMLElement => [...host.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === name)!
    await act(async () => { button('Add server').click() })
    await flush()
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/enrollment-tokens')!
    expect(call[1]).toMatchObject({ method: 'POST', headers: { 'x-ion-hub': '1' } })
    const panel = host.querySelector('section[aria-label="Add a server"]')!
    expect(panel.querySelector('[data-add-server="address"]')?.textContent).toBe('https://hub.example.org')
    expect(panel.querySelector('[data-add-server="token"]')?.textContent).toBe('one-time-token')
    await act(async () => { panel.querySelector<HTMLElement>('[aria-label="Copy the enrollment token"]')!.click() })
    await flush()
    expect(writeText).toHaveBeenCalledWith('one-time-token')
    expect(panel.querySelector('[aria-label="Copy the enrollment token"]')?.textContent).toBe('Copied')
    await act(async () => { panel.querySelector<HTMLElement>('[aria-label="Copy the hub address"]')!.click() })
    expect(writeText).toHaveBeenCalledWith('https://hub.example.org')
    await act(async () => { button('Done').click() })
    expect(host.querySelector('section[aria-label="Add a server"]')).toBeNull()
  })

  it('offers no way to add a server to someone who may not manage', async () => {
    await mount({ status: 200, body: fleetOf(false, [server({})]) })
    tab('servers')
    expect(host.textContent).not.toContain('Add server')
  })

  it('renames a server on the hub, and shows the name it reports under beside it', async () => {
    await mount({ status: 200, body: fleetOf(true, [server({ label: 'win-arm64', reportedLabel: 'HOST-1C6E' })]) })
    tab('servers')
    expect(host.textContent).toContain('reports as HOST-1C6E')
    await menu(0)
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menu"] [role="menuitem"]')].find((b) => b.textContent?.trim() === 'Rename…')!.click() })
    const input = host.querySelector<HTMLInputElement>('[aria-label="Name on this hub"]')!
    expect(input.value).toBe('win-arm64')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'windows vm')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { [...host.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Save')!.click() })
    await flush()
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/api/servers/env-1' && init?.method === 'PATCH')!
    expect(call[1]).toMatchObject({ headers: { 'x-ion-hub': '1' }, body: JSON.stringify({ label: 'windows vm' }) })
  })

  it('leaves Quota and its usage refresh off a hub that turns the view off, and opens on Servers', async () => {
    await mount({ status: 200, body: fleetOf(true, [server({})], [], false) })
    const tabs = [...host.querySelectorAll('[role="tablist"][aria-label="Fleet views"] [data-tab]')].map((t) => t.getAttribute('data-tab'))
    expect(tabs).toEqual(['servers', 'compatibility'])
    expect(host.querySelector('section[aria-label="Accounts"]')).toBeNull()
    expect(host.querySelectorAll('section[aria-label="Servers"] [role="listitem"]')).toHaveLength(1)
    expect(await menu(0)).toEqual(['Restart', 'Update to latest release', 'Rename…', 'Remove from this hub…'])
  })

  it('offers no action on a server that only reports, or to someone who may not manage', async () => {
    await mount({ status: 200, body: fleetOf(true, [server({ manage: false })]) })
    tab('servers')
    expect(host.textContent).toContain('Reports only')
    expect(await menu(0)).toEqual(['Rename…', 'Remove from this hub…'])
    act(() => root.unmount()); host.remove()
    await mount({ status: 200, body: fleetOf(false, [server({})]) })
    tab('servers')
    expect(host.querySelector('[role="listitem"] [aria-label="More actions"]')).toBeNull()
    tab('quota')
    expect(host.textContent).not.toContain('Refresh usage')
  })

  it('shows a deploy it was told of, each server\'s step, and what that server says of itself', async () => {
    const deploy: FleetDeploy = {
      id: 'd1', source: 'build of ion', startedAt: NOW, updatedAt: NOW, receivedAt: NOW, state: 'running', reportedBy: { id: 'env-9', label: 'the laptop' },
      targets: [
        { host: 'server-one', label: 'server one', environmentId: 'env-1', stage: 'deploying', detail: 'waiting for the host to come back', updatedAt: NOW },
        { host: 'elsewhere', label: 'elsewhere', stage: 'failed', error: 'nothing can build for it', updatedAt: NOW },
      ],
    }
    await mount({ status: 200, body: fleetOf(true, [server({ online: false, install: { stage: 'restarting', kind: 'artifact', at: NOW } })], [deploy]) })
    tab('servers')
    const card = host.querySelector('section[aria-label="Deploy of build of ion"]')!
    expect(card.textContent).toContain('0 of 2 done, 1 failed')
    expect(card.textContent).toContain('from the laptop')
    expect(card.querySelector('[role="listitem"][aria-label="server one: deploying"]')?.textContent).toContain('server one says: restarting, not connected to this hub now')
    expect(card.querySelector('[role="listitem"][aria-label="elsewhere: failed"]')?.textContent).toContain('nothing can build for it')
    // The server's own row says the same, from its own report.
    expect(host.querySelector('section[aria-label="Servers"] [role="listitem"]')?.textContent).toContain('restarting')

    // The server comes back and says so itself; the deploy's record ends.
    await act(async () => {
      FakeEvents.last!.listeners.get('fleet')!({ data: JSON.stringify(fleetOf(true, [server({ install: { stage: 'completed', kind: 'artifact', version: '1.3.0', at: NOW } })], [{ ...deploy, state: 'failed', endedAt: NOW, targets: [{ ...deploy.targets[0], stage: 'done', detail: '1.3.0' }, deploy.targets[1]] }])) })
    })
    expect(host.querySelector('section[aria-label="Deploy of build of ion"] [role="listitem"][aria-label="server one: done"]')?.textContent).toContain('server one says: back, running 1.3.0, connected to this hub')
    expect(host.querySelector('section[aria-label="Servers"] [role="listitem"]')?.textContent).toContain('back, running 1.3.0')
  })

  it('says when the device running a deploy stopped reporting, and drops an install step that is old news', async () => {
    const quiet: FleetDeploy = { id: 'd2', source: 'release 1.2.3', startedAt: NOW - 20 * 60_000, updatedAt: NOW - 20 * 60_000, receivedAt: NOW - 20 * 60_000, state: 'running', targets: [{ host: 'server-one', label: 'server one', stage: 'building', updatedAt: NOW - 20 * 60_000 }] }
    await mount({ status: 200, body: fleetOf(true, [server({ install: { stage: 'installing', kind: 'release', at: NOW - 60 * 60_000 } })], [quiet]) })
    tab('servers')
    expect(host.querySelector('section[aria-label="Deploy of release 1.2.3"]')?.textContent).toContain('The device running this deploy stopped reporting')
    expect(host.querySelector('section[aria-label="Servers"] [role="listitem"]')?.textContent).not.toContain('installing')
  })
})
