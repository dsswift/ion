// @vitest-environment jsdom
/**
 * The browser-host path for TerminalSurface. Mocking host-instance directly
 * (rather than window.ion) is what exercises a browser Studio client's
 * capability set -- see useGitRepo-browser.test.tsx's identical rationale.
 * The terminal verbs are bridged over the studio-wire, so the surface
 * attaches exactly like Electron.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { terminalAttach, onTerminalData, onTerminalExit, capabilities } = vi.hoisted(() => ({
  terminalAttach: vi.fn().mockResolvedValue({ history: '', running: true, exitCode: null, cwdFellBack: false, startError: null }),
  onTerminalData: vi.fn(() => () => undefined),
  onTerminalExit: vi.fn(() => () => undefined),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../../host/host-instance', () => ({
  host: { shell: { terminalAttach, onTerminalData, onTerminalExit, terminalWrite: vi.fn(), terminalResize: vi.fn() }, capabilities },
}))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: (selector: (s: { terminalFontFamily: string; terminalFontSize: number; uiZoom: number }) => unknown) =>
    selector({ terminalFontFamily: 'monospace', terminalFontSize: 12, uiZoom: 1 }),
}))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { TerminalSurface } from './TerminalSurface'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  terminalAttach.mockClear()
  onTerminalData.mockClear()
  onTerminalExit.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  // xterm's CoreBrowserService reads this to compute devicePixelRatio; jsdom
  // has no real implementation.
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
    root.render(React.createElement(TerminalSurface, { tabId: 'tab-1', instanceId: 'inst-1', cwd: '/repo' }))
  })
}

describe('TerminalSurface on a browser Studio client', () => {
  it('attaches through the bridged terminal verbs', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    mount()
    expect(terminalAttach).toHaveBeenCalledTimes(1)
    expect(onTerminalData).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="terminal-start-error"]')).toBeNull()
  })

  it('shows why the shell never started when the attach answers with startError', async () => {
    // The blinking-cursor-over-nothing case: the PTY spawn failed on the
    // server (node-pty's spawn-helper without its execute bit) and the attach
    // reported it. The surface must say so instead of looking like a shell
    // that is merely slow to print its prompt.
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    terminalAttach.mockResolvedValueOnce({
      history: '',
      running: false,
      exitCode: null,
      cwdFellBack: false,
      startError: 'Error: posix_spawnp failed. -- node-pty spawn-helper at /x/spawn-helper is not executable; run: chmod +x /x/spawn-helper',
    })
    mount()
    await act(async () => { await Promise.resolve() })
    const banner = container.querySelector('[data-testid="terminal-start-error"]')
    expect(banner?.textContent).toContain('failed to start')
  })
})
