// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortForward, PortListener } from '@ion/shared/port-forward'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  environmentId: 'env-remote',
  hasPortForward: true,
  action: vi.fn<(environmentId: string, name: string, args: unknown[]) => Promise<unknown>>(),
  start: vi.fn(async (environmentId: string, remotePort: number) => ({ ok: true as const, forward: { environmentId, remotePort, localPort: remotePort, activeStreams: 0 } })),
  stop: vi.fn(async () => true),
  openBrowserTab: vi.fn(),
  forwards: [] as PortForward[],
}))

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../../hooks/useInteractiveState', () => ({
  useInteractiveState: () => ({ hover: false, pressed: false, handlers: {} }),
  interactiveBg: () => 'transparent',
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) => selector({ activeTabId: 'tab-1' }),
}))
vi.mock('../../connection/tab-environment', () => ({
  useActiveTabEnvironmentId: () => mocks.environmentId,
  environmentOfTab: () => mocks.environmentId,
}))
vi.mock('../../transfer/environment-label-cache', () => ({ useEnvironmentLabel: () => 'work-laptop' }))
vi.mock('../../surface/surface-store', () => ({ useSurfaceStore: { getState: () => ({ openBrowserTab: mocks.openBrowserTab }) } }))
vi.mock('../../../host/host-instance', () => ({
  action: mocks.action,
  host: {
    get portForward() {
      return mocks.hasPortForward
        ? { start: mocks.start, stop: mocks.stop, list: async () => mocks.forwards, onChange: () => () => {} }
        : null
    },
  },
}))

import { PortsSurface } from '../PortsSurface'
import { resetPortForwardStoreForTests, usePortForwardStore } from '../port-forward-store'

const listeners: PortListener[] = [
  { port: 5173, pid: 101, processName: 'node', tabId: 'tab-1', url: 'http://localhost:5173' },
  { port: 7071, pid: 300, processName: 'func', tabId: 'tab-2', url: null },
  { port: 5432, pid: 400, processName: 'com.docker.backend', tabId: null, url: null },
]

let container: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  await act(async () => {
    root.render(<PortsSurface />)
  })
  // The listener read and the forward list both settle on a later microtask.
  await act(async () => {
    await Promise.resolve()
  })
}

function row(port: number): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="port-row-${port}"]`)
  if (!el) throw new Error(`no row for port ${port}`)
  return el
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const el = [...scope.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!el) throw new Error(`no "${label}" button`)
  return el
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.environmentId = 'env-remote'
  mocks.hasPortForward = true
  mocks.forwards = []
  mocks.action.mockReset()
  mocks.action.mockResolvedValue(listeners)
  mocks.start.mockClear()
  mocks.stop.mockClear()
  mocks.openBrowserTab.mockClear()
  resetPortForwardStoreForTests()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PortsSurface', () => {
  it('asks the conversation\'s own Environment what is listening', async () => {
    await render()
    expect(mocks.action).toHaveBeenCalledWith('env-remote', 'port.listeners', [])
  })

  it('lists this conversation\'s listeners apart from the rest of the host', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text.indexOf('This conversation')).toBeLessThan(text.indexOf('5173'))
    expect(text.indexOf('5173')).toBeLessThan(text.indexOf('Other ports on work-laptop'))
    expect(text.indexOf('Other ports on work-laptop')).toBeLessThan(text.indexOf('7071'))
    expect(row(5432).textContent).toContain('not forwarded')
  })

  it('forwards a port on click', async () => {
    await render()
    await act(async () => { button(row(7071), 'Forward').click() })
    expect(mocks.start).toHaveBeenCalledWith('env-remote', 7071)
  })

  it('"Forward all" forwards this conversation\'s ports and no others', async () => {
    await render()
    await act(async () => { button(container, 'Forward all').click() })
    expect(mocks.start.mock.calls).toEqual([['env-remote', 5173]])
  })

  it('shows a forwarded port at its local address and opens it there, keeping the web URL\'s path', async () => {
    mocks.action.mockResolvedValue([{ ...listeners[0], url: 'http://localhost:5173/app' }])
    mocks.forwards = [{ environmentId: 'env-remote', remotePort: 5173, localPort: 61000, activeStreams: 0 }]
    await render()

    expect(row(5173).textContent).toContain('localhost:61000')
    await act(async () => { button(row(5173), 'Open').click() })
    expect(mocks.openBrowserTab).toHaveBeenCalledWith('http://localhost:61000/app', 'browse')

    await act(async () => { button(row(5173), 'Stop').click() })
    expect(mocks.stop).toHaveBeenCalledWith('env-remote', 5173)
  })

  it('opens a port with no known URL over HTTPS', async () => {
    mocks.forwards = [{ environmentId: 'env-remote', remotePort: 7071, localPort: 7071, activeStreams: 0 }]
    await render()

    await act(async () => { button(row(7071), 'Open').click() })

    expect(mocks.openBrowserTab).toHaveBeenCalledWith('https://localhost:7071', 'browse')
  })

  it('keeps a forwarded port on screen when nothing reports listening there', async () => {
    mocks.action.mockResolvedValue([])
    mocks.forwards = [{ environmentId: 'env-remote', remotePort: 9000, localPort: 9000, activeStreams: 0 }]
    await render()
    expect(row(9000).textContent).toContain('localhost:9000')
  })

  it('does not show another Environment\'s forwards', async () => {
    mocks.action.mockResolvedValue([])
    mocks.forwards = [{ environmentId: 'env-other', remotePort: 9000, localPort: 9000, activeStreams: 0 }]
    await render()
    expect(container.querySelector('[data-testid="port-row-9000"]')).toBeNull()
  })

  it('says the server is too old when it does not know the action', async () => {
    mocks.action.mockRejectedValue(new StudioActionFailure('port.listeners is not a registered studio_action', 'unknown_action'))
    await render()
    expect(container.querySelector('[data-testid="ports-error"]')?.textContent).toContain('too old')
  })

  it('shows why the last forward failed', async () => {
    await render()
    act(() => usePortForwardStore.setState({ lastError: 'Could not open a local port for 5173' }))
    expect(container.querySelector('[data-testid="ports-error"]')?.textContent).toContain('Could not open a local port')
  })

  it('asks nothing of a conversation on this machine', async () => {
    mocks.environmentId = 'local'
    await render()
    expect(mocks.action).not.toHaveBeenCalled()
    expect(container.textContent).toContain('already at localhost')
  })

  it('asks nothing on a client that cannot listen on its own machine', async () => {
    mocks.hasPortForward = false
    await render()
    expect(mocks.action).not.toHaveBeenCalled()
    expect(container.textContent).toContain('needs the desktop app')
  })
})
