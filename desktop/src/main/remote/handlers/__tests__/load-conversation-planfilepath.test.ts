/**
 * Regression tests for plan-marker handling in the engine-sourced
 * handleLoadConversation.
 *
 * 1. A persisted plan-marker row (engine `markerKind: 'plan'` on
 *    load_session_history) maps to a system divider whose planFilePath
 *    survives to the wire — so plan-lifecycle dividers stay clickable on iOS
 *    after a history reload.
 * 2. ExitPlanMode enrichment resolves the fallback plan path from the loaded
 *    engine rows themselves (the most recent plan-file Write), replacing the
 *    old renderer-scrape IIFE.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

const sent: Array<{ deviceId: string | undefined; event: any }> = []
const sendToDeviceMock = vi.fn((deviceId: string, event: any) => { sent.push({ deviceId, event }) })
const sendMock = vi.fn((event: any) => { sent.push({ deviceId: undefined, event }) })
const executeJsMock = vi.fn()
const loadChainHistoryMock = vi.fn()

vi.mock('../../../state', () => ({
  state: {
    get mainWindow() {
      return { webContents: { executeJavaScript: executeJsMock } }
    },
    get remoteTransport() {
      return { sendToDevice: sendToDeviceMock, send: sendMock }
    },
  },
  sessionPlane: {},
  engineBridge: { loadChainHistory: (ids: string[]) => loadChainHistoryMock(ids) },
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
}))

vi.mock('../../../logger', () => ({ log: vi.fn() }))
vi.mock('../../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../../terminal-manager-instance', () => ({ terminalManager: {} }))
vi.mock('../../../settings-store', () => ({
  readSettings: vi.fn(() => ({})),
  readClaudeCompat: vi.fn(() => false),
  TABS_FILE: '/tmp/ion-planfilepath-test/tabs.json',
}))
vi.mock('../../snapshot', () => ({ getRemoteTabStates: vi.fn(async () => []) }))
vi.mock('./diagnostics', () => ({ autoPullDiagnosticLogs: vi.fn() }))
vi.mock('./tabs-sync', () => ({ broadcastSync: vi.fn(), sendSync: vi.fn() }))
vi.mock('../../../ipc-validation', () => ({ resolveDiscoveryWorkingDir: vi.fn() }))
vi.mock('./tabs-prompt', () => ({ handlePrompt: vi.fn(), handleCancel: vi.fn() }))

import { handleLoadConversation } from '../tabs'

function tabMeta() {
  return { conversationId: 'conv-plan', historicalSessionIds: [], status: 'idle' }
}

describe('handleLoadConversation — plan-marker and enrichment', () => {
  beforeEach(() => {
    sent.length = 0
    sendToDeviceMock.mockClear()
    sendMock.mockClear()
    executeJsMock.mockReset()
    loadChainHistoryMock.mockReset()
  })

  it('maps an engine plan-marker row to a divider with planFilePath on the wire', async () => {
    executeJsMock.mockResolvedValueOnce(tabMeta())
    loadChainHistoryMock.mockResolvedValueOnce([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1 },
      {
        id: 'p1', role: 'system', content: '──', timestamp: 2,
        markerKind: 'plan', markerPlanOperation: 'created',
        markerPlanFilePath: '/test/plan.md', markerPlanSlug: 'plan',
      },
    ])

    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-plan' }, 'dev-2')

    const hist = sent.find((s) => s.event.type === 'desktop_conversation_history')!
    const divider = hist.event.messages.find((m: any) => m.role === 'system')
    expect(divider).toBeTruthy()
    expect(divider.planFilePath).toBe('/test/plan.md')
    expect(divider.content).toContain('Plan created')
    // Canonical engine row id preserved on the wire.
    expect(divider.id).toBe('p1')
  })

  it('enriches ExitPlanMode with planContent resolved from the loaded rows', async () => {
    const dir = join(tmpdir(), `ion-planpath-${Date.now()}`)
    mkdirSync(join(dir, '.ion', 'plans'), { recursive: true })
    const planPath = join(dir, '.ion', 'plans', 'my-plan.md')
    writeFileSync(planPath, '# The Plan\ndo things')

    try {
      executeJsMock.mockResolvedValueOnce(tabMeta())
      loadChainHistoryMock.mockResolvedValueOnce([
        { id: 'u1', role: 'user', content: 'plan it', timestamp: 1 },
        {
          id: 'w1', role: 'tool', content: 'ok', toolName: 'Write', toolId: 'toolu_w',
          toolInput: JSON.stringify({ file_path: planPath, content: '# The Plan' }), timestamp: 2,
        },
        {
          id: 'x1', role: 'tool', content: '', toolName: 'ExitPlanMode', toolId: 'toolu_x',
          toolInput: JSON.stringify({}), timestamp: 3,
        },
      ])

      await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-enrich' }, 'dev-3')

      const hist = sent.find((s) => s.event.type === 'desktop_conversation_history')!
      const exitRow = hist.event.messages.find((m: any) => m.toolName === 'ExitPlanMode')
      expect(exitRow).toBeTruthy()
      const input = JSON.parse(exitRow.toolInput)
      expect(input.planFilePath).toBe(planPath)
      expect(input.planContent).toContain('# The Plan')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
