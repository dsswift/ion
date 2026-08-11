/**
 * Tests for `createTerminalInstanceOnTab` — the shared create-a-pane path
 * behind both the iOS `desktop_terminal_add_instance` command and the `ion://`
 * deep-link terminal action.
 *
 * These tests run the handler's injected script against a REAL fake store
 * rather than stubbing its return value, because the behaviour under test lives
 * inside that script: which tab it resolves, whether it marks the pane open,
 * and whether it leaves `activeTabId` alone. Stubbing `executeJavaScript` would
 * assert nothing about any of it.
 *
 * Regression contract (each fails on the pre-fix code):
 *
 *  1. "marks the pane open" — the old script wrote `terminalPanes` and never
 *     touched `terminalOpenTabIds`, so the tab held an instance the panel would
 *     not render until the operator manually toggled the terminal. RED before.
 *  2. "refuses a tab that does not exist" — the old script called
 *     `addTerminalInstance` unconditionally. In the store that resolves the cwd
 *     from `tabs.find(...)` and falls back to '~', i.e. it would happily create
 *     a pane keyed to a dead tab instead of refusing. RED before.
 *  3. "does not change the active tab" — pins the no-focus-steal property that
 *     makes a background `dev run` non-disruptive.
 *  4. "applies an explicit label" / "falls back to auto-numbering" — pins that
 *     a deep link can name a pane after its service (`api`) while the iOS
 *     caller keeps today's `Shell N`. The label parameter did not exist before.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  terminalCreate: vi.fn(),
  send: vi.fn(),
  logLines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}))

// ─── Fake renderer store ──────────────────────────────────────────────────────
//
// Mirrors the parts of the real Zustand store the injected script touches:
// `tabs`, `terminalPanes`, `terminalOpenTabIds`, `activeTabId`, plus the three
// actions. Instance-label numbering follows terminal-slice.ts (scan live 'user'
// instances, take max+1) so the auto-numbering assertion is meaningful.

interface FakeInstance { id: string; label: string; kind: string; readOnly: boolean; cwd: string }

function makeFakeStore(opts: { tabs: Array<{ id: string; workingDirectory: string }>; activeTabId: string }) {
  let seq = 0
  const s = {
    tabs: opts.tabs,
    activeTabId: opts.activeTabId,
    terminalPanes: new Map<string, { instances: FakeInstance[]; activeInstanceId: string | null }>(),
    terminalOpenTabIds: new Set<string>(),
    addTerminalInstance(tabId: string, kind: string): string {
      const tab = s.tabs.find((t) => t.id === tabId)
      const pane = s.terminalPanes.get(tabId) || { instances: [], activeInstanceId: null }
      const maxShell = pane.instances
        .filter((i) => i.kind === 'user')
        .reduce((max, i) => {
          const m = /^Shell (\d+)$/.exec(i.label)
          return m ? Math.max(max, parseInt(m[1], 10)) : max
        }, 0)
      const id = `inst${++seq}`
      pane.instances = [...pane.instances, {
        id, label: `Shell ${maxShell + 1}`, kind, readOnly: false,
        cwd: tab?.workingDirectory || '~',
      }]
      pane.activeInstanceId = id
      s.terminalPanes.set(tabId, pane)
      return id
    },
    renameTerminalInstance(tabId: string, instanceId: string, label: string): void {
      const pane = s.terminalPanes.get(tabId)
      if (!pane) return
      pane.instances = pane.instances.map((i) => (i.id === instanceId ? { ...i, label } : i))
    },
    selectTerminalInstance(tabId: string, instanceId: string): void {
      const pane = s.terminalPanes.get(tabId)
      if (!pane) return
      pane.activeInstanceId = instanceId
    },
  }
  return {
    getState: () => s,
    setState: (patch: Record<string, unknown>) => Object.assign(s, patch),
    _raw: s,
  }
}

let fakeStore: ReturnType<typeof makeFakeStore>

/**
 * Stands in for `webContents.executeJavaScript`: evaluates the script with
 * `window.__Ion_SESSION_STORE__` bound to the fake store, which is what makes
 * these tests exercise the real script body.
 */
function evaluateInRenderer(source: string): Promise<unknown> {
  const globalsShim = { __Ion_SESSION_STORE__: fakeStore }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test harness: evaluates the handler's own injected script against a fake store, which is the behaviour under test
  const fn = new Function('window', `return (${source.trim()})`)
  return Promise.resolve(fn(globalsShim))
}

vi.mock('../../../state', () => ({
  state: {
    mainWindow: { webContents: { executeJavaScript: (src: string) => evaluateInRenderer(src) } },
    remoteTransport: { send: (...a: any[]) => mocks.send(...a), sendToDevice: vi.fn() },
  },
  terminalScrollback: new Map<string, string>(),
}))

vi.mock('../../../logger', () => ({
  log: (_tag: string, msg: string, fields?: Record<string, unknown>) => {
    mocks.logLines.push({ msg, fields })
  },
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../../broadcast', () => ({ broadcast: vi.fn() }))

vi.mock('../../../terminal-manager-instance', () => ({
  terminalManager: {
    create: (...a: any[]) => mocks.terminalCreate(...a),
    write: vi.fn(), resize: vi.fn(), destroy: vi.fn(),
  },
}))

import { createTerminalInstanceOnTab, handleTerminalAddInstance } from '../terminal'

beforeEach(() => {
  mocks.terminalCreate.mockReset()
  mocks.send.mockReset()
  mocks.logLines.length = 0
  fakeStore = makeFakeStore({
    tabs: [
      { id: 'tab-a', workingDirectory: '/repo/a' },
      { id: 'tab-b', workingDirectory: '/repo/b' },
    ],
    // The operator is looking at tab-b while the request targets tab-a.
    activeTabId: 'tab-b',
  })
})

describe('createTerminalInstanceOnTab', () => {
  it('creates the instance on the NAMED tab, not the active one', async () => {
    const result = await createTerminalInstanceOnTab('tab-a')

    expect(result).not.toBeNull()
    expect(fakeStore._raw.terminalPanes.get('tab-a')?.instances).toHaveLength(1)
    expect(fakeStore._raw.terminalPanes.has('tab-b')).toBe(false)
    // PTY keyed to the named tab, with that tab's cwd.
    expect(mocks.terminalCreate).toHaveBeenCalledWith(`tab-a:${result!.id}`, '/repo/a')
  })

  it('marks the pane open so the panel renders it', async () => {
    await createTerminalInstanceOnTab('tab-a')

    expect(fakeStore._raw.terminalOpenTabIds.has('tab-a')).toBe(true)
  })

  it('does not change the active tab (no focus steal)', async () => {
    await createTerminalInstanceOnTab('tab-a')

    expect(fakeStore._raw.activeTabId).toBe('tab-b')
  })

  it('selects the new instance within its own pane', async () => {
    const result = await createTerminalInstanceOnTab('tab-a')

    expect(fakeStore._raw.terminalPanes.get('tab-a')?.activeInstanceId).toBe(result!.id)
  })

  it('refuses a tab that does not exist and creates nothing', async () => {
    const result = await createTerminalInstanceOnTab('tab-gone')

    expect(result).toBeNull()
    expect(mocks.terminalCreate).not.toHaveBeenCalled()
    expect(fakeStore._raw.terminalPanes.size).toBe(0)
    expect(fakeStore._raw.terminalOpenTabIds.size).toBe(0)
    expect(mocks.logLines.some((l) => l.msg.includes('no such tab'))).toBe(true)
  })

  it('applies an explicit label so a pane can be named after its service', async () => {
    const result = await createTerminalInstanceOnTab('tab-a', { label: 'api' })

    expect(result!.label).toBe('api')
  })

  it('falls back to auto-numbering when no label is given', async () => {
    const first = await createTerminalInstanceOnTab('tab-a')
    const second = await createTerminalInstanceOnTab('tab-a')

    expect(first!.label).toBe('Shell 1')
    expect(second!.label).toBe('Shell 2')
  })

  it('numbers a labelled pane around existing shells without disturbing them', async () => {
    // Shell 1 already exists (the pane the operator ran `dev` from); the
    // service panes that follow take their names, and a later unlabelled pane
    // still numbers from the live 'user' instances.
    const shell1 = await createTerminalInstanceOnTab('tab-a')
    await createTerminalInstanceOnTab('tab-a', { label: 'api' })
    const next = await createTerminalInstanceOnTab('tab-a')

    expect(shell1!.label).toBe('Shell 1')
    expect(next!.label).toBe('Shell 2')
  })
})

describe('handleTerminalAddInstance (iOS command)', () => {
  it('echoes the created instance back to the device', async () => {
    await handleTerminalAddInstance({ type: 'desktop_terminal_add_instance', tabId: 'tab-a' } as any)

    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'desktop_terminal_instance_added',
      tabId: 'tab-a',
    }))
  })

  it('sends nothing when the tab does not exist', async () => {
    await handleTerminalAddInstance({ type: 'desktop_terminal_add_instance', tabId: 'tab-gone' } as any)

    expect(mocks.send).not.toHaveBeenCalled()
  })
})
