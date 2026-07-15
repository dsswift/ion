// Bug #2 regression tests — proposal-bearing idle must reach the renderer.
//
// Extracted from engine-control-plane-events.test.ts to keep that file under
// the 600-line cap. These pin the control-plane fix where an auto-dispatched
// run that flips to plan mid-run lands its ExitPlanMode denial on an idle that
// arrives while the tab is already 'completed'/'idle' from a heartbeat. The old
// guard skipped ALL idles on a settled tab, dropping the only Plan Ready card
// trigger. The fix exempts proposal-bearing idles (ExitPlanMode /
// AskUserQuestion) from the duplicate-skip guard, with a once-per-proposal
// dedup so a heartbeat echo does not resurrect a dismissed card.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Electron is not installed in CI (npm ci --ignore-scripts skips the binary
// download). Any module in the transitive import chain that does
// `import ... from 'electron'` at the top level will throw at load time
// without this stub. This test runs headless main-process logic only; no
// real Electron APIs are exercised.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../session-meta', () => ({
  conversationExists: vi.fn().mockReturnValue(true),
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
    resumedSavedConversation: false,
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: Date.now() - 1000,
    toolCallCount: 0,
    sawPermissionRequest: false,
    lastSurfacedProposalSig: null,
    ...overrides,
  }
}

function makeIdleEvent(sessionId: string): EngineEvent {
  return {
    type: 'engine_status',
    fields: { state: 'idle', sessionId, label: 'tab-001', runCostUsd: 0 },
  } as EngineEvent
}

function makeProposalIdleEvent(
  sessionId: string,
  toolName: 'ExitPlanMode' | 'AskUserQuestion' = 'ExitPlanMode',
  planFilePath = '/Users/josh/.ion/plans/minty-dancing-apple.md',
): EngineEvent {
  return {
    type: 'engine_status',
    fields: {
      state: 'idle',
      sessionId,
      label: 'tab-001',
      model: 'claude-opus-4-8',
      contextPercent: 0,
      contextWindow: 0,
      runCostUsd: 0.18,
      permissionDenials: [
        { toolName, toolUseId: 'toolu_exit_1', toolInput: { planFilePath } },
      ],
    },
  } as EngineEvent
}

function makeRunningEvent(sessionId: string): EngineEvent {
  return {
    type: 'engine_status',
    fields: {
      state: 'running',
      sessionId,
      label: 'tab-001',
      model: 'claude-opus-4-8',
      contextPercent: 0,
      contextWindow: 0,
    },
  } as EngineEvent
}

describe('handleStatusEvent — proposal-bearing idle (Bug #2)', () => {
  let emitted: Array<{ name: string; args: unknown[] }>
  let setStatusCalls: Array<[string, string]>
  let ctx: EventEmitterContext

  beforeEach(() => {
    emitted = []
    setStatusCalls = []
    ctx = {
      bridge: {
        updateSessionConversationId: vi.fn(),
        startSession: vi.fn().mockResolvedValue({ ok: true }),
        getSessionConfig: vi.fn().mockReturnValue(undefined),
      } as any,
      emit: (eventName: string, ...args: unknown[]) => { emitted.push({ name: eventName, args }) },
      setStatus: (tabId: string, newStatus: string) => { setStatusCalls.push([tabId, newStatus]) },
      checkDrain: vi.fn(),
    }
  })

  it('proposal-bearing idle on a completed tab is FORWARDED (card trigger, not dropped)', () => {
    // RED before fix: the unconditional `completed` skip swallowed this idle.
    const tab = makeTab({ status: 'completed', activeRequestId: null, startedAt: 0, lastSurfacedProposalSig: null })
    handleEngineEvent(ctx, 'tab-001', tab, makeProposalIdleEvent('conv-plan'))

    const taskComplete = emitted.find(
      (e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete',
    )
    expect(taskComplete).toBeDefined()
    expect((taskComplete!.args[1] as any).permissionDenials[0].toolName).toBe('ExitPlanMode')
    // The signature is recorded so subsequent echoes dedup.
    expect(tab.lastSurfacedProposalSig).not.toBeNull()
  })

  it('repeated identical proposal idle (heartbeat echo) is surfaced ONCE, not resurrected', () => {
    // The engine re-publishes retained denials on every heartbeat. After the
    // first surface, an identical echo must be skipped so a dismissed card is
    // not resurrected.
    const tab = makeTab({ status: 'completed', activeRequestId: null, startedAt: 0, lastSurfacedProposalSig: null })
    handleEngineEvent(ctx, 'tab-001', tab, makeProposalIdleEvent('conv-plan'))
    expect(
      emitted.filter((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete').length,
    ).toBe(1)

    // Simulate a heartbeat echo of the SAME denial.
    handleEngineEvent(ctx, 'tab-001', tab, makeProposalIdleEvent('conv-plan'))
    expect(
      emitted.filter((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete').length,
    ).toBe(1)
  })

  it('a NEW proposal after new work (running resets the dedup) re-surfaces', () => {
    const tab = makeTab({ status: 'completed', activeRequestId: null, startedAt: 0, lastSurfacedProposalSig: null })
    handleEngineEvent(ctx, 'tab-001', tab, makeProposalIdleEvent('conv-plan', 'ExitPlanMode', '/plans/a.md'))
    expect(
      emitted.filter((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete').length,
    ).toBe(1)

    // A real run starts (clears the dedup), then a new proposal with a
    // different plan path arrives.
    handleEngineEvent(ctx, 'tab-001', tab, makeRunningEvent('conv-plan'))
    expect(tab.lastSurfacedProposalSig).toBeNull()
    tab.status = 'completed'
    handleEngineEvent(ctx, 'tab-001', tab, makeProposalIdleEvent('conv-plan', 'ExitPlanMode', '/plans/b.md'))
    expect(
      emitted.filter((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete').length,
    ).toBe(2)
  })

  it('proposal-bearing idle on a CONNECTING tab is still suppressed (new run in flight — stale)', () => {
    // The Implement flow dispatches a new prompt → tab goes connecting. A denial
    // echoed in that window is stale and must not resurrect a dismissed card.
    const tab = makeTab({ status: 'connecting', activeRequestId: 'req-new', startedAt: Date.now(), lastSurfacedProposalSig: null })
    handleEngineEvent(ctx, 'tab-001', tab, makeProposalIdleEvent('conv-plan'))

    expect(
      emitted.find((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete'),
    ).toBeUndefined()
  })

  it('non-proposal heartbeat idle on a completed tab is still suppressed (unchanged)', () => {
    // Regression guard: the no-denial cost-only heartbeat must STILL skip.
    const tab = makeTab({ status: 'completed', activeRequestId: null, startedAt: 0, lastSurfacedProposalSig: null })
    handleEngineEvent(ctx, 'tab-001', tab, makeIdleEvent('conv-done'))

    expect(
      emitted.find((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete'),
    ).toBeUndefined()
  })
})
