// @vitest-environment jsdom
//
// McpCategory.test.tsx — the MCP settings surface.
//
// What matters here is that the category is an honest window onto engine state:
//
//  1. Rows render from the engine's snapshot on mount (view-readiness: complete
//     from the first frame, no fill-in).
//  2. connected and authenticated are shown SEPARATELY, so the diagnostic case —
//     a stored token being refused — is visible rather than collapsed into one
//     "ok" badge.
//  3. lastError reaches the operator, since it is often the only explanation
//     available without reading the engine host's log file.
//  4. Authorize invokes the login IPC and holds its pending state for the whole
//     browser round trip.
//  5. The add form validates before dispatching, so a name the engine would
//     reject is caught locally instead of after a round trip.
//  6. An engine refusal (enterprise policy, a bad transport combination) is
//     surfaced verbatim instead of being swallowed.

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../../rendererLogger', () => ({
  rInfo: vi.fn(),
  rError: vi.fn(),
  rWarn: vi.fn(),
  rDebug: vi.fn(),
  rTrace: vi.fn(),
}))

import { McpCategory } from '../McpCategory'
import type { EngineEvent, McpServerStatus } from '../../../../shared/types-engine-event'

/**
 * Captured engine-event subscription. The component subscribes on mount to
 * converge on transitions other clients cause; tests fire synthetic events
 * through this handler to stand in for the engine's broadcast.
 */
const engineEvents: {
  handler: ((key: string, event: EngineEvent) => void) | null
  unsubscribe: ReturnType<typeof vi.fn>
} = { handler: null, unsubscribe: vi.fn() }

const ion = {
  mcpList: vi.fn(async () => ({ ok: true, servers: [] as McpServerStatus[] })),
  mcpAdd: vi.fn(async () => ({ ok: true })),
  mcpRemove: vi.fn(async () => ({ ok: true })),
  mcpLogin: vi.fn(async () => ({ ok: true, authorizationUrl: 'https://auth.example.test/authorize' })),
  mcpLogout: vi.fn(async () => ({ ok: true })),
  onEngineEvent: vi.fn((handler: (key: string, event: EngineEvent) => void) => {
    engineEvents.handler = handler
    return engineEvents.unsubscribe
  }),
}

/** Fires a synthetic engine event at the component's live subscription. */
async function fireEngineEvent(event: EngineEvent): Promise<void> {
  if (!engineEvents.handler) throw new Error('component has no engine-event subscription')
  await act(async () => {
    engineEvents.handler?.('', event)
  })
}

let container: HTMLDivElement
let root: Root

/** Renders and flushes the mount-time list fetch. */
async function renderCategory(): Promise<void> {
  await act(async () => {
    root.render(<McpCategory />)
  })
}

/** Finds a button by its visible label. */
function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined
}

async function click(label: string): Promise<void> {
  const el = button(label)
  if (!el) throw new Error(`no button labelled "${label}" (have: ${Array.from(container.querySelectorAll('button')).map((b) => b.textContent).join(', ')})`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function typeInto(placeholder: string, value: string): Promise<void> {
  const input = container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null
  if (!input) throw new Error(`no input with placeholder "${placeholder}"`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(window as unknown as { ion: typeof ion }).ion = ion
  vi.clearAllMocks()
  engineEvents.handler = null
  ion.onEngineEvent.mockImplementation((handler: (key: string, event: EngineEvent) => void) => {
    engineEvents.handler = handler
    return engineEvents.unsubscribe
  })
  ion.mcpList.mockImplementation(async () => ({ ok: true, servers: [] }))
  ion.mcpAdd.mockImplementation(async () => ({ ok: true }))
  ion.mcpRemove.mockImplementation(async () => ({ ok: true }))
  ion.mcpLogin.mockImplementation(async () => ({ ok: true, authorizationUrl: 'https://auth.example.test/authorize' }))
  ion.mcpLogout.mockImplementation(async () => ({ ok: true }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('McpCategory', () => {
  it('renders configured servers from the engine snapshot on mount', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [
        { name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: true, authenticated: true, toolCount: 4 },
        { name: 'local-fs', transport: 'stdio', command: 'npx', connected: false, authenticated: false },
      ],
    }))

    await renderCategory()

    expect(ion.mcpList).toHaveBeenCalled()
    expect(container.textContent).toContain('mobbin')
    expect(container.textContent).toContain('https://api.mobbin.com/mcp')
    expect(container.textContent).toContain('local-fs')
    // Tool count renders immediately rather than filling in later.
    expect(container.textContent).toContain('4 tools')
  })

  it('shows connected and authorized as independent states', async () => {
    // The diagnostic case: a stored token that the server is refusing.
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [
        { name: 'refusing', transport: 'http', url: 'https://x.example.test/mcp', connected: false, authenticated: true },
      ],
    }))

    await renderCategory()

    expect(container.textContent).toContain('not connected')
    expect(container.textContent).toContain('authorized')
    expect(container.textContent).not.toContain('not authorized')
  })

  it('surfaces the last connection error', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [
        {
          name: 'broken',
          transport: 'http',
          url: 'https://x.example.test/mcp',
          connected: false,
          authenticated: false,
          lastError: 'mcp initialize broken: HTTP error (status 401) — run `ion mcp login broken`',
        },
      ],
    }))

    await renderCategory()

    expect(container.textContent).toContain('status 401')
    expect(container.textContent).toContain('ion mcp login broken')
  })

  it('empty state does not read as an error', async () => {
    await renderCategory()
    expect(container.textContent).toContain('No MCP servers configured yet.')
  })

  it('Authorize invokes the login IPC for that server', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [{ name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: false, authenticated: false }],
    }))

    await renderCategory()
    await click('Authorize')

    expect(ion.mcpLogin).toHaveBeenCalledWith('mobbin')
    // The list is re-read so the authorized state appears without a manual refresh.
    expect(ion.mcpList.mock.calls.length).toBeGreaterThan(1)
  })

  it('holds a pending message while the browser step is outstanding', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [{ name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: false, authenticated: false }],
    }))
    // A login that never settles, standing in for the operator being in their browser.
    let release: (() => void) | undefined
    ion.mcpLogin.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, authorizationUrl: 'https://auth.example.test/authorize' })
        }),
    )

    await renderCategory()
    await click('Authorize')

    expect(container.textContent).toContain('A browser window has opened')
    expect(container.textContent).toContain('mobbin')

    await act(async () => {
      release?.()
    })
    expect(container.textContent).not.toContain('A browser window has opened')
  })

  it('an already-authorized server offers Re-authorize and Sign out', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [{ name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: true, authenticated: true }],
    }))

    await renderCategory()

    expect(button('Re-authorize')).toBeTruthy()
    expect(button('Authorize')).toBeUndefined()

    await click('Sign out')
    expect(ion.mcpLogout).toHaveBeenCalledWith('mobbin')
  })

  it('Remove invokes the remove IPC', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [{ name: 'temp', transport: 'http', url: 'https://x.example.test/mcp', connected: false, authenticated: false }],
    }))

    await renderCategory()
    await click('Remove')

    expect(ion.mcpRemove).toHaveBeenCalledWith('temp')
  })

  it('surfaces an engine refusal verbatim', async () => {
    // e.g. enterprise policy. The engine's specific reason must reach the
    // operator, not a generic failure message.
    ion.mcpAdd.mockImplementation(async () => ({
      ok: false,
      error: 'MCP server "blocked" is blocked by enterprise policy (mcpDenylist)',
    }))

    await renderCategory()
    await typeInto('Name (e.g. mobbin)', 'blocked')
    await typeInto('https://api.example.com/mcp', 'https://blocked.example.test/mcp')
    await click('Add server')

    expect(container.textContent).toContain('blocked by enterprise policy')
  })

  it('adds a remote server through the IPC surface', async () => {
    await renderCategory()
    await typeInto('Name (e.g. mobbin)', 'mobbin')
    await typeInto('https://api.example.com/mcp', 'https://api.mobbin.com/mcp')
    await click('Add server')

    expect(ion.mcpAdd).toHaveBeenCalledWith({ name: 'mobbin', url: 'https://api.mobbin.com/mcp' })
  })

  it('rejects a name containing the tool separator without a round trip', async () => {
    await renderCategory()
    await typeInto('Name (e.g. mobbin)', 'bad__name')
    await typeInto('https://api.example.com/mcp', 'https://x.example.test/mcp')
    await click('Add server')

    expect(ion.mcpAdd).not.toHaveBeenCalled()
    expect(container.textContent).toContain('__')
  })

  it('rejects a URL with no scheme without a round trip', async () => {
    await renderCategory()
    await typeInto('Name (e.g. mobbin)', 'srv')
    await typeInto('https://api.example.com/mcp', 'api.example.test/mcp')
    await click('Add server')

    expect(ion.mcpAdd).not.toHaveBeenCalled()
    expect(container.textContent).toContain('http://')
  })

  it('requires a name before dispatching', async () => {
    await renderCategory()
    await typeInto('https://api.example.com/mcp', 'https://x.example.test/mcp')
    await click('Add server')

    expect(ion.mcpAdd).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enter a name')
  })

  it('splits a local command line into command and args', async () => {
    await renderCategory()
    await click('Local (command)')
    await typeInto('Name (e.g. mobbin)', 'local-fs')
    await typeInto('npx -y @scope/mcp-server', 'npx -y @modelcontextprotocol/server-filesystem /tmp')
    await click('Add server')

    expect(ion.mcpAdd).toHaveBeenCalledWith({
      name: 'local-fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    })
  })

  it('reports a failed list read instead of rendering an empty list', async () => {
    ion.mcpList.mockImplementation(async () => ({ ok: false, error: 'engine unreachable', servers: undefined as unknown as McpServerStatus[] }))

    await renderCategory()

    expect(container.textContent).toContain('engine unreachable')
  })

  // --- engine_mcp_servers broadcast convergence ---
  //
  // The engine broadcasts a complete server snapshot on every MCP state
  // transition, from ANY client. These tests pin that an open Settings panel
  // converges on transitions it did not cause — the concrete case being an
  // `ion mcp login` completed in a terminal while the panel is open, which
  // without the subscription stayed on "not authorized" until remount.

  it('converges when another client authorizes a server (CLI login while panel is open)', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [{ name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: false, authenticated: false }],
    }))

    await renderCategory()
    expect(container.textContent).toContain('not authorized')

    // The terminal-side `ion mcp login mobbin` completes; the engine
    // broadcasts the updated snapshot to every connected client.
    await fireEngineEvent({
      type: 'engine_mcp_servers',
      mcpServers: [{ name: 'mobbin', transport: 'http', url: 'https://api.mobbin.com/mcp', connected: true, authenticated: true, toolCount: 3 }],
    })

    expect(container.textContent).not.toContain('not authorized')
    expect(container.textContent).toContain('authorized')
    expect(container.textContent).toContain('connected')
    expect(container.textContent).toContain('3 tools')
  })

  it('replaces the list with the snapshot rather than merging (snapshot semantics)', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [
        { name: 'keep', transport: 'http', url: 'https://a.example.test/mcp', connected: false, authenticated: false },
        { name: 'removed-elsewhere', transport: 'http', url: 'https://b.example.test/mcp', connected: false, authenticated: false },
      ],
    }))

    await renderCategory()
    expect(container.textContent).toContain('removed-elsewhere')

    // Another client removed a server. The snapshot is authoritative: an
    // entry absent from it must vanish, not linger from a merge.
    await fireEngineEvent({
      type: 'engine_mcp_servers',
      mcpServers: [{ name: 'keep', transport: 'http', url: 'https://a.example.test/mcp', connected: false, authenticated: false }],
    })

    expect(container.textContent).not.toContain('removed-elsewhere')
    expect(container.textContent).toContain('keep')
  })

  it('an empty snapshot is the authoritative no-servers signal', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [{ name: 'last-one', transport: 'http', url: 'https://x.example.test/mcp', connected: false, authenticated: false }],
    }))

    await renderCategory()
    expect(container.textContent).toContain('last-one')

    await fireEngineEvent({ type: 'engine_mcp_servers', mcpServers: [] })

    expect(container.textContent).not.toContain('last-one')
    expect(container.textContent).toContain('No MCP servers configured yet.')
  })

  it('a received snapshot supersedes a stale local error', async () => {
    ion.mcpList.mockImplementation(async () => ({ ok: false, error: 'engine unreachable', servers: undefined as unknown as McpServerStatus[] }))

    await renderCategory()
    expect(container.textContent).toContain('engine unreachable')

    // The engine came back and broadcast fresh truth; the dead error must not
    // sit above a live, correct list.
    await fireEngineEvent({
      type: 'engine_mcp_servers',
      mcpServers: [{ name: 'srv', transport: 'http', url: 'https://x.example.test/mcp', connected: false, authenticated: false }],
    })

    expect(container.textContent).not.toContain('engine unreachable')
    expect(container.textContent).toContain('srv')
  })

  it('ignores unrelated engine events', async () => {
    ion.mcpList.mockImplementation(async () => ({
      ok: true,
      servers: [{ name: 'srv', transport: 'http', url: 'https://x.example.test/mcp', connected: false, authenticated: false }],
    }))

    await renderCategory()

    await fireEngineEvent({ type: 'engine_working_message', message: 'busy...' } as EngineEvent)

    expect(container.textContent).toContain('srv')
  })

  it('unsubscribes from engine events on unmount', async () => {
    await renderCategory()
    expect(ion.onEngineEvent).toHaveBeenCalledTimes(1)

    act(() => root.unmount())

    expect(engineEvents.unsubscribe).toHaveBeenCalledTimes(1)
    // afterEach unmounts again; recreate the root so that unmount is a no-op
    // on a fresh, empty tree instead of a double-unmount.
    root = createRoot(container)
  })
})
