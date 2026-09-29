// @vitest-environment jsdom
/**
 * OverviewPage — the finish-setup notice links to Git access and Projects
 * of this server; Reconnect and Rename exist only for a remote server;
 * the server facts read from `environment.server.info`; Restart and Update
 * are refused without a bundle install and, with one, schedule on the
 * server and say it will drop and reconnect.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { createHarness, type Harness } from './page-harness'

const actionMock = vi.hoisted(() => vi.fn())
const restartEnvironment = vi.hoisted(() => vi.fn())
vi.mock('../../../../host/host-instance', () => ({ host: { onFrame: () => () => {}, restartEnvironment }, action: (...args: unknown[]) => actionMock(...args) }))
vi.mock('../../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../../../../studio/connection/catalog', () => ({ readCatalog: vi.fn(async () => []), addToCatalog: vi.fn(), relabelCatalogEntry: vi.fn(), removeFromCatalog: vi.fn(), onCatalogChange: () => () => {} }))
vi.mock('../../../../studio/connection/registry', () => ({
  registry: { phaseStates: () => new Map([['env-g', { phase: 'backoff', reason: 'timed out' }]]), subscribe: () => () => {}, connectAll: vi.fn(), forget: vi.fn() },
}))

const { OverviewPage } = await import('../OverviewPage')
const { SettingsServersProvider, SettingsEnvironmentProvider } = await import('../../settings-servers')
const { SettingsNavProvider } = await import('../../settings-nav')

const local: EnvironmentCatalogEntry = { id: 'local', label: 'This Mac', target: { kind: 'local' } }
const grover: EnvironmentCatalogEntry = { id: 'env-g', label: 'grover', target: { kind: 'paired', label: 'grover', url: 'http://127.0.0.1:7331', credentialRef: 'c', via: 'ssh', ssh: { destination: 'user@grover.local', remotePort: 7331 } } }
const info = (bundle: boolean) => ({
  serverVersion: '0.3.0', engineVersion: '1.2.0', hostname: 'grover', platform: 'linux', arch: 'x64', home: '/home/u', dataDir: '/home/u/.ion', uptimeSeconds: 600,
  bundle: bundle ? { root: '/home/u/.ion/studio-server', version: { server: '0.3.0', engine: '1.2.0', node: 'v22' } } : null,
})

const navigate = vi.fn()
let h: Harness

async function mount(entry: EnvironmentCatalogEntry, justAddedId: string | null = null): Promise<void> {
  await h.render(
    <SettingsServersProvider value={{ entries: [local, grover], justAddedId, add: vi.fn(), relabel: vi.fn(), forget: vi.fn() }}>
      <SettingsNavProvider value={{ location: { pageId: 'overview', environmentId: entry.id, anchor: null }, navigate }}>
        <SettingsEnvironmentProvider entry={entry}><OverviewPage /></SettingsEnvironmentProvider>
      </SettingsNavProvider>
    </SettingsServersProvider>,
  )
}

beforeEach(() => {
  h = createHarness(); navigate.mockReset(); restartEnvironment.mockReset(); actionMock.mockReset()
  actionMock.mockImplementation(async (_env: string, name: string) => (name === 'environment.server.info' ? info(true) : { scheduled: true }))
})
afterEach(() => h.unmount())

describe('OverviewPage', () => {
  it('walks a just-added server to its Git access and Projects pages', async () => {
    await mount(grover, 'env-g')
    expect(h.container.textContent).toContain('Finish setting up grover')
    await h.click('Git access')
    expect(navigate).toHaveBeenCalledWith({ pageId: 'git-access', environmentId: 'env-g', anchor: null })
    await h.click('Projects')
    expect(navigate).toHaveBeenCalledWith({ pageId: 'projects', environmentId: 'env-g', anchor: null })
  })

  it('shows how a remote server is reached and its phase, and Reconnect asks the shell', async () => {
    await mount(grover)
    const connection = h.container.querySelector('[data-settings-anchor="connection"]')!
    expect(connection.textContent).toContain('ssh user@grover.local · port 7331')
    expect(connection.textContent).toContain('backoff · timed out')
    expect(h.container.textContent).not.toContain('Finish setting up')
    await h.click('Reconnect')
    expect(restartEnvironment).toHaveBeenCalledWith('env-g')
    await h.click('Rename')
    expect(h.container.querySelector('[role="dialog"][aria-label="Rename grover"]')).not.toBeNull()
  })

  it('has no Reconnect, Rename, or Remove for the local server', async () => {
    await mount(local)
    expect(h.maybeControl('Reconnect')).toBeUndefined()
    expect(h.maybeControl('Rename')).toBeUndefined()
    expect(h.maybeControl('Remove…')).toBeUndefined()
    expect(h.container.textContent).toContain('The server on this Mac')
  })

  it('reads the server facts and schedules Restart on the server', async () => {
    await mount(grover)
    const facts = h.container.querySelector('[data-settings-anchor="server-facts"]')!
    expect(facts.textContent).toContain('0.3.0')
    expect(facts.textContent).toContain('grover · linux/x64')
    expect(facts.textContent).toContain('Studio Server bundle 0.3.0 (engine 1.2.0, v22)')
    expect(facts.textContent).toContain('10 min')
    await h.click('Restart')
    expect(actionMock).toHaveBeenCalledWith('env-g', 'environment.server.restart', [])
    expect(h.container.textContent).toContain('Restart scheduled. grover will drop and reconnect in a moment.')
  })

  it('shows the host app, running conversations, engine minimum, and formats a current server reports', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => (name === 'environment.server.info'
      ? { ...info(false), engineMinVersion: '1.5.0', engineMeetsMin: false, hostApp: { name: 'desktop', version: '1.101.0' }, runningConversations: 1, formats: [{ id: 'transfer-archive', owner: 'server', version: '3', rule: 'exact', meaning: 'm' }] }
      : { scheduled: true }))
    await mount(grover)
    const facts = h.container.querySelector('[data-settings-anchor="server-facts"]')!
    expect(facts.textContent).toContain('Ion desktop 1.101.0')
    expect(facts.textContent).toContain('1 conversation')
    expect(facts.textContent).toContain('The running engine is below 1.5.0.')
    expect(facts.textContent).toContain('server/transfer-archive 3')
  })

  it('says an older server predates format reporting instead of guessing', async () => {
    await mount(grover)
    const facts = h.container.querySelector('[data-settings-anchor="server-facts"]')!
    expect(facts.textContent).toContain('predates format reporting')
    expect(facts.textContent).not.toContain('Running now')
  })

  it('refuses Restart and Update for a server not installed from a bundle', async () => {
    actionMock.mockImplementation(async () => info(false))
    await mount(grover)
    expect((h.control('Restart') as HTMLButtonElement).disabled).toBe(true)
    expect((h.control('Update') as HTMLButtonElement).disabled).toBe(true)
    expect(h.container.textContent).toContain('not a bundle install')
  })
})
