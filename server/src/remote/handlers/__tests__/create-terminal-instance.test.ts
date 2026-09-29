/**
 * Tests for `createTerminalInstanceOnTab` — the shared create-a-pane path
 * behind both the iOS `desktop_terminal_add_instance` command and the `ion://`
 * deep-link terminal action.
 *
 * These tests run the handler against a REAL fake store rather than stubbing
 * its return value, because the behaviour under test lives inside the store
 * actions the handler calls: which tab it resolves, whether it marks the
 * pane open, and whether it leaves `activeTabId` alone.
 *
 * Migration note: this handler used to reach the renderer via
 * `executeJavaScript`, injecting a script that ran against
 * `window.__Ion_SESSION_STORE__`. The store now runs in-process with this
 * handler, so `createTerminalInstanceOnTab` calls `useSessionStore.getState()`
 * directly — no script injection, no renderer round trip. These tests mock
 * `store/sessionStore` with a fake store exposing the same shape the real
 * Zustand store does.
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
  broadcast: vi.fn(),
  openExternal: vi.fn(),
  logLines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}))

// ─── Fake store ───────────────────────────────────────────────────────────
//
// Mirrors the parts of the real Zustand store the handler touches: `tabs`,
// `terminalPanes`, `terminalOpenTabIds`, `activeTabId`, plus the three
// actions. Instance-label numbering follows terminal-slice.ts (scan live
// 'user' instances, take max+1) so the auto-numbering assertion is
// meaningful.

interface FakeInstance { id: string; label: string; kind: string; readOnly: boolean; cwd: string; launchKey?: string }

function makeFakeStore(opts: { tabs: Array<{ id: string; workingDirectory: string }>; activeTabId: string }) {
  let seq = 0
  const s = {
    tabs: opts.tabs,
    activeTabId: opts.activeTabId,
    selectTab(tabId: string): void {
      s.activeTabId = tabId
    },
    terminalPanes: new Map<string, { instances: FakeInstance[]; activeInstanceId: string | null }>(),
    terminalOpenTabIds: new Set<string>(),
    async addTerminalInstance(tabId: string, kind: string, cwd?: string, requestedLabel?: string, launchKey?: string): Promise<string> {
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
        id, label: requestedLabel || `Shell ${maxShell + 1}`, kind, readOnly: false,
        // Mirrors terminal-slice.ts: an explicit caller directory wins; an
        // ordinary iOS/user pane keeps the tab working-directory fallback.
        cwd: cwd || tab?.workingDirectory || '~',
        ...(launchKey ? { launchKey } : {}),
      }]
      pane.activeInstanceId = id
      s.terminalPanes.set(tabId, pane)
      s.terminalOpenTabIds.add(tabId)
      mocks.terminalCreate(`${tabId}:${id}`, cwd || tab?.workingDirectory || '~')
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
    async removeTerminalInstance(_tabId: string, _instanceId: string): Promise<void> {
      // Not exercised by this suite; present so the mock shape matches the
      // real store for any handler that touches it.
    },
  }
  return {
    getState: () => s,
    setState: (patch: Record<string, unknown>) => Object.assign(s, patch),
    _raw: s,
  }
}

let fakeStore: ReturnType<typeof makeFakeStore>

vi.mock('../../../store/host-api', () => ({ openExternal: (...args: any[]) => mocks.openExternal(...args) }))
vi.mock('../../../persistence/settings-store', () => ({ readSettings: vi.fn(() => ({})), settingsDir: () => '/tmp/ion-create-terminal-instance-test'}))

vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => fakeStore.getState(),
  },
}))

vi.mock('../../../state', () => ({
  state: {
    remoteTransport: { send: (...a: any[]) => mocks.send(...a), sendToDevice: vi.fn() },
  },
  enterprisePolicyCache: { policy: null },
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

vi.mock('../../../broadcast', () => ({ broadcast: (...args: any[]) => mocks.broadcast(...args) }))

vi.mock('../../../terminal/terminal-manager-instance', () => ({
  terminalManager: {
    create: (...a: any[]) => mocks.terminalCreate(...a),
    activitySnapshot: vi.fn(() => [{
      key: 'tab-a:inst-1', tabId: 'tab-a', instanceId: 'inst-1', active: true,
      processLabel: 'vite', processIds: [1], applications: [{
        id: 'native:1:5173', kind: 'web', url: 'http://localhost:5173', port: 5173,
        pid: 1, processName: 'node', source: 'native',
      }],
    }]),
    write: vi.fn(), resize: vi.fn(), destroy: vi.fn(),
  },
}))

import { createTerminalInstanceOnTab, findTerminalInstanceByLaunchKey, openTerminalApplication } from '../terminal'

beforeEach(() => {
  mocks.terminalCreate.mockReset()
  mocks.send.mockReset()
  mocks.broadcast.mockReset()
  mocks.openExternal.mockReset()
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
    // The owner store action starts the PTY. The main deep-link/iOS helper must
    // not start it a second time.
    expect(mocks.terminalCreate).toHaveBeenCalledTimes(1)
    expect(mocks.terminalCreate).toHaveBeenCalledWith(`tab-a:${result!.id}`, '/repo/a')
  })

  it('uses an explicit service directory for both pane metadata and PTY cwd', async () => {
    // Regression: `dev run` sent a per-service directory through ion://, but
    // action-terminal discarded it. The shared creator therefore called the
    // store with no cwd, which fell back to /repo/a. `func start` then searched
    // the repo root for host.json and `dotnet watch --project file.csproj`
    // searched it for the service csproj — both failed despite the terminals
    // launching successfully.
    const result = await createTerminalInstanceOnTab('tab-a', { cwd: '/repo/a/services/functions' })

    expect(mocks.terminalCreate).toHaveBeenCalledTimes(1)
    expect(mocks.terminalCreate)
      .toHaveBeenCalledWith(`tab-a:${result!.id}`, '/repo/a/services/functions')
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

  it('contains store failure and creates no PTY', async () => {
    // Migration: the handler used to catch a rejected executeJavaScript
    // (renderer round trip); it now catches a throw from the in-process
    // store action itself. See terminal.ts's catch around
    // `s.addTerminalInstance` — the log message is
    // "store request threw", not the old "renderer request threw".
    vi.spyOn(fakeStore._raw, 'addTerminalInstance').mockRejectedValueOnce(new Error('store disconnected'))

    const result = await createTerminalInstanceOnTab('tab-a')

    expect(result).toBeNull()
    expect(mocks.terminalCreate).not.toHaveBeenCalled()
    expect(mocks.logLines.some((line) => line.msg.includes('store request threw'))).toBe(true)
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

describe('findTerminalInstanceByLaunchKey', () => {
  it('finds the pane a launch tagged, only within the named conversation', async () => {
    const created = await createTerminalInstanceOnTab('tab-a', { label: 'api', launchKey: 'dev.yaml/abc/api' })
    await createTerminalInstanceOnTab('tab-a')

    expect(findTerminalInstanceByLaunchKey('tab-a', 'dev.yaml/abc/api')).toEqual({ id: created!.id, label: 'api' })
    expect(findTerminalInstanceByLaunchKey('tab-b', 'dev.yaml/abc/api')).toBeNull()
    expect(findTerminalInstanceByLaunchKey('tab-a', 'dev.yaml/abc/web')).toBeNull()
  })
})

describe('openTerminalApplication', () => {
  const command = { tabId: 'tab-a', url: 'http://localhost:5173' } as const

  it('selects the owning tab in the store, then routes the application to Studio', () => {
    expect(openTerminalApplication(command.tabId, command.url)).toBe(true)

    expect(fakeStore.getState().activeTabId).toBe('tab-a')
    expect(mocks.broadcast).toHaveBeenCalledWith('studio:open-web-application', {
      tabId: command.tabId,
      url: command.url,
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
