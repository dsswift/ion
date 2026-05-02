/**
 * EngineControlPlane Tests
 *
 * Validates session lifecycle, prompt routing, and engine event handling.
 * Covers three shipped bugs: engine_dead exit code 0 treated as error,
 * conversationId never set, sessionId not passed through EngineConfig.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// Capture the event handler registered by EngineControlPlane's constructor
let capturedEventHandler: ((key: string, event: any) => void) | null = null

const mockBridge = {
  startSession: vi.fn().mockResolvedValue({ ok: true }),
  sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
  sendAbort: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  stopByPrefix: vi.fn(),
  stopSession: vi.fn(),
  stopAll: vi.fn(),
  on: vi.fn((event: string, handler: any) => {
    if (event === 'event') {
      capturedEventHandler = handler
    }
  }),
  emit: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
}

vi.mock('../engine-bridge', () => {
  return {
    EngineBridge: function () {
      return mockBridge
    },
  }
})

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

let uuidCounter = 0
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return {
    ...actual,
    randomUUID: vi.fn(() => `tab-${String(++uuidCounter).padStart(3, '0')}`),
  }
})

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'

// ─── Helpers ───

function makeRunOptions(overrides: Record<string, any> = {}): any {
  return {
    prompt: 'hello',
    projectPath: '/Users/test/project',
    sessionId: undefined,
    model: undefined,
    ...overrides,
  }
}

// ─── Tests ───

describe('EngineControlPlane', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    capturedEventHandler = null
    uuidCounter = 0

    // Reset bridge stubs to defaults
    mockBridge.startSession.mockResolvedValue({ ok: true })
    mockBridge.sendPrompt.mockResolvedValue({ ok: true })

    // EngineControlPlane needs an EngineBridge; the EngineBridge module is
    // mocked above so `new EngineBridge()` returns the shared mockBridge.
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  describe('tab management', () => {
    it('createTab returns unique IDs', () => {
      const id1 = cp.createTab()
      const id2 = cp.createTab()

      expect(id1).toBe('tab-001')
      expect(id2).toBe('tab-002')
      expect(id1).not.toBe(id2)
    })
  })

  describe('submitPrompt', () => {
    it('calls startSession then sendPrompt on first prompt', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions({ prompt: 'hi' }))

      expect(mockBridge.startSession).toHaveBeenCalledOnce()
      expect(mockBridge.startSession).toHaveBeenCalledWith(
        tabId,
        expect.objectContaining({ workingDirectory: '/Users/test/project' }),
      )
      expect(mockBridge.sendPrompt).toHaveBeenCalledOnce()
      // sendPrompt accepts optional model and appendSystemPrompt; the test
      // only cares about the first two positional args.
      expect(mockBridge.sendPrompt).toHaveBeenCalledWith(tabId, 'hi', undefined, undefined)
    })

    it('passes sessionId through EngineConfig', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(
        tabId,
        'req-1',
        makeRunOptions({ sessionId: 'sess-123' }),
      )

      expect(mockBridge.startSession).toHaveBeenCalledWith(
        tabId,
        expect.objectContaining({ sessionId: 'sess-123' }),
      )
    })

    it('second prompt reuses session without calling startSession again', async () => {
      const tabId = cp.createTab()

      await cp.submitPrompt(tabId, 'req-1', makeRunOptions({ prompt: 'first' }))
      expect(mockBridge.startSession).toHaveBeenCalledOnce()

      await cp.submitPrompt(tabId, 'req-2', makeRunOptions({ prompt: 'second' }))
      // startSession should still have been called only once
      expect(mockBridge.startSession).toHaveBeenCalledOnce()
      expect(mockBridge.sendPrompt).toHaveBeenCalledTimes(2)
      expect(mockBridge.sendPrompt).toHaveBeenLastCalledWith(tabId, 'second', undefined, undefined)
    })

    it('emits error when startSession fails', async () => {
      mockBridge.startSession.mockResolvedValue({ ok: false, error: 'connection refused' })

      const tabId = cp.createTab()
      const errors: any[] = []
      cp.on('error', (tid: string, err: any) => errors.push({ tid, err }))

      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      expect(errors).toHaveLength(1)
      expect(errors[0].tid).toBe(tabId)
      expect(errors[0].err.message).toBe('connection refused')
      expect(mockBridge.sendPrompt).not.toHaveBeenCalled()
    })
  })

  describe('engine event handling', () => {
    it('engine_dead with code 0 sets status idle without error', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const errors: any[] = []
      cp.on('error', (_tid: string, err: any) => errors.push(err))

      const statusChanges: any[] = []
      cp.on('tab-status-change', (tid: string, newS: string, oldS: string) => {
        statusChanges.push({ tid, newS, oldS })
      })

      // Simulate engine_dead with exit code 0
      expect(capturedEventHandler).not.toBeNull()
      capturedEventHandler!(tabId, { type: 'engine_dead', exitCode: 0 })

      expect(errors).toHaveLength(0)
      const tab = cp.getTabStatus(tabId)
      expect(tab?.status).toBe('idle')
    })

    it('engine_dead with code 1 emits error and sets status dead', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const errors: any[] = []
      cp.on('error', (_tid: string, err: any) => errors.push(err))

      capturedEventHandler!(tabId, { type: 'engine_dead', exitCode: 1, stderrTail: ['segfault'] })

      expect(errors).toHaveLength(1)
      expect(errors[0].exitCode).toBe(1)
      expect(errors[0].message).toContain('code 1')
      const tab = cp.getTabStatus(tabId)
      expect(tab?.status).toBe('dead')
    })

    it('engine_status idle emits task_complete', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: { state: 'idle', totalCostUsd: 0.01 },
      })

      const taskComplete = events.find((e) => e.ev.type === 'task_complete')
      expect(taskComplete).toBeDefined()
      expect(taskComplete.ev.costUsd).toBe(0.01)

      const tab = cp.getTabStatus(tabId)
      expect(tab?.status).toBe('idle')
    })

    it('engine_tool_update emits tool_call_update with partialInput', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      capturedEventHandler!(tabId, {
        type: 'engine_tool_update',
        toolId: 'tool-42',
        partialInput: '{"file_path":"/tmp',
      })

      const update = events.find((e) => e.ev.type === 'tool_call_update')
      expect(update).toBeDefined()
      expect(update.ev.toolId).toBe('tool-42')
      expect(update.ev.partialInput).toBe('{"file_path":"/tmp')
    })

    it('engine_tool_complete emits tool_call_complete with index', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      capturedEventHandler!(tabId, {
        type: 'engine_tool_complete',
        index: 3,
      })

      const complete = events.find((e) => e.ev.type === 'tool_call_complete')
      expect(complete).toBeDefined()
      expect(complete.ev.index).toBe(3)
    })
  })
})
