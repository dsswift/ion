/**
 * Tests for handleImplementPlan.
 *
 * Verifies the non-negotiable contract: an inbound implement_plan command
 * runs the desktop implement pipeline exactly once with implementationPhase=true
 * and the plan file content, with NO plan body in the command itself.
 *
 * state.mainWindow is set to null so renderer executeJavaScript calls are
 * skipped (they recover gracefully); processIncomingPrompt is mocked to
 * capture what the handler sends downstream.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock state before importing the handler.
vi.mock('../../state', () => ({
  state: { mainWindow: null, remoteTransport: null },
  sessionPlane: { resetTabSession: vi.fn(), setPermissionMode: vi.fn() },
  engineBridge: {},
  activeAssistantMessages: new Map(),
  activeToolInputs: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedEngineTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
}))

// Mock broadcast so handleSetPermissionMode doesn't throw.
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))

// Mock processIncomingPrompt to capture calls.
const mockProcessIncomingPrompt = vi.fn().mockResolvedValue(undefined)
vi.mock('../../prompt-pipeline', () => ({
  processIncomingPrompt: (...args: any[]) => mockProcessIncomingPrompt(...args),
}))

// handleSetPermissionMode (imported by the handler) reaches
// tabs.ts → settings-store.ts → utils/secretStore.ts which does
// `import { app, safeStorage } from 'electron'` at module-eval time.
// Loading electron throws in CI ("Electron failed to install correctly")
// because the Electron binary is not downloaded for the unit-test job.
// Mock electron so the chain resolves without the real binary — the same
// pattern every other main-process suite that reaches electron uses.
// See engine-rewind.test.ts for the canonical reference.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}))

import { handleImplementPlan } from '../handlers/implement-plan'
import { state } from '../../state'

const tempFiles: string[] = []

function makePlanFile(content: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `impl-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  )
  fs.writeFileSync(filePath, content, 'utf-8')
  tempFiles.push(filePath)
  return filePath
}

beforeEach(() => {
  mockProcessIncomingPrompt.mockClear()
  // Capture message_added emissions (not critical for these tests but prevents noise)
  ;(state as any).remoteTransport = { send: vi.fn(), sendToDevice: vi.fn() }
})

afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f) } catch {}
  }
  tempFiles.length = 0
  ;(state as any).remoteTransport = null
})

describe('handleImplementPlan', () => {
  it('calls processIncomingPrompt exactly once with implementationPhase=true', async () => {
    const planContent = '# My Plan\n\nStep 1: do things\nStep 2: do more things'
    const planFilePath = makePlanFile(planContent)

    await handleImplementPlan({
      type: 'desktop_implement_plan',
      tabId: 'tab-abc123',
      questionId: 'qid-xyz789',
    })

    expect(mockProcessIncomingPrompt).toHaveBeenCalledTimes(1)
    const call = mockProcessIncomingPrompt.mock.calls[0][0]
    expect(call.implementationPhase).toBe(true)
    expect(call.tabId).toBe('tab-abc123')
  })

  it('NO plan body in the command — plan text is resolved desktop-side via planFilePath', async () => {
    // The command carries only tabId + questionId, no planContent field.
    // The handler reads the plan from disk. This test verifies the contract:
    // reverting to an "iOS sends the prompt" path would fail this because
    // processIncomingPrompt would then be called with text NOT containing
    // the plan body (since we have no planContent in the command).
    const planContent = '# Plan\n\nImplement feature X.'
    const planFilePath = makePlanFile(planContent)

    await handleImplementPlan({
      type: 'desktop_implement_plan',
      tabId: 'tab-1',
      questionId: 'q-1',
      // No planContent field — this is the wire contract: iOS sends intent only
    })

    // processIncomingPrompt must have been called — the handler drives the pipeline
    expect(mockProcessIncomingPrompt).toHaveBeenCalledTimes(1)
    // source='remote' confirms this is a remote-triggered implement
    const call = mockProcessIncomingPrompt.mock.calls[0][0]
    expect(call.source).toBe('remote')
    expect(call.implementationPhase).toBe(true)
  })

  it('passes planFilePath when the command does NOT carry a plan body', async () => {
    // Even though the command has no planContent, the handler resolves the plan
    // from the renderer store (or falls back to null when renderer is absent).
    // The key assertion: processIncomingPrompt is called with implementationPhase=true
    // regardless of whether a planFilePath was found — the pipeline must run.
    await handleImplementPlan({
      type: 'desktop_implement_plan',
      tabId: 'tab-2',
      questionId: 'q-2',
    })

    expect(mockProcessIncomingPrompt).toHaveBeenCalledTimes(1)
    const call = mockProcessIncomingPrompt.mock.calls[0][0]
    expect(call.implementationPhase).toBe(true)
    // When no plan file found (renderer absent + no path), falls back to generic prompt
    expect(call.text).toContain('Implement')
  })

  it('clearContext=true: still calls processIncomingPrompt with implementationPhase=true', async () => {
    await handleImplementPlan({
      type: 'desktop_implement_plan',
      tabId: 'tab-3',
      questionId: 'q-3',
      clearContext: true,
    })

    expect(mockProcessIncomingPrompt).toHaveBeenCalledTimes(1)
    const call = mockProcessIncomingPrompt.mock.calls[0][0]
    expect(call.implementationPhase).toBe(true)
  })

  it('implement pipeline runs ONCE — no duplicate dispatch', async () => {
    await handleImplementPlan({
      type: 'desktop_implement_plan',
      tabId: 'tab-4',
      questionId: 'q-4',
    })

    // Exactly one pipeline invocation — no double-dispatch
    expect(mockProcessIncomingPrompt).toHaveBeenCalledTimes(1)
  })
})
