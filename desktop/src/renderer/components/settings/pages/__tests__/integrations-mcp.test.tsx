// @vitest-environment jsdom
/**
 * McpSection — an honest window onto the engine's MCP state: rows from the
 * snapshot on mount, connected and authorized shown separately, lastError
 * reachable, Authorize holding its pending notice for the browser round trip,
 * the add form validating before dispatch, engine refusals shown verbatim,
 * Remove behind a confirmation, Edit keeping what it does not show, an
 * optional OAuth client, and the `ion:mcp-servers-changed` broadcast
 * replacing the list. The stub stands in for the server behind the real
 * bridge table (fake-wire), so the verb mapping is pinned too.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerStatus } from '@ion/shared/types-engine-event'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { installFakeWire } from '../../../../host/__tests__/fake-wire'
import { createHarness, flush, type Harness } from './page-harness'

vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))

const { McpSection } = await import('../integrations/McpSection')

const events: { handler: ((servers: McpServerStatus[]) => void) | null } = { handler: null }
const ion = {
  mcpList: vi.fn(async (): Promise<{ ok: boolean; servers?: McpServerStatus[]; error?: string }> => ({ ok: true, servers: [] })),
  mcpAdd: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  mcpUpdate: vi.fn(async (): Promise<{ ok: boolean; changed?: boolean; credentialsCleared?: boolean; error?: string }> => ({ ok: true, changed: true, credentialsCleared: false })),
  mcpRemove: vi.fn(async () => ({ ok: true })),
  mcpLogin: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
  mcpLogout: vi.fn(async () => ({ ok: true })),
  onMcpServersChanged: vi.fn((handler: (servers: McpServerStatus[]) => void) => { events.handler = handler; return () => {} }),
}

const mobbin: McpServerStatus = { name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: false, authenticated: false }

let h: Harness
beforeEach(() => {
  vi.clearAllMocks()
  events.handler = null
  ion.mcpList.mockImplementation(async () => ({ ok: true, servers: [] }))
  ion.mcpAdd.mockImplementation(async () => ({ ok: true }))
  ion.mcpUpdate.mockImplementation(async () => ({ ok: true, changed: true, credentialsCleared: false }))
  ion.mcpLogin.mockImplementation(async () => ({ ok: true }))
  // Installed last: the wire wraps the stubs in their final state.
  ;(window as unknown as { ion: unknown }).ion = installFakeWire(ion)
  h = createHarness()
})
afterEach(() => {
  h.unmount()
  document.querySelectorAll('[role="menu"]').forEach((m) => m.remove())
})

const text = (): string => h.container.textContent ?? ''
function listed(servers: McpServerStatus[]): void { ion.mcpList.mockImplementation(async () => ({ ok: true, servers })) }
async function fireSnapshot(servers: McpServerStatus[]): Promise<void> {
  if (!events.handler) throw new Error('no mcp-servers subscription')
  await act(async () => { events.handler?.(servers); await flush() })
}
function row(name: string): HTMLElement {
  const el = [...h.container.querySelectorAll<HTMLElement>('[aria-label="MCP servers"] [role="listitem"]')].find((r) => r.textContent?.includes(name))
  if (!el) throw new Error(`no row for ${name}`)
  return el
}
async function menu(name: string): Promise<string[]> {
  await act(async () => { (row(name).querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
  return [...document.querySelectorAll('[role="menu"] button')].map((b) => b.textContent?.trim() ?? '')
}
async function pick(name: string, item: string): Promise<void> {
  await menu(name)
  const button = [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find((b) => b.textContent?.trim() === item)
  if (!button) throw new Error(`no menu item ${item}`)
  await act(async () => { button.click(); await flush(); await flush() })
}
async function type(label: string, value: string): Promise<void> {
  const input = h.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`no input ${label}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function addServer(name: string, url: string): Promise<void> {
  await h.click('Add server')
  if (name) await type('Server name', name)
  await type('Server URL', url)
  const submit = [...h.container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent === 'Add server')
  await act(async () => { submit?.click(); await flush(); await flush() })
}

describe('McpSection', () => {
  it('renders every server from the engine snapshot on mount', async () => {
    listed([{ name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: true, authenticated: true, toolCount: 4 }, { name: 'local-fs', transport: 'stdio', command: 'npx', connected: false, authenticated: false }])
    await h.render(<McpSection />)
    expect(ion.mcpList).toHaveBeenCalled()
    expect(text()).toContain('mobbin')
    expect(text()).toContain('https://api.mobbin.com/mcp')
    expect(text()).toContain('local-fs')
    expect(text()).toContain('4 tools')
    expect(text()).toContain('2 servers')
  })

  it('shows connected and authorized as independent states', async () => {
    listed([{ name: 'refusing', transport: 'http', url: 'https://x.example.test/mcp', connected: false, authenticated: true }])
    await h.render(<McpSection />)
    expect(row('refusing').querySelector('[aria-label="not connected"]')).not.toBeNull()
    expect(row('refusing').textContent).toContain('authorized')
    expect(row('refusing').textContent).not.toContain('not authorized')
  })

  it('surfaces the last connection error on the row and in the detail panel', async () => {
    listed([{ name: 'broken', transport: 'http', url: 'https://x.example.test/mcp', connected: false, authenticated: false, lastError: 'HTTP error (status 401) — run `ion mcp login broken`' }])
    await h.render(<McpSection />)
    expect(row('broken').querySelector('[aria-label*="status 401"]')).not.toBeNull()
    await act(async () => { row('broken').click(); await flush() })
    expect(text()).toContain('ion mcp login broken')
  })

  it('names the servers the organization removed, and says nothing without any', async () => {
    const { usePreferencesStore } = await import('../../../../preferences')
    await h.render(<McpSection />)
    expect(text()).not.toContain('Your organization does not allow')
    act(() => usePreferencesStore.getState().setEnterprisePolicy({ overrides: [
      { field: 'mcpServers.stray', reason: 'mcp_server_not_allowed' },
      { field: 'mcpServers.denied', reason: 'mcp_server_denied' },
      { field: 'providers.rogue', reason: 'provider_not_allowed' },
    ] }))
    expect(text()).toMatch(/Your organization does not allow these MCP servers, so their configuration on .+ is not in effect: stray, denied\./)
    act(() => usePreferencesStore.getState().setEnterprisePolicy(null))
  })

  it('says so when no server is configured', async () => {
    await h.render(<McpSection />)
    expect(text()).toContain('No MCP servers configured yet.')
  })

  it('Authorize runs the login verb, holds the browser notice for the round trip, and re-reads the list', async () => {
    listed([mobbin])
    let release: (() => void) | undefined
    ion.mcpLogin.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true }) }))
    await h.render(<McpSection />)
    await pick('mobbin', 'Authorize')
    expect(ion.mcpLogin).toHaveBeenCalledWith('mobbin')
    expect(text()).toContain('A browser window has opened')
    await act(async () => { release?.(); await flush(); await flush() })
    expect(text()).not.toContain('A browser window has opened')
    expect(ion.mcpList.mock.calls.length).toBeGreaterThan(1)
  })

  it('an authorized server offers Re-authorize and Sign out', async () => {
    listed([{ ...mobbin, connected: true, authenticated: true }])
    await h.render(<McpSection />)
    expect(await menu('mobbin')).toEqual(['Re-authorize', 'Sign out', 'Edit', 'Remove'])
    const signOut = [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find((b) => b.textContent?.trim() === 'Sign out')
    await act(async () => { signOut?.click(); await flush() })
    expect(ion.mcpLogout).toHaveBeenCalledWith('mobbin')
  })

  it('Remove asks first and removes only on confirmation', async () => {
    listed([{ ...mobbin, name: 'temp' }])
    await h.render(<McpSection />)
    await pick('temp', 'Remove')
    expect(ion.mcpRemove).not.toHaveBeenCalled()
    expect(text()).toContain('Remove temp?')
    await h.click('Remove server')
    expect(ion.mcpRemove).toHaveBeenCalledWith('temp')
  })

  it('adds a remote server from the side panel', async () => {
    await h.render(<McpSection />)
    await addServer('mobbin', 'https://api.mobbin.com/mcp')
    expect(ion.mcpAdd).toHaveBeenCalledWith({ name: 'mobbin', url: 'https://api.mobbin.com/mcp' })
    expect(h.container.querySelector('aside')).toBeNull()
  })

  it('Enter in the endpoint field submits', async () => {
    await h.render(<McpSection />)
    await h.click('Add server')
    await type('Server name', 'mobbin')
    await type('Server URL', 'https://api.mobbin.com/mcp')
    await act(async () => { h.container.querySelector('input[aria-label="Server URL"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush() })
    expect(ion.mcpAdd).toHaveBeenCalledWith({ name: 'mobbin', url: 'https://api.mobbin.com/mcp' })
  })

  it('shows an engine refusal verbatim and keeps the panel open', async () => {
    ion.mcpAdd.mockImplementation(async () => ({ ok: false, error: 'MCP server "blocked" is blocked by enterprise policy (mcpDenylist)' }))
    await h.render(<McpSection />)
    await addServer('blocked', 'https://blocked.example.test/mcp')
    expect(text()).toContain('blocked by enterprise policy')
    expect(h.container.querySelector('aside')).not.toBeNull()
  })

  it('validates before dispatching: a name, no "__", a URL scheme', async () => {
    await h.render(<McpSection />)
    await addServer('', 'https://x.example.test/mcp')
    expect(text()).toContain('Enter a name')
    await type('Server name', 'bad__name')
    await addServer('bad__name', 'https://x.example.test/mcp')
    expect(text()).toContain('"__"')
    await addServer('srv', 'api.example.test/mcp')
    expect(text()).toContain('http://')
    expect(ion.mcpAdd).not.toHaveBeenCalled()
  })

  it('splits a local command line into command and args', async () => {
    await h.render(<McpSection />)
    await h.click('Add server')
    await h.click('Local command')
    await type('Server name', 'local-fs')
    await type('Server command', 'npx -y @modelcontextprotocol/server-filesystem /tmp')
    const submit = [...h.container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent === 'Add server')
    await act(async () => { submit?.click(); await flush() })
    expect(ion.mcpAdd).toHaveBeenCalledWith({ name: 'local-fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] })
  })

  it('adds a server with only an OAuth client ID, leaving the rest to discovery', async () => {
    await h.render(<McpSection />)
    await h.click('Add server')
    await type('Server name', 'exchange')
    await type('Server URL', 'https://api.example.test/exchange/mcp')
    await h.click('Set the OAuth client')
    await type('OAuth client ID', ' client-1 ')
    const submit = [...h.container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent === 'Add server')
    await act(async () => { submit?.click(); await flush(); await flush() })
    expect(ion.mcpAdd).toHaveBeenCalledWith({ name: 'exchange', url: 'https://api.example.test/exchange/mcp', oauth: { clientId: 'client-1' } })
  })

  it('refuses an OAuth endpoint without a client ID before dispatching', async () => {
    await h.render(<McpSection />)
    await h.click('Add server')
    await type('Server name', 'exchange')
    await type('Server URL', 'https://api.example.test/exchange/mcp')
    await h.click('Set the OAuth client')
    await type('OAuth token URL', 'https://login.example.test/token')
    const submit = [...h.container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent === 'Add server')
    await act(async () => { submit?.click(); await flush() })
    expect(text()).toContain('Enter the client ID')
    expect(ion.mcpAdd).not.toHaveBeenCalled()
  })

  it('Edit fills the form from the snapshot and sends only the OAuth change, keeping the stored secret', async () => {
    listed([{ ...mobbin, name: 'exchange', oauth: { clientId: 'client-1', scope: 's1', hasClientSecret: true } }])
    await h.render(<McpSection />)
    await pick('exchange', 'Edit')
    expect(h.container.querySelector<HTMLInputElement>('input[aria-label="OAuth client ID"]')?.value).toBe('client-1')
    expect(h.container.querySelector<HTMLInputElement>('input[aria-label="OAuth client secret"]')?.placeholder).toContain('Stored')
    await type('OAuth client ID', 'client-2')
    await h.click('Save changes')
    expect(ion.mcpUpdate).toHaveBeenCalledWith({ name: 'exchange', oauth: { clientId: 'client-2', scope: 's1' } })
    expect(h.container.querySelector('aside')).toBeNull()
  })

  it('Edit can remove the stored secret, and says so when the old sign-in was dropped', async () => {
    listed([{ ...mobbin, name: 'exchange', oauth: { clientId: 'client-1', hasClientSecret: true } }])
    ion.mcpUpdate.mockImplementation(async () => ({ ok: true, changed: true, credentialsCleared: true }))
    await h.render(<McpSection />)
    await pick('exchange', 'Edit')
    await h.click('Remove')
    await h.click('Save changes')
    expect(ion.mcpUpdate).toHaveBeenCalledWith({ name: 'exchange', oauth: { clientId: 'client-1', clientSecret: '' } })
    expect(text()).toContain('authorize it again')
  })

  it('turning the OAuth client off on an edit clears the configured block', async () => {
    listed([{ ...mobbin, name: 'exchange', oauth: { clientId: 'client-1' } }])
    await h.render(<McpSection />)
    await pick('exchange', 'Edit')
    await h.click('Set the OAuth client')
    await h.click('Save changes')
    expect(ion.mcpUpdate).toHaveBeenCalledWith({ name: 'exchange', oauth: { clientSecret: '' } })
  })

  it('Edit on a local server sends only the changed command line', async () => {
    listed([{ name: 'local-fs', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], connected: false, authenticated: false }])
    await h.render(<McpSection />)
    await pick('local-fs', 'Edit')
    expect(h.container.querySelector<HTMLInputElement>('input[aria-label="Server command"]')?.value).toBe('npx -y srv')
    expect(h.maybeControl('Set the OAuth client')).toBeUndefined()
    await type('Server command', 'npx -y srv --verbose')
    await h.click('Save changes')
    expect(ion.mcpUpdate).toHaveBeenCalledWith({ name: 'local-fs', args: ['-y', 'srv', '--verbose'] })
  })

  it('names an older Ion on the server when it does not know the action', async () => {
    listed([{ ...mobbin, name: 'exchange' }])
    ion.mcpUpdate.mockImplementation(async () => { throw new StudioActionFailure('mcp.update is not a registered studio_action', 'unknown_action') })
    await h.render(<McpSection />)
    await pick('exchange', 'Edit')
    await h.click('Save changes')
    expect(text()).toContain('Could not save "exchange": This Mac runs an older version of Ion')
  })

  it('reports a failed list read instead of an empty list', async () => {
    ion.mcpList.mockImplementation(async () => ({ ok: false, error: 'engine unreachable' }))
    await h.render(<McpSection />)
    expect(text()).toContain('engine unreachable')
  })

  it('a snapshot from another client replaces the list and clears a stale error', async () => {
    ion.mcpList.mockImplementation(async () => ({ ok: false, error: 'engine unreachable' }))
    await h.render(<McpSection />)
    await fireSnapshot([{ ...mobbin, connected: true, authenticated: true, toolCount: 3 }, { ...mobbin, name: 'removed-elsewhere' }])
    expect(text()).not.toContain('engine unreachable')
    expect(text()).toContain('3 tools')
    await fireSnapshot([mobbin])
    expect(text()).not.toContain('removed-elsewhere')
    await fireSnapshot([])
    expect(text()).toContain('No MCP servers configured yet.')
  })

  it('stops following snapshots after unmount', async () => {
    listed([mobbin])
    await h.render(<McpSection />)
    const container = h.container
    act(() => h.unmount())
    await fireSnapshot([{ ...mobbin, name: 'after-unmount' }])
    expect(container.textContent).not.toContain('after-unmount')
    h = createHarness()
  })
})
