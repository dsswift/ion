/**
 * event-wiring-remote — tab-status push-on-idle suppression
 *
 * The sessionPlane 'tab-status-change' listener pushes a "Task completed"
 * notification to iOS when a tab goes idle. It must do so ONLY on a genuine
 * run→idle transition (oldStatus === 'running'). A session-ready idle (the
 * control plane forwarding idle for a freshly started, never-run session — the
 * profile-launch stuck-connecting fix in engine-control-plane-events.ts) arrives
 * with oldStatus 'idle'/'connecting' and must NOT push a spurious completion.
 *
 * These tests would go RED if the guard reverts to `pushOnIdle = newStatus === 'idle'`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { mockSend, mockState, sessionPlaneEmitter, lastMessagePreviewMap } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = { remoteTransport: { send: mockSend } as any, mainWindow: null }
  const sessionPlaneEmitter = new (require('events').EventEmitter)()
  const lastMessagePreviewMap = new Map<string, string>()
  return { mockSend, mockState, sessionPlaneEmitter, lastMessagePreviewMap }
})

vi.mock('../state', () => ({
  state: mockState,
  sessionPlane: sessionPlaneEmitter,
  activeAssistantMessages: new Map(),
  lastMessagePreview: lastMessagePreviewMap,
}))

vi.mock('../remote/protocol', () => ({ normalizedToRemote: vi.fn(() => null) }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { wireRemoteSessionPlaneForwarding } from '../event-wiring-remote'

// The send signature is send(payload, pushOnIdle?, pushMeta?). Find the
// tab_status call and report whether it requested a push.
function tabStatusSend(tabId = 'tab1') {
  return mockSend.mock.calls.find(
    (c) => (c[0] as any)?.type === 'desktop_tab_status' && (c[0] as any)?.tabId === tabId,
  )
}

describe('wireRemoteSessionPlaneForwarding — push-on-idle is run→idle only', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(sessionPlaneEmitter as EventEmitter).removeAllListeners()
    mockState.remoteTransport = { send: mockSend } as any
    wireRemoteSessionPlaneForwarding()
  })

  it('does NOT push on a session-ready idle (oldStatus=connecting)', () => {
    sessionPlaneEmitter.emit('tab-status-change', 'tab1', 'idle', 'connecting')
    const call = tabStatusSend()
    expect(call).toBeDefined()
    // pushOnIdle (2nd arg) must be false for a never-run session-ready idle.
    expect(call![1]).toBe(false)
  })

  it('does NOT push on a session-ready idle (oldStatus=idle)', () => {
    sessionPlaneEmitter.emit('tab-status-change', 'tab1', 'idle', 'idle')
    const call = tabStatusSend()
    expect(call).toBeDefined()
    expect(call![1]).toBe(false)
  })

  it('DOES push "Task completed" on a genuine run→idle transition', () => {
    sessionPlaneEmitter.emit('tab-status-change', 'tab1', 'idle', 'running')
    const call = tabStatusSend()
    expect(call).toBeDefined()
    expect(call![1]).toBe(true)
    expect((call![2] as any)?.title).toBe('Task completed')
  })

  it('does not resolve a live generic permission on an equal-status resync', async () => {
    sessionPlaneEmitter.emit('remote-permission', 'tab1', {
      questionId: 'q1', toolName: 'Bash', options: [],
    })
    await Promise.resolve()
    sessionPlaneEmitter.emit('tab-status-change', 'tab1', 'idle', 'idle')

    expect(mockSend.mock.calls.some(
      ([event]) => (event as { type?: string }).type === 'desktop_permission_resolved',
    )).toBe(false)
  })

  it('resolves a live generic permission on a terminal status transition', async () => {
    sessionPlaneEmitter.emit('remote-permission', 'tab1', {
      questionId: 'q1', toolName: 'Bash', options: [],
    })
    await Promise.resolve()
    sessionPlaneEmitter.emit('tab-status-change', 'tab1', 'idle', 'running')

    expect(mockSend.mock.calls.some(
      ([event]) => (event as { type?: string; questionId?: string }).type === 'desktop_permission_resolved'
        && (event as { questionId?: string }).questionId === 'q1',
    )).toBe(true)
  })

  it('marks an equal-status reassertion as a resync', () => {
    sessionPlaneEmitter.emit('tab-status-change', 'tab1', 'idle', 'idle')
    const call = tabStatusSend()
    expect(call![0]).toEqual({ type: 'desktop_tab_status', tabId: 'tab1', status: 'idle', resync: true })
  })

  it('does not mark a status transition as a resync', () => {
    sessionPlaneEmitter.emit('tab-status-change', 'tab1', 'idle', 'connecting')
    const call = tabStatusSend()
    expect(call![0]).toEqual({ type: 'desktop_tab_status', tabId: 'tab1', status: 'idle' })
  })
})
