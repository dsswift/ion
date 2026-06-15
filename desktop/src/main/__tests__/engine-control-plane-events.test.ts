/**
 * engine-control-plane-events — handleStatusEvent conversation-id guard tests
 *
 * These tests pin the B1 fix for issue #230: a post-restart pre-mint idle
 * event must NOT clobber an already-tracked conversationId.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { handleEngineEvent } from '../engine-control-plane-events'
import type { TabEntry, EventEmitterContext } from '../engine-control-plane-events'
import type { EngineEvent } from '../../shared/types'

function makeTab(overrides: Partial<TabEntry> = {}): TabEntry {
  return {
    tabId: 'tab-001',
    status: 'running',
    activeRequestId: null,
    conversationId: null,
    engineSessionStarted: true,
    lastActivityAt: Date.now(),
    promptCount: 0,
    promptCountSinceCheckpoint: 0,
    clearedSinceLastPrompt: false,
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: Date.now() - 1000,
    toolCallCount: 0,
    sawPermissionRequest: false,
    ...overrides,
  }
}

function makeIdleEvent(sessionId: string): EngineEvent {
  return {
    type: 'engine_status',
    fields: {
      state: 'idle',
      sessionId,
      label: 'tab-001',
      totalCostUsd: 0,
    },
  } as EngineEvent
}

describe('handleStatusEvent — conversationId guard (issue #230 B1)', () => {
  let mockBridge: any
  let ctx: EventEmitterContext
  let emitted: Array<[string, ...unknown[]]>

  beforeEach(() => {
    emitted = []
    mockBridge = {
      updateSessionConversationId: vi.fn(),
      startSession: vi.fn().mockResolvedValue({ ok: true }),
      getSessionConfig: vi.fn().mockReturnValue(undefined),
    }
    ctx = {
      bridge: mockBridge as any,
      emit: (eventName: string, ...args: unknown[]) => { emitted.push([eventName, ...args]) },
      setStatus: vi.fn(),
      checkDrain: vi.fn(),
    }
  })

  it('adopts engine sessionId when tab has no conversationId (first bind)', () => {
    const tab = makeTab({ conversationId: null, status: 'running' })
    const event = makeIdleEvent('new-conv-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(tab.conversationId).toBe('new-conv-id')
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'new-conv-id')
    expect(mockBridge.startSession).not.toHaveBeenCalled()
  })

  it('no-op when engine sessionId matches tracked conversationId (heartbeat)', () => {
    const tab = makeTab({ conversationId: 'existing-conv-id', status: 'running' })
    const event = makeIdleEvent('existing-conv-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(tab.conversationId).toBe('existing-conv-id') // unchanged
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'existing-conv-id')
    expect(mockBridge.startSession).not.toHaveBeenCalled()
  })

  it('drives resume when engine sessionId diverges from tracked conversationId (post-restart pre-mint)', () => {
    const tab = makeTab({ conversationId: 'original-conv-id', status: 'running' })
    const event = makeIdleEvent('new-premint-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    // Must NOT overwrite the tracked id.
    expect(tab.conversationId).toBe('original-conv-id')
    // Must drive a resume with the original id.
    expect(mockBridge.startSession).toHaveBeenCalledWith('tab-001', expect.objectContaining({
      sessionId: 'original-conv-id',
    }))
    // updateSessionConversationId is called with the ORIGINAL id, not the pre-mint.
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'original-conv-id')
  })

  it('divergence resume carries the tab real config, not empty placeholders (issue #231 Gap 2)', () => {
    // The bridge holds the last config used to start this session: a real
    // working directory, extensions, and model. The divergence resume must
    // reuse it (overriding only sessionId), not start a degraded empty session.
    mockBridge.getSessionConfig = vi.fn().mockReturnValue({
      profileId: 'default',
      extensions: ['ext-a', 'ext-b'],
      workingDirectory: '/work/project',
      model: 'claude-opus-4-8',
    })
    const tab = makeTab({ conversationId: 'original-conv-id', status: 'running' })
    const event = makeIdleEvent('new-premint-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(mockBridge.getSessionConfig).toHaveBeenCalledWith('tab-001')
    expect(mockBridge.startSession).toHaveBeenCalledWith('tab-001', expect.objectContaining({
      sessionId: 'original-conv-id',
      workingDirectory: '/work/project',
      extensions: ['ext-a', 'ext-b'],
      model: 'claude-opus-4-8',
      forceNewConversation: false,
    }))
  })

  it('divergence resume falls back to a minimal config when the bridge has no record', () => {
    // getSessionConfig returns undefined (default mock): the resume still
    // happens with the original id so the conversation is restored.
    const tab = makeTab({ conversationId: 'original-conv-id', status: 'running' })
    const event = makeIdleEvent('new-premint-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(mockBridge.startSession).toHaveBeenCalledWith('tab-001', expect.objectContaining({
      sessionId: 'original-conv-id',
    }))
  })
})
