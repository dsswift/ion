// @vitest-environment jsdom
/**
 * Regression tests for terminal scrollback restoration on first mount.
 *
 * THE DEFECT (pre-existing, on the iOS-created-instance path):
 * Ion's PTYs are owned by the MAIN process (`main/terminal-manager.ts`, keyed
 * `"<tabId>:<instanceId>"`); the renderer's xterm is a viewer that attaches to
 * a key. A PTY can therefore be created and stream output while its tab has
 * never been mounted — an instance created from iOS, or (as of the `ion://`
 * deep-link surface) a pane opened into a background conversation. In that
 * window the output accumulates ONLY in the main-process `terminalScrollback`
 * map (`main/state.ts`).
 *
 * `TerminalInstance.tsx` restored history exclusively from `consumeSavedBuffer`,
 * a renderer-only map fed by TAB RESTORE and never by main. So navigating to
 * such a tab showed an EMPTY pane for a service that had been logging for
 * minutes. The fix fetches main's scrollback on first mount when no saved
 * buffer exists.
 *
 * WHY THESE TESTS FAIL WITHOUT THE FIX:
 *   - "fetches main-process scrollback" — `terminalGetScrollback` is never
 *     called at all, so the spy has zero calls.
 *   - "writes fetched history into the terminal" — nothing is written, so the
 *     written text never contains the backlog.
 *   - "does not fetch when a saved buffer exists" — passes before and after;
 *     it pins that the fix did not regress the tab-restore path.
 *   - "orders late-arriving live output after the fetched history" — before the
 *     fix there is no history to order against; after the fix it pins the
 *     queue that prevents live chunks from interleaving ahead of the backlog.
 *     This is the ordering hazard the async fetch introduces, so it is pinned
 *     explicitly rather than left to chance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── xterm stubs ──────────────────────────────────────────────────────────────
//
// The real xterm touches canvas/WebGL APIs jsdom does not implement. We only
// care about the ORDER and CONTENT of terminal.write() calls, so the stub
// records them.

const written: string[] = []
const fakeTerminals: FakeTerminal[] = []

class FakeTerminal {
  readonly writes: string[] = []
  buffer = { active: { getLine: () => null } }
  constructor() { fakeTerminals.push(this) }
  // The component mutates `options` in a second effect (readOnly/theme sync),
  // so the stub must carry a real object or that effect throws.
  options: Record<string, unknown> = { theme: {} }
  write(data: string): void { this.writes.push(data); written.push(data) }
  open(): void { /* no-op: nothing to attach in jsdom */ }
  focus(): void { /* no-op */ }
  reset(): void { /* no-op */ }
  dispose(): void { /* no-op */ }
  loadAddon(): void { /* no-op */ }
  hasSelection(): boolean { return false }
  getSelection(): string { return '' }
  clearSelection(): void { /* no-op */ }
  selectAll(): void { /* no-op */ }
  attachCustomKeyEventHandler(): void { /* no-op */ }
  registerLinkProvider(): { dispose: () => void } { return { dispose: () => {} } }
  onData(): { dispose: () => void } { return { dispose: () => {} } }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit(): void {} proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 } } },
}))
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class { serialize(): string { return '' } },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// Theme + preferences + store are read at module scope by the component.
vi.mock('../../theme', () => ({
  useColors: () => ({ textPrimary: '#fff', accent: '#0af', focusRing: '#0af' }),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ terminalFontFamily: 'monospace', terminalFontSize: 12, uiZoom: 1 }),
    { getState: () => ({ terminalFontFamily: 'monospace', terminalFontSize: 12, uiZoom: 1, quickTools: [] }) },
  ),
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ staticInfo: { homePath: '/Users/test' } }),
    {
      getState: () => ({
        staticInfo: { homePath: '/Users/test' },
        consumeTerminalPendingCommand: () => undefined,
        openFileInEditor: () => {},
      }),
    },
  ),
}))
vi.mock('../../rendererLogger', () => ({
  rDebug: () => {}, rWarn: () => {}, rInfo: () => {}, rError: () => {}, rTrace: () => {},
}))

// ─── window.ion bridge ────────────────────────────────────────────────────────

let dataCallback: ((key: string, data: string) => void) | null = null
let exitCallback: ((key: string, exitCode: number) => void) | null = null
const onTerminalData = vi.fn((cb: (key: string, data: string) => void) => {
  dataCallback = cb
  return () => { dataCallback = null }
})
const onTerminalExit = vi.fn((cb: (key: string, exitCode: number) => void) => {
  exitCallback = cb
  return () => { exitCallback = null }
})
const terminalGetScrollback = vi.fn<(key: string) => Promise<string>>()

function installIonBridge(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.ion = {
    terminalCreate: vi.fn().mockResolvedValue(undefined),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminalDestroy: vi.fn().mockResolvedValue(undefined),
    terminalGetScrollback,
    onTerminalData,
    onTerminalExit,
    openExternal: vi.fn(),
    fsExists: vi.fn().mockResolvedValue({ exists: false }),
    fsOpenNative: vi.fn(),
  }
}

// ResizeObserver is not implemented in jsdom.
class FakeResizeObserver {
  observe(): void {} unobserve(): void {} disconnect(): void {}
}

describe('TerminalInstance scrollback restoration', () => {
  beforeEach(() => {
    written.length = 0
    fakeTerminals.length = 0
    dataCallback = null
    exitCallback = null
    onTerminalData.mockClear()
    onTerminalExit.mockClear()
    terminalGetScrollback.mockReset()
    terminalGetScrollback.mockResolvedValue('')
    // React 18+ requires this flag for act() to flush effects synchronously.
    // Without it React warns and effect timing is not guaranteed, which would
    // make the ordering assertion below unreliable rather than wrong.
    ;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
    ;(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: () => void) => {
      cb()
      return 1
    }
    ;(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {}
    installIonBridge()
  })

  afterEach(() => {
    vi.resetModules()
  })

  /**
   * Mounts the component for a fresh key and returns once effects have run.
   * Each test uses a unique key because TerminalInstance keeps a MODULE-LEVEL
   * pool of xterm instances that intentionally survives unmount — reusing a key
   * across tests would hit the pool and skip the first-mount path under test.
   */
  async function mount(key: string, opts: { savedBuffer?: string } = {}): Promise<void> {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const mod = await import('../TerminalInstance')
    const { act } = await import('react')

    if (opts.savedBuffer) mod.setSavedBuffer(key, opts.savedBuffer)

    const [tabId, instanceId] = key.split(':')
    const container = document.createElement('div')
    document.body.appendChild(container)

    await act(async () => {
      createRoot(container).render(
        React.createElement(mod.TerminalInstanceView, {
          tabId,
          instanceId,
          cwd: '/repo',
          readOnly: false,
        }),
      )
    })
  }

  it('fetches main-process scrollback on first mount when no saved buffer exists', async () => {
    terminalGetScrollback.mockResolvedValue('service booted\n')

    await mount('tab-a:inst-a')

    expect(terminalGetScrollback).toHaveBeenCalledWith('tab-a:inst-a')
  }, 20_000)

  it('writes the fetched history into the terminal', async () => {
    terminalGetScrollback.mockResolvedValue('listening on :3000\n')

    await mount('tab-b:inst-b')

    expect(written.join('')).toContain('listening on :3000')
  })

  it('does not fetch scrollback when a saved buffer already exists', async () => {
    await mount('tab-c:inst-c', { savedBuffer: 'restored from disk\n' })

    expect(terminalGetScrollback).not.toHaveBeenCalled()
    expect(written.join('')).toContain('restored from disk')
  })

  it('uses one IPC listener pair and routes output by terminal key', async () => {
    await mount('tab-e:inst-e')
    await mount('tab-f:inst-f')

    expect(onTerminalData).toHaveBeenCalledTimes(1)
    expect(onTerminalExit).toHaveBeenCalledTimes(1)
    expect(dataCallback).toBeTypeOf('function')
    expect(exitCallback).toBeTypeOf('function')

    dataCallback!('tab-f:inst-f', 'SECOND')

    expect(fakeTerminals).toHaveLength(2)
    expect(fakeTerminals[0].writes).not.toContain('SECOND')
    expect(fakeTerminals[1].writes).toContain('SECOND')
  })

  it('orders late-arriving live output after the fetched history', async () => {
    // Hold the fetch open so a live chunk provably arrives while it is pending.
    let releaseHistory: (value: string) => void = () => {}
    terminalGetScrollback.mockReturnValue(
      new Promise<string>((resolve) => { releaseHistory = resolve }),
    )

    await mount('tab-d:inst-d')

    // Live output arrives BEFORE the history resolves.
    expect(dataCallback).toBeTypeOf('function')
    dataCallback!('tab-d:inst-d', 'LIVE')

    // It must not have been written yet — that would put it ahead of history.
    expect(written.join('')).not.toContain('LIVE')

    const { act } = await import('react')
    await act(async () => {
      releaseHistory('HISTORY')
      await Promise.resolve()
    })

    const transcript = written.join('')
    expect(transcript).toContain('HISTORY')
    expect(transcript).toContain('LIVE')
    expect(transcript.indexOf('HISTORY')).toBeLessThan(transcript.indexOf('LIVE'))
  })
})
