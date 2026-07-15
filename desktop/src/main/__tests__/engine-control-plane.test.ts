/**
 * EngineControlPlane Tests
 *
 * Validates session lifecycle and prompt routing. Engine event handling
 * lives in the sibling engine-control-plane-engine-events.test.ts.
 * Covers three shipped bugs: engine_dead exit code 0 treated as error,
 * conversationId never set, sessionId not passed through EngineConfig.
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

// The divergence guard probes conversationExists to distinguish a real tracked
// conversation (drive resume) from a phantom (adopt the engine id). These
// lifecycle tests assert the resume path, so the tracked id is a real
// conversation — stub conversationExists to true. Phantom behavior is covered
// in engine-control-plane-events.test.ts.
vi.mock('../session-meta', () => ({
  conversationExists: vi.fn(() => true),
}))

// Capture the event handler registered by EngineControlPlane's constructor
let capturedEventHandler: ((key: string, event: any) => void) | null = null

const mockBridge = {
  startSession: vi.fn().mockResolvedValue({ ok: true }),
  sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
  sendAbort: vi.fn(),
  sendAbortAgent: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  updateSessionConversationId: vi.fn(),
  getSessionConfig: vi.fn().mockReturnValue(undefined),
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
import { engineIsRemote, listEngineDirectory } from '../engine-bridge-fs'

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

    it('adoptTab registers under the caller-supplied id without minting', () => {
      // The restore path reuses the persisted, durable tabId so the session key
      // is invariant across restarts. adoptTab must NOT mint — it adopts the id
      // verbatim and registers it. (Revert adoptTab to call createTab → this
      // fails because the returned id would be a minted `tab-NNN`, not the
      // persisted id, which is the restart-fragmentation defect.)
      const persistedId = 'persisted-tab-abc123'
      const adopted = cp.adoptTab(persistedId)

      expect(adopted).toBe(persistedId)
      expect(cp.hasTab(persistedId)).toBe(true)
      // A subsequent createTab still starts the mint sequence at 001 — adoptTab
      // did not consume a minted id.
      expect(cp.createTab()).toBe('tab-001')
    })

    it('adoptTab is idempotent — re-adopting preserves the existing entry', () => {
      const persistedId = 'persisted-tab-xyz789'
      const first = cp.adoptTab(persistedId)
      // Simulate a double-restore race: adopt the same id again.
      const second = cp.adoptTab(persistedId)

      expect(first).toBe(persistedId)
      expect(second).toBe(persistedId)
      expect(cp.hasTab(persistedId)).toBe(true)
    })
  })

  describe('cancelTab — unified interrupt (abort + subtree reap)', () => {
    // Regression guard for the iOS interrupt-parity fix: a remote cancel must
    // behave like the desktop renderer's `interrupt` — abort the parent run AND
    // reap the dispatched-agent subtree. Before the fix cancelTab only called
    // sendAbort, leaving background agents running when iOS sent desktop_cancel.
    it('aborts the run AND reaps the dispatched-agent subtree for a tracked tab', () => {
      const tabId = cp.createTab()

      const ok = cp.cancelTab(tabId)

      expect(ok).toBe(true)
      expect(mockBridge.sendAbort).toHaveBeenCalledWith(tabId)
      // Empty agentName + subtree=true reaps every descendant; the engine
      // no-ops safely when there are no children. Removing the reap line in
      // cancelTab makes this assertion fail — that is the regression guard.
      expect(mockBridge.sendAbortAgent).toHaveBeenCalledWith(tabId, '', true)
    })

    it('returns false and sends nothing for an untracked tab', () => {
      const ok = cp.cancelTab('nonexistent-tab')

      expect(ok).toBe(false)
      expect(mockBridge.sendAbort).not.toHaveBeenCalled()
      expect(mockBridge.sendAbortAgent).not.toHaveBeenCalled()
    })
  })

  describe('notifyConversationCleared', () => {
    // Regression: the slash-command plan→auto guard (slash-classify.ts
    // isFirstPromptForTab) needs a way to recognise that /clear has restored
    // "fresh blank session" status. The engine keeps s.conversationID set
    // after /clear (it's a checkpoint, not a session restart), so dropping
    // tab.conversationId here is wrong — but we DO need to advance the
    // checkpoint counter the guard consults.

    it('zeros promptCountSinceCheckpoint and sets clearedSinceLastPrompt while preserving promptCount and conversationId', async () => {
      const tabId = cp.createTab()
      // Submit a prompt to bump promptCount and promptCountSinceCheckpoint to 1.
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions({ prompt: 'hello' }))
      const beforeStatus = cp.getTabStatus(tabId)!
      expect(beforeStatus.promptCount).toBe(1)
      expect(beforeStatus.promptCountSinceCheckpoint).toBe(1)
      expect(beforeStatus.clearedSinceLastPrompt).toBe(false)
      // Simulate the engine populating conversationId via engine_status
      beforeStatus.conversationId = 'conv-checkpoint-test'

      cp.notifyConversationCleared(tabId)

      const afterStatus = cp.getTabStatus(tabId)!
      // Checkpoint counter reset → next slash command is treated as first.
      expect(afterStatus.promptCountSinceCheckpoint).toBe(0)
      // Flag set → isFirstPromptForTab returns true even if renderer sends
      // a stale runOptions.sessionId.
      expect(afterStatus.clearedSinceLastPrompt).toBe(true)
      // Lifetime counter and conversationId preserved — /clear is a
      // checkpoint, not a session restart.
      expect(afterStatus.promptCount).toBe(1)
      expect(afterStatus.conversationId).toBe('conv-checkpoint-test')
      // No engine session was stopped (unlike resetTabSession).
      expect(mockBridge.stopSession).not.toHaveBeenCalled()
    })

    it('is a no-op when the tab does not exist', () => {
      // Should not throw — guard the unknown-tab race gracefully.
      expect(() => cp.notifyConversationCleared('nonexistent-tab')).not.toThrow()
    })

    it('advances the checkpoint repeatedly across multiple /clear calls', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-a', makeRunOptions({ prompt: 'one' }))
      cp.notifyConversationCleared(tabId)
      expect(cp.getTabStatus(tabId)!.promptCountSinceCheckpoint).toBe(0)
      expect(cp.getTabStatus(tabId)!.promptCount).toBe(1)
      expect(cp.getTabStatus(tabId)!.clearedSinceLastPrompt).toBe(true)

      await cp.submitPrompt(tabId, 'req-b', makeRunOptions({ prompt: 'two' }))
      // submitPrompt clears the flag.
      expect(cp.getTabStatus(tabId)!.clearedSinceLastPrompt).toBe(false)
      await cp.submitPrompt(tabId, 'req-c', makeRunOptions({ prompt: 'three' }))
      expect(cp.getTabStatus(tabId)!.promptCountSinceCheckpoint).toBe(2)
      expect(cp.getTabStatus(tabId)!.promptCount).toBe(3)

      cp.notifyConversationCleared(tabId)
      expect(cp.getTabStatus(tabId)!.promptCountSinceCheckpoint).toBe(0)
      expect(cp.getTabStatus(tabId)!.promptCount).toBe(3)
      expect(cp.getTabStatus(tabId)!.clearedSinceLastPrompt).toBe(true)
    })
  })

  describe('restartTabSession vs resetTabSession — recovery is non-destructive', () => {
    // The session-cut taxonomy: restartTabSession is a same-session power-cycle
    // (PRESERVE conversationId) used by stuck-tab recovery; resetTabSession is
    // the destructive cut (NULL conversationId) reserved for Implement-plan
    // clear-context. Conflating them fragmented conversations on a simple
    // recovery. These pin the distinction.
    it('restartTabSession preserves conversationId and stops the session', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions({ prompt: 'hello' }))
      // Bind a conversationId as a live session would.
      cp.getTabStatus(tabId)! // ensure tab exists
      ;(cp as any).tabs.get(tabId).conversationId = 'conv-restart-test'

      cp.restartTabSession(tabId)

      const after = cp.getTabStatus(tabId)!
      // The conversation MUST survive — recovery resumes the same id.
      expect(after.conversationId).toBe('conv-restart-test')
      // The transport is recycled and run state reset so the next prompt re-starts.
      expect(after.engineSessionStarted).toBe(false)
      expect(after.activeRequestId).toBeNull()
      expect(after.status).toBe('idle')
      expect(mockBridge.stopSession).toHaveBeenCalledWith(tabId)
    })

    it('resetTabSession nulls conversationId (destructive cut, Implement-plan only)', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-2', makeRunOptions({ prompt: 'hello' }))
      ;(cp as any).tabs.get(tabId).conversationId = 'conv-reset-test'

      cp.resetTabSession(tabId)

      const after = cp.getTabStatus(tabId)!
      // The destructive cut drops the conversation — next prompt mints fresh.
      expect(after.conversationId).toBeNull()
      expect(after.engineSessionStarted).toBe(false)
      expect(mockBridge.stopSession).toHaveBeenCalledWith(tabId)
    })

    it('restartTabSession is a no-op for an unknown tab', () => {
      expect(() => cp.restartTabSession('nonexistent-tab')).not.toThrow()
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
      // only cares about the first two positional args. The remaining ten
      // trailing optionals (model, appendSystemPrompt, imageAttachments,
      // implementationPhase, enterPlanModeDescription, planModeSparseReminder,
      // planFilePath, bashAllowlistAdditionsForThisPrompt, thinkingEffort,
      // resolveSlash) are all undefined for a plain prompt.
      expect(mockBridge.sendPrompt).toHaveBeenCalledWith(tabId, 'hi', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined)
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
      expect(mockBridge.sendPrompt).toHaveBeenLastCalledWith(tabId, 'second', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined)
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

    it('passes appendSystemPrompt through to sendPrompt', async () => {
      const tabId = cp.createTab()
      await cp.submitPrompt(
        tabId,
        'req-1',
        makeRunOptions({
          prompt: '/spec-issue expanded args',
          appendSystemPrompt: 'Analyze the GitHub issue and create a spec.',
        }),
      )

      expect(mockBridge.sendPrompt).toHaveBeenCalledWith(
        tabId,
        '/spec-issue expanded args',
        undefined,
        'Analyze the GitHub issue and create a spec.',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      )
    })
  })

  describe('remote directory validation', () => {
    it('rejects unreachable remote working directory', async () => {
      vi.mocked(engineIsRemote).mockReturnValue(true)
      vi.mocked(listEngineDirectory).mockResolvedValue({ ok: false, error: 'not found' })

      const tabId = cp.createTab()
      const errors: any[] = []
      cp.on('error', (_tid: string, err: any) => errors.push(err))

      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      expect(mockBridge.startSession).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('does not exist on the engine host')
    })

    it('proceeds when remote working directory is reachable', async () => {
      vi.mocked(engineIsRemote).mockReturnValue(true)
      vi.mocked(listEngineDirectory).mockResolvedValue({
        ok: true,
        data: { path: '/home/user', entries: [], truncated: false, parent: '/home' },
      })

      const tabId = cp.createTab()
      await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

      expect(mockBridge.startSession).toHaveBeenCalledOnce()
    })
  })
  describe('reconnect — conversationId preservation (issue #230 B1/B2)', () => {
    it('preserves conversationId when resetting engineSessionStarted on reconnect', () => {
      const tabId = cp.createTab()
      const tab = cp.getTabStatus(tabId)!
      // Simulate a tab that has a tracked conversationId and a started session.
      tab.conversationId = 'original-conv-id'
      tab.engineSessionStarted = true

      // Find the 'reconnected' handler registered in the constructor.
      const reconnectCall = mockBridge.on.mock.calls.find(
        (call: any[]) => call[0] === 'reconnected',
      )
      expect(reconnectCall).toBeDefined()
      const reconnectHandler = reconnectCall![1]
      reconnectHandler()

      // engineSessionStarted must be reset so the re-register fires.
      expect(tab.engineSessionStarted).toBe(false)
      // conversationId must be preserved, not cleared.
      expect(tab.conversationId).toBe('original-conv-id')
    })
  })

  describe('seedConversationId — arms the divergence guard (restart data-loss fix)', () => {
    // Layer 2 of the "agent starts fresh after restart" fix. The extension
    // restore path starts the engine via the ENGINE_START IPC (which calls
    // seedConversationId before engineBridge.startSession). Seeding the real id
    // BEFORE the engine emits its first idle status ensures the divergence guard
    // in handleStatusEvent rejects a post-restart pre-mint instead of adopting it.

    it('seeds a previously-untracked TabEntry conversationId', () => {
      const tabId = cp.createTab()
      expect(cp.getTabStatus(tabId)!.conversationId).toBeNull()

      cp.seedConversationId(tabId, 'real-conv-id')

      expect(cp.getTabStatus(tabId)!.conversationId).toBe('real-conv-id')
    })

    it('is a no-op when the tab already tracks a conversationId (never clobbers)', () => {
      const tabId = cp.createTab()
      cp.seedConversationId(tabId, 'first-id')
      cp.seedConversationId(tabId, 'second-id')
      expect(cp.getTabStatus(tabId)!.conversationId).toBe('first-id')
    })

    it('ignores an empty conversationId', () => {
      const tabId = cp.createTab()
      cp.seedConversationId(tabId, '')
      expect(cp.getTabStatus(tabId)!.conversationId).toBeNull()
    })

    it('creates the tab if it does not exist yet (ensureTab)', () => {
      cp.seedConversationId('tab-restore-x', 'recovered-id')
      expect(cp.getTabStatus('tab-restore-x')!.conversationId).toBe('recovered-id')
    })

    it('marks the tab resumedSavedConversation=true (caller-supplied id is a resume, not a mint)', () => {
      // Scenario B: a caller-supplied id on restore means we are resuming a
      // SAVED conversation. The slash plan→auto freshness guard must treat the
      // next prompt as resumed, so this flag must be set. A brand-new session
      // whose engine-minted id is captured at start (scenario C) leaves it
      // false — that distinction is what stopped /align running in plan mode.
      const tabId = cp.createTab()
      expect(cp.getTabStatus(tabId)!.resumedSavedConversation).toBe(false)
      cp.seedConversationId(tabId, 'restored-id')
      expect(cp.getTabStatus(tabId)!.resumedSavedConversation).toBe(true)
    })

    it('seeded id drives a divergence resume on a post-restart pre-mint idle', () => {
      // The full Layer-2 contract: seed the real id, then deliver a diverging
      // idle (the empty pre-minted id). The guard must NOT adopt the pre-mint;
      // it must drive a resume with the seeded original id.
      const tabId = cp.createTab()
      cp.seedConversationId(tabId, 'original-conv-id')

      expect(capturedEventHandler).toBeTruthy()
      capturedEventHandler!(tabId, {
        type: 'engine_status',
        fields: { state: 'idle', sessionId: 'premint-empty-id', label: tabId, runCostUsd: 0 },
      })

      // Tracked id is preserved, not clobbered by the pre-mint.
      expect(cp.getTabStatus(tabId)!.conversationId).toBe('original-conv-id')
      // A resume is driven with the original id.
      expect(mockBridge.startSession).toHaveBeenCalledWith(
        tabId,
        expect.objectContaining({ sessionId: 'original-conv-id' }),
      )
    })
  })
})
