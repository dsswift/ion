/**
 * handleLoadConversation — engine-sourced history tests.
 *
 * History for iOS is served from the ENGINE (`loadChainHistory` over the
 * daemon socket) — the same source the overlay and ATV hydrate from — never
 * from a renderer message scrape or a TS reimplementation of the tree walk.
 * The renderer is consulted only for tab metadata (conversation id, session
 * chain, runtime status).
 *
 * Coverage:
 *   1. History rows come from engineBridge.loadChainHistory, mapped through
 *      the shared mapper, with engine canonical row ids preserved.
 *   2. Plain and extension-hosted tabs get identical behavior (unified path).
 *   3. Live-state push fires on runtime status 'running'/'connecting' only.
 *   4. Retired string desktop_engine_conversation_history is never sent.
 *   5. Pagination honors the `before` cursor and echoes it (`before` field) —
 *      iOS discriminates replace-vs-prepend on the echoed REQUEST cursor,
 *      never the response cursor (the heal-loop bug).
 *   6. Renderer unavailable → persisted-tabs fallback still serves history
 *      from the engine.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

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

// ── Mocks ───────────────────────────────────────────────────────────────────

const sent: Array<{ deviceId: string | undefined; event: any }> = []
const sendToDeviceMock = vi.fn((deviceId: string, event: any) => { sent.push({ deviceId, event }) })
const sendMock = vi.fn((event: any) => { sent.push({ deviceId: undefined, event }) })

const executeJsMock = vi.fn()
const loadChainHistoryMock = vi.fn()
let mainWindowAvailable = true

vi.mock('../../../state', () => ({
  state: {
    get mainWindow() {
      return mainWindowAvailable ? { webContents: { executeJavaScript: executeJsMock } } : null
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
  TABS_FILE: '/tmp/ion-parity-test/tabs.json',
}))
vi.mock('../../snapshot', () => ({ getRemoteTabStates: vi.fn(async () => []) }))
vi.mock('./diagnostics', () => ({ autoPullDiagnosticLogs: vi.fn() }))
vi.mock('./tabs-sync', () => ({ broadcastSync: vi.fn(), sendSync: vi.fn() }))
vi.mock('../../../ipc-validation', () => ({ resolveDiscoveryWorkingDir: vi.fn() }))
vi.mock('./tabs-prompt', () => ({ handlePrompt: vi.fn(), handleCancel: vi.fn() }))

// ── Helpers ─────────────────────────────────────────────────────────────────

import { handleLoadConversation } from '../tabs'

/** Renderer metadata result (the only renderer query the handler makes). */
function tabMeta(opts: { status?: string; conversationId?: string; historical?: string[] } = {}) {
  return {
    conversationId: opts.conversationId ?? 'conv-main',
    historicalSessionIds: opts.historical ?? [],
    status: opts.status ?? 'idle',
  }
}

/** Engine history rows (SessionLoadMessage shape) with canonical ids. */
function engineRows(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${String(i).padStart(3, '0')}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    timestamp: 1000 + i,
  }))
}

/** Live engine state snapshot result (for the live-state push query). */
function makeLiveStateResult() {
  return {
    instId: 'main',
    agents: [{ name: 'SubAgent', status: 'running' }],
    status: { contextPercent: 42 },
    working: 'Thinking...',
    modelOverride: null,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('handleLoadConversation — engine-sourced history', () => {
  beforeEach(() => {
    sent.length = 0
    sendToDeviceMock.mockClear()
    sendMock.mockClear()
    executeJsMock.mockReset()
    loadChainHistoryMock.mockReset()
    mainWindowAvailable = true
  })

  it('serves history from the engine with canonical row ids', async () => {
    executeJsMock.mockResolvedValueOnce(tabMeta({ historical: ['sess-old'] }))
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(3))

    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-engine' }, 'device-1')

    // The engine was asked for the full session chain, in order.
    expect(loadChainHistoryMock).toHaveBeenCalledWith(['sess-old', 'conv-main'])

    const ev = sent.find(s => s.event.type === 'desktop_conversation_history')!
    expect(ev).toBeTruthy()
    expect(ev.deviceId).toBe('device-1')
    expect(ev.event.messages.map((m: any) => m.id)).toEqual(['e000', 'e001', 'e002'])
    // No cursor and no more pages for a 3-row conversation.
    expect(ev.event.hasMore).toBe(false)
    // First-page request → echoed request cursor is null.
    expect(ev.event.before).toBeNull()
  })

  it('plain and extension-hosted tabs return the same event type and shape', async () => {
    executeJsMock.mockResolvedValueOnce(tabMeta())
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(2))
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-plain-2' }, 'device-a')
    const plainEvent = sent.find(s => s.event.tabId === 'tab-plain-2')!

    sent.length = 0
    executeJsMock.mockReset()
    loadChainHistoryMock.mockReset()

    executeJsMock.mockResolvedValueOnce(tabMeta())
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(2))
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-ext-2' }, 'device-b')
    const extEvent = sent.find(s => s.event.tabId === 'tab-ext-2')!

    expect(plainEvent.event.type).toBe('desktop_conversation_history')
    expect(extEvent.event.type).toBe('desktop_conversation_history')
    expect(Object.keys(plainEvent.event).sort()).toEqual(Object.keys(extEvent.event).sort())
  })

  it('running tab: live-state push fires', async () => {
    executeJsMock.mockResolvedValueOnce(tabMeta({ status: 'running' }))
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(2))
    // Live engine state snapshot query.
    executeJsMock.mockResolvedValueOnce(makeLiveStateResult())

    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-run' }, 'device-3')

    const agentEvents = sent.filter(s => s.event.type === 'desktop_agent_state')
    expect(agentEvents).toHaveLength(1)
    expect(agentEvents[0].event.tabId).toBe('tab-run')
  })

  it('connecting status also triggers live-state push; idle does not', async () => {
    executeJsMock.mockResolvedValueOnce(tabMeta({ status: 'connecting' }))
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(1))
    executeJsMock.mockResolvedValueOnce(makeLiveStateResult())
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-conn' }, 'device-5')
    expect(sent.filter(s => s.event.type === 'desktop_agent_state')).toHaveLength(1)

    sent.length = 0
    executeJsMock.mockReset()
    loadChainHistoryMock.mockReset()
    executeJsMock.mockResolvedValueOnce(tabMeta({ status: 'idle' }))
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(1))
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-idle' }, 'device-6')
    expect(sent.filter(s => s.event.type === 'desktop_agent_state')).toHaveLength(0)
  })

  it('never sends desktop_engine_conversation_history (retired string)', async () => {
    executeJsMock.mockResolvedValueOnce(tabMeta())
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(2))
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-guard-1' }, 'device-7')
    expect(sent.filter(s => s.event.type === 'desktop_engine_conversation_history')).toHaveLength(0)
  })

  it('pagination: honors and echoes the before cursor', async () => {
    // 30 rows; page 1 (no cursor) serves the last 10 snapped to a user turn.
    executeJsMock.mockResolvedValueOnce(tabMeta())
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(30))
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-page' }, 'device-8')
    const page1 = sent.find(s => s.event.type === 'desktop_conversation_history')!.event
    expect(page1.hasMore).toBe(true)
    expect(page1.before).toBeNull()
    expect(page1.cursor).toBe(page1.messages[0].id)

    sent.length = 0
    executeJsMock.mockReset()
    loadChainHistoryMock.mockReset()

    // Page 2: pass the cursor; rows strictly before it come back, and the
    // REQUEST cursor is echoed so iOS prepends instead of replacing.
    executeJsMock.mockResolvedValueOnce(tabMeta())
    loadChainHistoryMock.mockResolvedValueOnce(engineRows(30))
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-page', before: page1.cursor }, 'device-8')
    const page2 = sent.find(s => s.event.type === 'desktop_conversation_history')!.event
    expect(page2.before).toBe(page1.cursor)
    const page1Ids = new Set(page1.messages.map((m: any) => m.id))
    for (const m of page2.messages) {
      expect(page1Ids.has(m.id)).toBe(false)
    }
  })

  it('renderer unavailable: empty-chain response is well-formed', async () => {
    mainWindowAvailable = false
    // No persisted tabs file at the mocked path → chain resolution fails →
    // empty response (iOS retries; the engine daemon outlives the renderer,
    // so a later attempt with persisted metadata succeeds).
    await handleLoadConversation({ type: 'desktop_load_conversation', tabId: 'tab-norenderer' }, 'device-9')
    const ev = sent.find(s => s.event.type === 'desktop_conversation_history')!
    expect(ev.event.messages).toEqual([])
    expect(ev.event.hasMore).toBe(false)
    expect(ev.event.before).toBeNull()
  })
})
