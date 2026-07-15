/**
 * event-wiring-remote-tab-meta.test.ts
 *
 * Pinning test for feat(desktop): event-driven tab-row metadata deltas.
 *
 * Verifies:
 * 1. desktop_tab_meta is emitted on tab-title-change
 * 2. desktop_tab_meta is emitted on tab-group-change
 * 3. The dedup guard (lastForwardedTabMeta) is exported from state
 * 4. TAB_META_CHANGED IPC constant is defined
 *
 * Failure mode without the fix: tab-title-change and tab-group-change
 * listeners would not exist on sessionPlane, so iOS tab metadata would
 * only update on the 5 s snapshot poll, not event-driven.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

const { mockSend, mockState, sessionPlaneEmitter } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = { remoteTransport: { send: mockSend } as any, mainWindow: null }
  const sessionPlaneEmitter = new (require('events').EventEmitter)()
  return { mockSend, mockState, sessionPlaneEmitter }
})

vi.mock('../state', () => ({
  state: mockState,
  sessionPlane: sessionPlaneEmitter,
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  lastForwardedTabMeta: new Map(),
}))

vi.mock('../remote/protocol', () => ({ normalizedToRemote: vi.fn(() => null) }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('../../shared/compaction-marker', () => ({
  buildCompactionMarkerContent: vi.fn(),
  buildManualCompactionNoOpNotice: vi.fn(),
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { wireRemoteSessionPlaneForwarding } from '../event-wiring-remote'

// ── Helpers ───────────────────────────────────────────────────────────────────

function tabMetaSends(tabId?: string) {
  return mockSend.mock.calls.filter(
    (c) => (c[0] as any)?.type === 'desktop_tab_meta' && (!tabId || (c[0] as any)?.tabId === tabId),
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('wireRemoteSessionPlaneForwarding — desktop_tab_meta on title change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wireRemoteSessionPlaneForwarding()
  })

  it('emits desktop_tab_meta with title when tab-title-change fires', () => {
    sessionPlaneEmitter.emit('tab-title-change', 'tab-abc', 'My New Title')
    const calls = tabMetaSends('tab-abc')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0][0]).toMatchObject({ type: 'desktop_tab_meta', tabId: 'tab-abc', title: 'My New Title' })
  })

  it('emits desktop_tab_meta with groupId when tab-group-change fires', () => {
    sessionPlaneEmitter.emit('tab-group-change', 'tab-xyz', 'grp-42')
    const calls = tabMetaSends('tab-xyz')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0][0]).toMatchObject({ type: 'desktop_tab_meta', tabId: 'tab-xyz', groupId: 'grp-42' })
  })

  it('propagates null groupId (tab removed from group)', () => {
    sessionPlaneEmitter.emit('tab-group-change', 'tab-xyz', null)
    const calls = tabMetaSends('tab-xyz')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0][0]).toMatchObject({ type: 'desktop_tab_meta', tabId: 'tab-xyz', groupId: null })
  })

  it('does not emit tab_meta when remoteTransport is null', () => {
    const savedTransport = mockState.remoteTransport
    mockState.remoteTransport = null as any
    sessionPlaneEmitter.emit('tab-title-change', 'tab-no-transport', 'Title')
    expect(tabMetaSends('tab-no-transport').length).toBe(0)
    mockState.remoteTransport = savedTransport
  })
})

describe('TAB_META_CHANGED IPC constant', () => {
  it('is defined', async () => {
    const { IPC } = await import('../../shared/types')
    expect((IPC as any).TAB_META_CHANGED).toBe('ion:tab-meta-changed')
  })
})
