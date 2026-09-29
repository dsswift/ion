// @vitest-environment jsdom
/**
 * TerminalInstanceView (the Conversation Terminal Panel, distinct from the
 * Studio Surface's TerminalSurface -- see TerminalSurface-browser.test.tsx's
 * identical rationale for why host-instance is mocked directly rather than
 * driving window.ion) installs its terminal listeners on every host: the
 * terminal verbs are bridged over the studio-wire, so a browser Studio
 * client attaches exactly like Electron.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { terminalCreate, terminalAttach, onTerminalData, onTerminalExit, onTerminalRestarted, capabilities } = vi.hoisted(() => ({
  terminalCreate: vi.fn().mockResolvedValue(undefined),
  terminalAttach: vi.fn().mockResolvedValue({ history: '', running: true, exitCode: null, cwdFellBack: false }),
  onTerminalData: vi.fn(() => () => undefined),
  onTerminalExit: vi.fn(() => () => undefined),
  onTerminalRestarted: vi.fn(() => () => undefined),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../host/host-instance', () => ({
  host: {
    shell: { terminalCreate, terminalAttach, onTerminalData, onTerminalExit, onTerminalRestarted, terminalWrite: vi.fn(), terminalResize: vi.fn(), fsExists: vi.fn(), fsOpenNative: vi.fn() },
    capabilities,
  },
}))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (s: { terminalFontFamily: string; terminalFontSize: number; uiZoom: number }) => unknown) =>
    selector({ terminalFontFamily: 'monospace', terminalFontSize: 12, uiZoom: 1 }),
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ staticInfo: { homePath: '/home/user' } }) },
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rTrace: vi.fn(), rWarn: vi.fn() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { TerminalInstanceView } from '../TerminalInstance'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  terminalCreate.mockClear()
  terminalAttach.mockClear()
  onTerminalData.mockClear()
  onTerminalExit.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  window.matchMedia ??= ((): MediaQueryList => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(TerminalInstanceView, { tabId: 'tab-1', instanceId: 'inst-1', cwd: '/repo', readOnly: false }))
  })
}

describe('TerminalInstanceView on a browser Studio client', () => {
  it('installs terminal listeners', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    mount()
    expect(onTerminalData).toHaveBeenCalledTimes(1)
    expect(onTerminalExit).toHaveBeenCalledTimes(1)
    expect(onTerminalRestarted).toHaveBeenCalledTimes(1)
  })
})
