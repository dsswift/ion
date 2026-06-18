/**
 * event-wiring — engine-view tab_status + permission_request synthesis
 *
 * When engine-view events arrive on compound keys (`tabId:instanceId`),
 * they bypass EngineControlPlane (keyed by bare tabId). That means no
 * `tab-status-change` fires on the sessionPlane and iOS never learns
 * the tab transitioned from 'running' to 'idle'/'completed'.
 *
 * `wireEngineBridgeEvents` synthesizes `tab_status` and
 * `permission_request` messages for the remote transport. These tests
 * pin the derivation logic, dedup guards, and push-notification metadata.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Mock setup ───
// vi.mock factories are hoisted above all declarations, so we must
// create the mock objects inside the factory or use vi.hoisted().

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockSend,
  mockState,
  mockPermDenialSet,
  mockLastStatusMap,
  capturedHandler,
} = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = {
    remoteTransport: { send: mockSend } as any,
    mainWindow: null,
  }
  const mockPermDenialSet = new Set<string>()
  const mockLastStatusMap = new Map<string, string>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  return { mockSend, mockState, mockPermDenialSet, mockLastStatusMap, capturedHandler }
})

vi.mock('../state', () => ({
  state: mockState,
  sessionPlane: { on: vi.fn(), emit: vi.fn(), notifyConversationCleared: vi.fn() },
  engineBridge: {
    on: vi.fn((event: string, handler: any) => {
      if (event === 'event') capturedHandler.fn = handler
    }),
    sendReconcileState: vi.fn(),
  },
  activeAssistantMessages: new Map(),
  activeToolInputs: new Map(),
  lastMessagePreview: new Map(),
  extensionCommandRegistry: new Map(),
  forwardedEnginePermissionDenials: mockPermDenialSet,
  lastForwardedEngineTabStatus: mockLastStatusMap,
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../settings-store', () => ({ currentBackend: 'test' }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

// ─── Helpers ───

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

function engineStatus(fields: Record<string, any>): any {
  return { type: 'engine_status', fields }
}

function tabStatusCalls(tabId = 'tab1') {
  return mockSend.mock.calls.filter(
    (c) => c[0]?.type === 'desktop_tab_status' && c[0]?.tabId === tabId,
  )
}

function permRequestCalls(toolName?: string) {
  return mockSend.mock.calls.filter(
    (c) => c[0]?.type === 'desktop_permission_request' && (!toolName || c[0]?.toolName === toolName),
  )
}

// ─── Tests ───

describe('wireEngineBridgeEvents — tab_status synthesis for iOS', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    wireEngineBridgeEvents()
  })

  it('synthesizes tab_status=idle from engine_status state=idle (no denials)', () => {
    emit('tab1:inst1', engineStatus({ state: 'idle' }))

    const calls = tabStatusCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toEqual({ type: 'desktop_tab_status', tabId: 'tab1', status: 'idle' })
  })

  it('synthesizes tab_status=completed when idle + ExitPlanMode denial', () => {
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'ExitPlanMode', toolUseId: 'tu1' }],
    }))

    const calls = tabStatusCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0].status).toBe('completed')
  })

  it('synthesizes tab_status=completed when idle + AskUserQuestion denial', () => {
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'AskUserQuestion', toolUseId: 'tu2' }],
    }))

    const calls = tabStatusCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0].status).toBe('completed')
  })

  it('synthesizes tab_status=running from engine_status state=running', () => {
    emit('tab1:inst1', engineStatus({ state: 'running' }))

    const calls = tabStatusCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0].status).toBe('running')
  })

  it('deduplicates: same derived status not sent twice', () => {
    emit('tab1:inst1', engineStatus({ state: 'running' }))
    emit('tab1:inst1', engineStatus({ state: 'running' }))
    emit('tab1:inst1', engineStatus({ state: 'running' }))

    expect(tabStatusCalls()).toHaveLength(1)
  })

  it('sends again when derived status changes', () => {
    emit('tab1:inst1', engineStatus({ state: 'running' }))
    emit('tab1:inst1', engineStatus({ state: 'idle' }))

    const calls = tabStatusCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0][0].status).toBe('running')
    expect(calls[1][0].status).toBe('idle')
  })

  it('does not synthesize tab_status for bare-key events (no instanceId)', () => {
    emit('tab1', engineStatus({ state: 'idle' }))

    expect(tabStatusCalls()).toHaveLength(0)
  })

  it('does not synthesize tab_status when remoteTransport is null', () => {
    mockState.remoteTransport = null
    emit('tab1:inst1', engineStatus({ state: 'idle' }))

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('treats non-interactive denials as plain idle (not completed)', () => {
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'SomeOtherTool', toolUseId: 'tu3' }],
    }))

    const calls = tabStatusCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0].status).toBe('idle')
  })
})

describe('wireEngineBridgeEvents — permission_request synthesis for iOS', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    wireEngineBridgeEvents()
  })

  it('synthesizes permission_request for ExitPlanMode denial', () => {
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'ExitPlanMode', toolUseId: 'tu1', toolInput: { planFilePath: '/p' } }],
    }))

    const calls = permRequestCalls('ExitPlanMode')
    expect(calls).toHaveLength(1)
    expect(calls[0][0].questionId).toBe('denied-tu1')
    expect(calls[0][0].tabId).toBe('tab1')
    expect(calls[0][0].toolInput).toEqual({ planFilePath: '/p' })
    // Push notification metadata
    expect(calls[0][1]).toBe(true)
    expect(calls[0][2]).toEqual({ title: 'Ion needs your attention', body: 'Plan ready for your review' })
  })

  it('synthesizes permission_request for AskUserQuestion denial', () => {
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'AskUserQuestion', toolUseId: 'tu2', toolInput: { question: 'Which?' } }],
    }))

    const calls = permRequestCalls('AskUserQuestion')
    expect(calls).toHaveLength(1)
    expect(calls[0][0].questionId).toBe('denied-tu2')
    expect(calls[0][2]?.body).toBe('Question waiting for your answer')
  })

  it('deduplicates permission_request by toolUseId', () => {
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'ExitPlanMode', toolUseId: 'tu1' }],
    }))
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'ExitPlanMode', toolUseId: 'tu1' }],
    }))

    expect(permRequestCalls('ExitPlanMode')).toHaveLength(1)
  })

  it('ignores non-interactive denial tool names', () => {
    emit('tab1:inst1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'Bash', toolUseId: 'tu5' }],
    }))

    expect(permRequestCalls()).toHaveLength(0)
  })

  it('does not synthesize permission_request for bare-key events', () => {
    emit('tab1', engineStatus({
      state: 'idle',
      permissionDenials: [{ toolName: 'ExitPlanMode', toolUseId: 'tu1' }],
    }))

    expect(permRequestCalls()).toHaveLength(0)
  })
})
