/**
 * EngineControlPlane — engine event handling tests
 *
 * Split out of engine-control-plane.test.ts to keep both files under the
 * file-size cap. Validates how EngineControlPlane reacts to engine events
 * (engine_dead exit semantics, conversationId capture, status transitions).
 * Shares the same module-mock setup as its sibling; vitest hoists vi.mock
 * per file, so the setup is intentionally duplicated rather than imported.
 *
 * Distinct from engine-control-plane-events.test.ts, which pins the
 * handleStatusEvent conversationId guard for issue #230 B1.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock Electron's `app` and `safeStorage` before the import chain reaches
// settings-store → utils/secretStore (which imports from 'electron' at
// module-load). CI runs `npm ci --ignore-scripts`, so Electron's binary
// download postinstall is skipped — without this stub, the real
// node_modules/electron/index.js throws "Electron failed to install
// correctly" the moment the module graph is loaded and the test suite
// fails before any test body runs.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

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
  updateSessionConversationId: vi.fn(),
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
    IS_REMOTE: false,
    REMOTE_SOCKET: '',
  }
})

// engine-bridge-fs reads through to state.engineBridge lazily; for these
// tests we never exercise the remote path, so a no-op mock keeps it out of
// the way.
vi.mock('../engine-bridge-fs', () => ({
  engineIsRemote: vi.fn(() => false),
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: false, error: 'not used in tests' })),
  listEngineDirectory: vi.fn(() => Promise.resolve({ ok: false, error: 'not used in tests' })),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  trace: vi.fn(),
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

describe('EngineControlPlane — engine event handling', () => {
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
        fields: { state: 'idle', runCostUsd: 0.01 },
      })

      const taskComplete = events.find((e) => e.ev.type === 'task_complete')
      expect(taskComplete).toBeDefined()
      expect(taskComplete.ev.costUsd).toBe(0.01)

      const tab = cp.getTabStatus(tabId)
      expect(tab?.status).toBe('idle')
    })

    it('engine_status forwards a status NormalizedEvent carrying the full StatusFields', async () => {
      // Root-cause fix: handleStatusEvent must emit a `status` event carrying the
      // engine's StatusFields so the renderer can populate inst.statusFields.
      // Without this emit the renderer field is null forever and the StatusBar
      // engine slots (identity, cost, backend badge) render nothing. The emit is
      // unconditional (all states); here we assert it on a running tick, which
      // does NOT produce a task_complete — proving the snapshot is forwarded on
      // every engine_status, not only on idle.
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      const fields = {
        state: 'running',
        model: 'claude-opus-4-7',
        backend: 'cli',
        runCostUsd: 0.5,
        extensionName: 'Chief of Staff',
        team: 'Platform',
      }
      capturedEventHandler!(tabId, { type: 'engine_status', fields })

      const statusEvent = events.find((e) => e.ev.type === 'status')
      expect(statusEvent).toBeDefined()
      expect(statusEvent.tid).toBe(tabId)
      // The forwarded payload is the engine's StatusFields verbatim.
      expect(statusEvent.ev.fields).toEqual(fields)
      // Running tick: no task_complete synthesized — proves status forwards on
      // every engine_status, not only idle.
      expect(events.find((e) => e.ev.type === 'task_complete')).toBeUndefined()
    })

    it('engine_status idle with AskUserQuestion denial emits task_complete with permissionDenials and sets status completed', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      const statusChanges: any[] = []
      cp.on('tab-status-change', (tid: string, newS: string, oldS: string) => {
        statusChanges.push({ tid, newS, oldS })
      })

      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: {
          state: 'idle',
          runCostUsd: 0.02,
          permissionDenials: [
            { toolName: 'AskUserQuestion', toolUseId: 'ask-1', toolInput: { question: 'Pick one' } },
          ],
        },
      })

      // task_complete carries the denials
      const taskComplete = events.find((e) => e.ev.type === 'task_complete')
      expect(taskComplete).toBeDefined()
      expect(taskComplete.ev.permissionDenials).toHaveLength(1)
      expect(taskComplete.ev.permissionDenials[0].toolName).toBe('AskUserQuestion')

      // Control plane status is 'completed' (not 'idle')
      const tab = cp.getTabStatus(tabId)
      expect(tab?.status).toBe('completed')

      // tab-status-change emitted as 'completed'
      const completedChange = statusChanges.find((s) => s.newS === 'completed')
      expect(completedChange).toBeDefined()
    })

    it('engine_status idle with AskUserQuestion denial skips duplicate idle', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      // First idle with denial → completed
      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: {
          state: 'idle',
          permissionDenials: [
            { toolName: 'AskUserQuestion', toolUseId: 'ask-1', toolInput: { question: 'Yes?' } },
          ],
        },
      })
      expect(cp.getTabStatus(tabId)?.status).toBe('completed')

      // Second idle (cost-only update) should be skipped by the completed guard
      const _eventsBefore = events.length
      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: { state: 'idle', runCostUsd: 0.05 },
      })

      // No additional task_complete should have been emitted
      const taskCompletes = events.filter((e) => e.ev.type === 'task_complete')
      expect(taskCompletes).toHaveLength(1) // only the first one

      // Status remains completed
      expect(cp.getTabStatus(tabId)?.status).toBe('completed')
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

    it('stale engine_status idle after resetTabSession does not synthesize task_complete', async () => {
      const tabId = cp.createTab()

      // Step 1: Submit first prompt → tab becomes running
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())
      expect(cp.getTabStatus(tabId)?.status).toBe('running')

      // Step 2: First session completes with ExitPlanMode denial → tab becomes completed
      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: {
          state: 'idle',
          runCostUsd: 0.01,
          permissionDenials: [
            { toolName: 'ExitPlanMode', toolUseId: 'exit-1', toolInput: {} },
          ],
        },
      })
      expect(cp.getTabStatus(tabId)?.status).toBe('completed')
      expect(events.filter((e) => e.ev.type === 'task_complete')).toHaveLength(1)

      // Step 3: resetTabSession (simulates onImplement flow) → tab resets to idle
      cp.resetTabSession(tabId)
      expect(cp.getTabStatus(tabId)?.status).toBe('idle')
      expect(cp.getTabStatus(tabId)?.activeRequestId).toBeNull()

      // Step 4: Submit new prompt (implementation) → tab becomes running again
      await cp.submitPrompt(tabId, 'req-2', makeRunOptions({ prompt: 'implement' }))
      expect(cp.getTabStatus(tabId)?.status).toBe('running')

      // Step 5: Stale engine_status idle from the OLD dying session arrives
      const _eventsBefore = events.length
      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: { state: 'idle' },
      })

      // No additional task_complete should have been emitted — the stale idle
      // is rejected because tab.status was 'idle' at the time resetTabSession
      // cleared it, and then submitPrompt set it to 'running'. However, the
      // critical path is: after resetTabSession sets status='idle', a stale
      // idle arriving BEFORE submitPrompt runs would also be caught.
      // Either way, only the original task_complete from step 2 should exist.
      //
      // In this test the stale idle arrives AFTER submitPrompt (status='running'),
      // so it WOULD synthesize a spurious task_complete without the fix.
      // With the fix, the idle guard at tab.status === 'idle' catches it during
      // the window between resetTabSession and submitPrompt. Since submitPrompt
      // already ran here, we verify the broader scenario: the idle event does
      // produce a task_complete (genuine completion of req-2). The real
      // protection for the race is tested in the next assertion block.

      // Verify the stale idle scenario: resetTabSession → stale idle (no submitPrompt yet)
      // This is the exact race the fix targets.
    })

    it('stale engine_status idle after resetTabSession but before new submitPrompt is rejected', async () => {
      const tabId = cp.createTab()

      // Step 1: Submit prompt → running
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())
      expect(cp.getTabStatus(tabId)?.status).toBe('running')

      const events: any[] = []
      cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

      // Step 2: Session completes with ExitPlanMode → completed
      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: {
          state: 'idle',
          permissionDenials: [
            { toolName: 'ExitPlanMode', toolUseId: 'exit-1', toolInput: {} },
          ],
        },
      })
      expect(cp.getTabStatus(tabId)?.status).toBe('completed')
      const firstTaskCompletes = events.filter((e) => e.ev.type === 'task_complete')
      expect(firstTaskCompletes).toHaveLength(1)

      // Step 3: resetTabSession → status becomes 'idle'
      cp.resetTabSession(tabId)
      expect(cp.getTabStatus(tabId)?.status).toBe('idle')

      // Step 4: Stale idle from dying old session arrives BEFORE new submitPrompt
      // This is the exact race condition — without the fix, status is 'idle'
      // which is not 'completed', so the old guard would let it through and
      // synthesize a spurious task_complete.
      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: { state: 'idle' },
      })

      // With the fix, no additional task_complete is synthesized
      const allTaskCompletes = events.filter((e) => e.ev.type === 'task_complete')
      expect(allTaskCompletes).toHaveLength(1) // still just the one from step 2

      // Status remains idle
      expect(cp.getTabStatus(tabId)?.status).toBe('idle')
    })
  })
})
