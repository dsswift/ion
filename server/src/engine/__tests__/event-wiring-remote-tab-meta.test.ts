/**
 * event-wiring-remote-tab-meta.test.ts
 *
 * Pinning test for feat(desktop): event-driven tab-row metadata deltas.
 *
 * Verifies:
 * 1. desktop_tab_meta is emitted on tab-title-change
 * 2. The dedup guard (lastForwardedTabMeta) is exported from state
 *
 * (The renderer-initiated half -- title and pill changes -- is the
 * server's `tabMetaChanged` in `store/host-api-misc.ts`, pinned by
 * `server/src/store/__tests__/host-api-misc-tab-meta.test.ts`.)
 *
 * Failure mode without the fix: the tab-title-change listener would not
 * exist on sessionPlane, so iOS tab metadata would
 * only update on the 5 s snapshot poll, not event-driven.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

const { mockSend, mockState, sessionPlaneEmitter } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = { mainWindow: null }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sessionPlaneEmitter = new (require('events').EventEmitter)()
  return { mockSend, mockState, sessionPlaneEmitter }
})

// The `desktop_*` device transport is gone; a RemoteEvent now leaves the
// server through `sendRemoteEvent`, which fans it to thin Studio-wire
// clients. Capture there, and drive the "is anyone listening" gate with
// `remoteClientsPresent`.
const { mockClientsPresent } = vi.hoisted(() => ({ mockClientsPresent: vi.fn(() => true) }))

vi.mock('../../thin-view/remote-out', () => ({
  sendRemoteEvent: mockSend,
  remoteClientsPresent: mockClientsPresent,
  syncRemoteAttention: vi.fn(),
  thinConnections: vi.fn(() => []),
  sendThinEventTo: vi.fn(() => true),
}))

vi.mock('../../state', async (importOriginal) => ({ ...(await importOriginal()), ...{
  state: mockState,
  sessionPlane: sessionPlaneEmitter,
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  lastForwardedTabMeta: new Map(),
} }))

vi.mock('@ion/shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('@ion/shared/compaction-marker', () => ({
  buildCompactionMarkerContent: vi.fn(),
  buildManualCompactionNoOpNotice: vi.fn(),
}))

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

  it('does not emit tab_meta when no remote client is listening', () => {
    mockClientsPresent.mockReturnValue(false)
    sessionPlaneEmitter.emit('tab-title-change', 'tab-no-transport', 'Title')
    expect(tabMetaSends('tab-no-transport').length).toBe(0)
    mockClientsPresent.mockReturnValue(true)
  })
})
