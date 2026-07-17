/**
 * EngineControlPlane — stale denial suppression during connecting state.
 *
 * When the user clicks Implement or sends feedback, submitPrompt sets
 * TabEntry.status to 'connecting'. A heartbeat engine_status(idle + stale
 * denials) arriving in this window must NOT synthesize a task_complete —
 * the denials are stale leftovers that the engine hasn't cleared yet
 * (prompt_dispatch hasn't run).
 *
 * Extracted from engine-control-plane.test.ts to stay within the 600-line
 * TypeScript file-size cap.
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
    if (event === 'event') capturedEventHandler = handler
  }),
  emit: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
}

vi.mock('../engine-bridge', () => ({
  EngineBridge: function () { return mockBridge },
  IS_REMOTE: false,
  REMOTE_SOCKET: '',
}))

vi.mock('../engine-bridge-fs', () => ({
  engineIsRemote: vi.fn(() => false),
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: false, error: 'unused' })),
  listEngineDirectory: vi.fn(() => Promise.resolve({ ok: false, error: 'unused' })),
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
  return { ...actual, randomUUID: vi.fn(() => `tab-${String(++uuidCounter).padStart(3, '0')}`) }
})

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'

function makeRunOptions(overrides: Record<string, any> = {}): any {
  return { prompt: 'hello', projectPath: '/Users/test/project', sessionId: undefined, model: undefined, ...overrides }
}

describe('EngineControlPlane — stale denial guard (connecting)', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    capturedEventHandler = null
    uuidCounter = 0
    mockBridge.startSession.mockResolvedValue({ ok: true })
    mockBridge.sendPrompt.mockResolvedValue({ ok: true })
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('skips task_complete synthesis when tab is connecting and stale idle+denials arrives', async () => {
    const tabId = cp.createTab()
    await cp.submitPrompt(tabId, 'req-1', makeRunOptions())

    const events: any[] = []
    cp.on('event', (tid: string, ev: any) => events.push({ tid, ev }))

    // Session completes with ExitPlanMode → completed
    capturedEventHandler!(tabId, {
      type: 'engine_status',
      fields: { state: 'idle', permissionDenials: [{ toolName: 'ExitPlanMode', toolUseId: 'exit-1', toolInput: {} }] },
    })
    expect(cp.getTabStatus(tabId)?.status).toBe('completed')
    expect(events.filter((e) => e.ev.type === 'task_complete')).toHaveLength(1)

    // User clicks Implement → submitPrompt → connecting
    await cp.submitPrompt(tabId, 'req-2', makeRunOptions({ prompt: 'Implement the plan' }))
    // Force status to 'connecting' to simulate the race window before engine confirms running.
    ;(cp.getTabStatus(tabId)! as any).status = 'connecting'

    // Stale heartbeat arrives with old ExitPlanMode denial
    capturedEventHandler!(tabId, {
      type: 'engine_status',
      fields: { state: 'idle', permissionDenials: [{ toolName: 'ExitPlanMode', toolUseId: 'exit-1', toolInput: {} }] },
    })

    // No additional task_complete — the connecting guard rejects stale denials.
    expect(events.filter((e) => e.ev.type === 'task_complete')).toHaveLength(1)
  })
})
