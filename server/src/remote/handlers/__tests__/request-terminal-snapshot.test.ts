/**
 * Tests for `readTerminalPaneSnapshot` — one conversation's whole terminal
 * pane, however the client asked for it (`terminal.paneSnapshot`).
 *
 * What this file covers
 * ─────────────────────
 *   1. Pane-missing auto-create. When a snapshot is read for a tab whose
 *      store has no `terminalPanes` entry (nobody ever opened the terminal
 *      panel), it must mirror the panel's first-mount behavior: auto-create
 *      the default "Shell" instance via the owner store's
 *      `addTerminalInstance`. That store action starts the PTY before it
 *      publishes metadata, so nothing here starts a second one, and the
 *      answer carries exactly that instance.
 *   2. Pane-present passthrough. When the pane exists, the answer carries
 *      the pane's instances, its active instance id, and the scrollback this
 *      server holds — and creates nothing.
 *
 * Regression contract
 * ───────────────────
 * On the unfixed code the pane-missing path returned null with nothing
 * created. Test #1 goes red there: it asserts both the store's
 * `addTerminalInstance` call and the returned instance.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  terminalCreate: vi.fn(),
  addTerminalInstance: vi.fn(),
}))

// The store's own `terminalPanes` Map is the shared state the reader and
// `addTerminalInstance` both read/write, exactly as the real
// `useSessionStore` singleton does.
const terminalPanesMap = new Map<string, { instances: any[]; activeInstanceId: string | null }>()
let tabs: Array<{ id: string }> = [{ id: 'tab-abc' }]

vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      tabs,
      terminalPanes: terminalPanesMap,
      addTerminalInstance: (...a: any[]) => mocks.addTerminalInstance(...a),
    }),
  },
}))

vi.mock('../../../state', () => ({
  state: {},
  terminalScrollback: new Map<string, string>(),
  enterprisePolicyCache: { policy: undefined },
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../../broadcast', () => ({ broadcast: vi.fn() }))

vi.mock('../../../terminal/terminal-manager-instance', () => ({
  terminalManager: {
    create: (...a: any[]) => mocks.terminalCreate(...a),
    write: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
    activitySnapshot: vi.fn(() => []),
  },
}))

import { readTerminalPaneSnapshot } from '../terminal'
import { terminalScrollback } from '../../../state'

beforeEach(() => {
  mocks.terminalCreate.mockReset()
  mocks.addTerminalInstance.mockReset()
  terminalPanesMap.clear()
  ;(terminalScrollback as Map<string, string>).clear()
  tabs = [{ id: 'tab-abc' }]
})

describe('readTerminalPaneSnapshot', () => {
  it('auto-creates the default instance and answers with it when the tab has no pane', async () => {
    // No pane registered for 'tab-abc' — mirrors a user who never opened the
    // terminal panel. `addTerminalInstance` is the owner
    // store action: it must publish the new pane into `terminalPanes`
    // before returning the new instance id, exactly like the real
    // `TerminalPanel.tsx` first-mount default (kind 'user').
    mocks.addTerminalInstance.mockImplementation(async (tabId: string) => {
      terminalPanesMap.set(tabId, {
        instances: [{ id: 'inst1234', label: 'Shell 1', kind: 'user', cwd: '/repo/work', readOnly: false }],
        activeInstanceId: 'inst1234',
      })
      return 'inst1234'
    })

    const snapshot = await readTerminalPaneSnapshot('tab-abc')

    // The auto-create path must call the owner store's addTerminalInstance
    // with kind 'user' — same default TerminalPanel.tsx creates on mount.
    expect(mocks.addTerminalInstance).toHaveBeenCalledTimes(1)
    expect(mocks.addTerminalInstance).toHaveBeenCalledWith('tab-abc', 'user', undefined, undefined, undefined)

    // The owner store action starts the PTY. Main must not start it a second time.
    expect(mocks.terminalCreate).not.toHaveBeenCalled()

    // The answer carries exactly the new instance.
    expect(snapshot).toEqual({
      tabId: 'tab-abc',
      instances: [{ id: 'inst1234', label: 'Shell 1', kind: 'user', readOnly: false, cwd: '/repo/work' }],
      activeInstanceId: 'inst1234',
      buffers: undefined,
    })
  })

  it('answers with the existing pane instances when the pane exists (no auto-create)', async () => {
    terminalPanesMap.set('tab-abc', {
      instances: [
        { id: 'a1', label: 'Shell 1', kind: 'user', readOnly: false, cwd: '/repo' },
        { id: 'b2', label: 'Commit', kind: 'commit', readOnly: true, cwd: '/repo' },
      ],
      activeInstanceId: 'a1',
    })
    ;(terminalScrollback as Map<string, string>).set('tab-abc:a1', 'scrollback-a1')

    const snapshot = await readTerminalPaneSnapshot('tab-abc')

    // Existing pane: no auto-create, no PTY spawn.
    expect(mocks.addTerminalInstance).not.toHaveBeenCalled()
    expect(mocks.terminalCreate).not.toHaveBeenCalled()

    expect(snapshot).toEqual({
      tabId: 'tab-abc',
      instances: [
        { id: 'a1', label: 'Shell 1', kind: 'user', readOnly: false, cwd: '/repo' },
        { id: 'b2', label: 'Commit', kind: 'commit', readOnly: true, cwd: '/repo' },
      ],
      activeInstanceId: 'a1',
      buffers: { a1: 'scrollback-a1' },
    })
  })
})
