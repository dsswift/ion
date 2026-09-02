/**
 * terminal-tall-suspend — store-slice tests for the tall auto-suspend/restore
 * behaviour introduced to fix the "terminal opens but stays hidden in tall mode"
 * bug.
 *
 * Contract:
 *   (a) Opening the terminal on a tall tab clears tallViewTabId and sets
 *       suspendedTallTabId.
 *   (b) Closing the terminal on that tab restores tallViewTabId and clears the
 *       marker.
 *   (c) Opening the terminal on a NON-tall tab leaves tall off after close.
 *   (d) A manual toggleTallView while the terminal is open clears the marker so
 *       no restore happens on close.
 *   (e) removeTerminalInstance on the last instance triggers the same
 *       suspend/restore path as toggleTerminal.
 *   (f) Closing the tab while the marker is set clears the marker (no ghost
 *       restore against a dead tab).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Minimal mocks ─────────────────────────────────────────────────────────────

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'local-id',
    title: 'New Tab',
    workingDirectory: '~',
    hasChosenDirectory: false,
    isTerminalOnly: false,
    pillIcon: null,
    groupId: null,
  })),
  isReusableBlankTerminalTab: vi.fn(() => false),
  nextMsgId: vi.fn(() => `msg-${Math.random().toString(36).slice(2, 8)}`),
  initialModelOverride: vi.fn(() => null),
  initialPermissionMode: vi.fn(() => 'auto'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      quickTools: [],
      defaultBaseDirectory: '',
      defaultTallTerminal: false,
      tabGroupMode: 'off',
      tabGroups: [],
    }),
  },
}))

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.ion = {
  terminalCreate: vi.fn(() => Promise.resolve()),
  terminalDestroy: vi.fn(() => Promise.resolve()),
  terminalWrite: vi.fn(() => Promise.resolve()),
  closeTab: vi.fn(() => Promise.resolve()),
  gitChanges: vi.fn(() => Promise.resolve({ branch: 'main' })),
}

if (!(globalThis as any).crypto?.randomUUID) {
  ;(globalThis as any).crypto = (globalThis as any).crypto ?? {}
  ;(globalThis as any).crypto.randomUUID = () =>
    `${Math.random().toString(36).slice(2, 10)}-xxxx-4xxx-yxxx-${Math.random().toString(36).slice(2, 14)}`
}

// ─── Import after mocks ────────────────────────────────────────────────────────

import { createTerminalSlice } from '../slices/terminal-slice'
import { createExpandSlice } from '../slices/expand-slice'

// ─── Harness ──────────────────────────────────────────────────────────────────

function buildHarness(overrides: Record<string, any> = {}) {
  const state: any = {
    tabs: [{ id: 'tab1', workingDirectory: '/proj', isTerminalOnly: false }],
    terminalOpenTabIds: new Set<string>(),
    terminalPanes: new Map(),
    terminalTallTabId: null,
    terminalBigScreenTabId: null,
    tallViewTabId: null,
    suspendedTallTabId: null,
    ...overrides,
  }

  const set = (updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  }
  const get = () => state

  const termSlice = createTerminalSlice(set as any, get as any) as any
  const expandSlice = createExpandSlice(set as any, get as any) as any
  Object.assign(state, termSlice, expandSlice)

  // Wire closeTab stub — not under test here, just prevent crash in
  // removeTerminalInstance's isTerminalOnly path.
  state.closeTab = vi.fn()

  return { state, termSlice, expandSlice }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('tall auto-suspend on terminal open', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps tray visibility and shell pools isolated by conversation directory', async () => {
    const sourceDir = '/repo/source'
    const worktreeDir = '/repo/worktree'
    const { state, termSlice } = buildHarness({
      tabs: [
        { id: 'source-tab', workingDirectory: sourceDir, isTerminalOnly: false },
        { id: 'worktree-tab', workingDirectory: worktreeDir, isTerminalOnly: false },
      ],
    })

    await termSlice.toggleTerminal('worktree-tab')
    const worktreeShell = state.terminalPanes.get('worktree-tab').activeInstanceId

    expect(state.terminalOpenTabIds.has('worktree-tab')).toBe(true)
    expect(state.terminalOpenTabIds.has('source-tab')).toBe(false)
    expect(state.terminalPanes.get('worktree-tab').instances).toEqual([
      expect.objectContaining({ id: worktreeShell, cwd: worktreeDir }),
    ])
    expect(state.terminalPanes.has('source-tab')).toBe(false)

    await termSlice.toggleTerminal('source-tab')
    const sourceShell = state.terminalPanes.get('source-tab').activeInstanceId

    expect(sourceShell).not.toBe(worktreeShell)
    expect(state.terminalOpenTabIds.has('source-tab')).toBe(true)
    expect(state.terminalPanes.get('source-tab').instances).toEqual([
      expect.objectContaining({ id: sourceShell, cwd: sourceDir }),
    ])
    expect(state.terminalPanes.get('worktree-tab').instances).toEqual([
      expect.objectContaining({ id: worktreeShell, cwd: worktreeDir }),
    ])
  })

  // ── (a) open on tall tab ──────────────────────────────────────────────────

  it('clears tallViewTabId and sets suspendedTallTabId when terminal opens on a tall tab', async () => {
    const { state, termSlice } = buildHarness({ tallViewTabId: 'tab1' })

    await termSlice.toggleTerminal('tab1')

    expect(state.tallViewTabId).toBe(null)
    expect(state.suspendedTallTabId).toBe('tab1')
    expect(state.terminalOpenTabIds.has('tab1')).toBe(true)
  })

  it('does not touch tall state when terminal opens on a non-tall tab', async () => {
    const { state, termSlice } = buildHarness({ tallViewTabId: null })

    await termSlice.toggleTerminal('tab1')

    expect(state.tallViewTabId).toBe(null)
    expect(state.suspendedTallTabId).toBe(null)
  })

  // ── (b) close restores tall ───────────────────────────────────────────────

  it('restores tallViewTabId and clears marker when terminal closes on the suspended tab', async () => {
    const { state, termSlice } = buildHarness({
      tallViewTabId: null,
      suspendedTallTabId: 'tab1',
      terminalOpenTabIds: new Set(['tab1']),
    })

    await termSlice.toggleTerminal('tab1')

    expect(state.tallViewTabId).toBe('tab1')
    expect(state.suspendedTallTabId).toBe(null)
    expect(state.terminalOpenTabIds.has('tab1')).toBe(false)
  })

  // ── (c) non-tall tab: no tall restored on close ───────────────────────────

  it('does not restore tall after closing terminal on a tab that was never tall', async () => {
    const { state, termSlice } = buildHarness({ tallViewTabId: null })

    // open
    await termSlice.toggleTerminal('tab1')
    expect(state.suspendedTallTabId).toBe(null)

    // close
    await termSlice.toggleTerminal('tab1')
    expect(state.tallViewTabId).toBe(null)
    expect(state.suspendedTallTabId).toBe(null)
  })

  // ── (d) manual toggleTallView clears marker ───────────────────────────────

  it('clears suspendedTallTabId when user manually toggles tall while terminal is open', async () => {
    const { state, termSlice, expandSlice } = buildHarness({
      tallViewTabId: null,
      suspendedTallTabId: 'tab1',
      terminalOpenTabIds: new Set(['tab1']),
    })

    // User manually re-enters tall — this should clear the suspend marker.
    expandSlice.toggleTallView('tab1')

    expect(state.tallViewTabId).toBe('tab1')
    expect(state.suspendedTallTabId).toBe(null)

    // Now closing the terminal must NOT restore tall a second time.
    await termSlice.toggleTerminal('tab1')

    // tall should remain as-is (the user set it to 'tab1'); suspendedTallTabId
    // is already null so tallRestoreOnClose is a no-op.
    expect(state.suspendedTallTabId).toBe(null)
  })

  it('clears suspendedTallTabId when user manually toggles tall OFF while terminal is open', async () => {
    const { state, termSlice, expandSlice } = buildHarness({
      tallViewTabId: null,
      suspendedTallTabId: 'tab1',
      terminalOpenTabIds: new Set(['tab1']),
    })

    // Simulate: user toggles tall on some OTHER tab (or calls toggle twice).
    // The key contract is just that suspendedTallTabId is cleared.
    expandSlice.toggleTallView('tab2')

    expect(state.suspendedTallTabId).toBe(null)

    // Close terminal for tab1 — no tall restore should happen.
    await termSlice.toggleTerminal('tab1')
    expect(state.tallViewTabId).toBe('tab2') // whatever toggleTallView set
  })

  // ── (e) removeTerminalInstance last instance triggers restore ─────────────

  it('restores tall via removeTerminalInstance when the last instance is removed', async () => {
    const instanceId = 'inst-1'
    const terminalPanes = new Map([
      ['tab1', { instances: [{ id: instanceId, kind: 'user', label: 'Shell 1', readOnly: false, cwd: '/proj' }], activeInstanceId: instanceId }],
    ])

    const { state, termSlice } = buildHarness({
      tallViewTabId: null,
      suspendedTallTabId: 'tab1',
      terminalOpenTabIds: new Set(['tab1']),
      terminalPanes,
    })

    await termSlice.removeTerminalInstance('tab1', instanceId)

    expect(state.tallViewTabId).toBe('tab1')
    expect(state.suspendedTallTabId).toBe(null)
    expect(state.terminalOpenTabIds.has('tab1')).toBe(false)
  })

  it('does not restore tall via removeTerminalInstance when marker is absent', async () => {
    const instanceId = 'inst-1'
    const terminalPanes = new Map([
      ['tab1', { instances: [{ id: instanceId, kind: 'user', label: 'Shell 1', readOnly: false, cwd: '/proj' }], activeInstanceId: instanceId }],
    ])

    const { state, termSlice } = buildHarness({
      tallViewTabId: null,
      suspendedTallTabId: null,
      terminalOpenTabIds: new Set(['tab1']),
      terminalPanes,
    })

    await termSlice.removeTerminalInstance('tab1', instanceId)

    expect(state.tallViewTabId).toBe(null)
    expect(state.suspendedTallTabId).toBe(null)
  })

  // ── toggleTerminalTall clears marker ──────────────────────────────────────

  it('clears suspendedTallTabId when user enters terminal-tall mode', () => {
    const { state, termSlice } = buildHarness({
      tallViewTabId: null,
      suspendedTallTabId: 'tab1',
      terminalOpenTabIds: new Set(['tab1']),
    })

    termSlice.toggleTerminalTall('tab1')

    expect(state.terminalTallTabId).toBe('tab1')
    expect(state.suspendedTallTabId).toBe(null)
  })
})
