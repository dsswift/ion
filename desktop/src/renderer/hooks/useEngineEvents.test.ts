// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEngineEvents } from './useEngineEvents'
import { host } from '../host/host-instance'
import { useSessionStore } from '@ion/server/store/sessionStore'

const { terminalActivitySnapshot, onTerminalActivity, onEvent, capabilities, onFrame } = vi.hoisted(() => ({
  terminalActivitySnapshot: vi.fn(() => Promise.resolve([])),
  onTerminalActivity: vi.fn(() => vi.fn()),
  onEvent: vi.fn(() => vi.fn()),
  capabilities: vi.fn<() => string[]>(),
  onFrame: vi.fn(() => vi.fn()),
}))

/**
 * Every other `host.shell` method this hook touches (onTabStatusChange,
 * on/off for the remote-control channels, etc.) is irrelevant to the gates
 * under test -- a Proxy default of a no-op subscribe/unsubscribe keeps the
 * hook's other effects from throwing on mount without hand-enumerating
 * ~20 unrelated methods.
 */
const shell = new Proxy(
  { terminalActivitySnapshot, onTerminalActivity, onEvent },
  {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return (..._args: unknown[]) => vi.fn()
    },
  },
) as unknown as import('../../preload/ionapi').IonAPI

vi.mock('../host/host-instance', () => ({ host: { capabilities, shell: undefined, onFrame } }))
// The local Environment is connected, so the activity sync reads it at once.
vi.mock('../studio/connection/registry', () => ({
  registry: { subscribe: (listener: (states: Map<string, { phase: string }>) => void) => { listener(new Map([['local', { phase: 'connected' }]])); return () => {} } },
}))
vi.mock('../studio/connection/catalog', () => ({ isManageOnlyEnvironment: () => false }))

function Probe(): React.ReactElement {
  useEngineEvents()
  return React.createElement('div')
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  terminalActivitySnapshot.mockClear()
  onTerminalActivity.mockClear()
  onEvent.mockClear()
  onFrame.mockClear()
  ;(host as unknown as { shell: unknown }).shell = shell
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useEngineEvents terminal activity bootstrap', () => {
  it('reads the activity snapshot and subscribes on a browser Studio client', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    act(() => root.render(React.createElement(Probe)))
    expect(terminalActivitySnapshot).toHaveBeenCalledTimes(1)
    expect(onTerminalActivity).toHaveBeenCalledTimes(1)
  })

  it('does the same on the Electron window', () => {
    capabilities.mockReturnValue(['nativeShell'])
    act(() => root.render(React.createElement(Probe)))
    expect(terminalActivitySnapshot).toHaveBeenCalledTimes(1)
    expect(onTerminalActivity).toHaveBeenCalledTimes(1)
  })
})

describe('useEngineEvents delivery path', () => {
  // The engine-event stream is wire frames on every host. The Electron
  // window used to claim a 'directEvents' capability and skip the LOCAL
  // Environment's frames in favour of raw main-process IPC -- IPC that lost
  // its producer when the store moved into the Studio server, so every local
  // conversation rendered empty. These pin that no host takes that path.
  it('subscribes to studio-wire frames and never to shell.onEvent (browser Studio client)', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    act(() => root.render(React.createElement(Probe)))
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('subscribes to studio-wire frames and never to shell.onEvent (Electron)', () => {
    capabilities.mockReturnValue(['nativeShell'])
    act(() => root.render(React.createElement(Probe)))
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('applies a LOCAL Environment normalized-event frame to the store', () => {
    capabilities.mockReturnValue(['nativeShell'])
    const handleNormalizedEvent = vi.fn()
    useSessionStore.setState({ handleNormalizedEvent } as never)
    act(() => root.render(React.createElement(Probe)))
    const deliver = (onFrame.mock.calls as unknown as Array<[(envId: string, frame: unknown) => void]>)[0][0]
    act(() => {
      deliver('local', { type: 'studio_event', channel: 'ion:normalized-event', payload: ['tab-1', { type: 'text_chunk', text: 'hi' }] })
    })
    // The queue drains on the next animation frame or the 50ms fallback.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(handleNormalizedEvent).toHaveBeenCalledWith('tab-1', { type: 'text_chunk', text: 'hi' })
        resolve()
      }, 150)
    })
  })
})
