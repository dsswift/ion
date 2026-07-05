/**
 * Tests for the merged remote wire handlers introduced in #256.
 *
 * Covers:
 *   - handleCreateTab: plain (no profileId) → createTabInDirectory
 *   - handleCreateTab: extension (profileId present) → createConversationTab
 *   - handlePrompt: CLI path (no instanceId) → hasExtensions=false pipeline
 *   - handlePrompt: extension path (instanceId present) → hasExtensions=true pipeline
 *   - protocol.ts: desktop_create_engine_tab and desktop_engine_prompt no
 *     longer appear as RemoteCommand type members
 *   - command-handler switch does not dispatch on old type strings
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Hoisted mock state ──────────────────────────────────────────────────────
// vi.hoisted runs before all imports and vi.mock factories.

const mocks = vi.hoisted(() => ({
  executeJsMock: vi.fn().mockResolvedValue(null),
  remoteSendMock: vi.fn(),
  processIncomingPromptMock: vi.fn().mockResolvedValue(undefined),
  readSettingsMock: vi.fn().mockReturnValue({ defaultBaseDirectory: '/home/test' }),
  getRemoteTabStatesMock: vi.fn().mockResolvedValue({ tabs: [] }),
  encodeAttachmentsMock: vi.fn().mockReturnValue({ encoded: [], rewrittenText: '' }),
  getVoiceSystemPromptMock: vi.fn().mockReturnValue(undefined),
}))

// ─── Module mocks ─────────────────────────────────────────────────────────────
// Paths are relative to this test file (src/main/__tests__/).
// They must resolve to the same modules the SUT (src/main/remote/handlers/tabs.ts)
// imports — vitest resolves both against the filesystem so they deduplicate.

vi.mock('../state', () => ({
  state: {
    get mainWindow() {
      return { webContents: { executeJavaScript: (...args: any[]) => mocks.executeJsMock(...args) } }
    },
    get remoteTransport() {
      return { send: (...args: any[]) => mocks.remoteSendMock(...args) }
    },
  },
  sessionPlane: {
    closeTab: vi.fn(),
    cancelTab: vi.fn().mockReturnValue(false),
    respondToPermission: vi.fn(),
    setPermissionMode: vi.fn(),
    resetTabSession: vi.fn(),
  },
  engineBridge: { stopByPrefix: vi.fn(), sendAbort: vi.fn() },
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
  deviceFocusMap: new Map(),
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../terminal-manager-instance', () => ({
  terminalManager: { destroyByPrefix: vi.fn(), create: vi.fn() },
}))

vi.mock('../settings-store', () => ({
  readSettings: (...args: any[]) => mocks.readSettingsMock(...args),
  readClaudeCompat: vi.fn().mockReturnValue(false),
}))

vi.mock('../remote/snapshot', () => ({
  getRemoteTabStates: (...args: any[]) => mocks.getRemoteTabStatesMock(...args),
}))

vi.mock('../remote/handlers/diagnostics', () => ({
  autoPullDiagnosticLogs: vi.fn(),
}))

vi.mock('../remote/handlers/tabs-sync', () => ({
  broadcastSync: vi.fn(),
  sendSync: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../prompt-pipeline', () => ({
  processIncomingPrompt: (...args: any[]) => mocks.processIncomingPromptMock(...args),
}))

vi.mock('../ipc-validation', () => ({
  resolveDiscoveryWorkingDir: vi.fn().mockReturnValue('/home/test'),
}))

vi.mock('../remote/attachment-encoder', () => ({
  encodeAttachments: (...args: any[]) => mocks.encodeAttachmentsMock(...args),
}))

// Mock engine.ts so tabs.ts can import getVoiceSystemPrompt without
// pulling in engine.ts's own heavy dependencies.
vi.mock('../remote/handlers/engine', () => ({
  getVoiceSystemPrompt: (...args: any[]) => mocks.getVoiceSystemPromptMock(...args),
  handleEngineAbort: vi.fn(),
  handleResetEngineSession: vi.fn(),
  handleEngineDialogResponse: vi.fn(),
  handleLoadEngineConversation: vi.fn(),
  handleLoadAgentConversation: vi.fn(),
  handleEngineSetModel: vi.fn(),
  handleVoiceConfig: vi.fn(),
}))

// Mock remaining command-handler dependencies so the protocol-contract tests
// can import it without dragging in the full tree.
vi.mock('../remote/handlers/tab-groups', () => ({
  handleSetTabGroupMode: vi.fn(),
  handleMoveTabToGroup: vi.fn(),
  handleToggleTabGroupPin: vi.fn(),
  handleReorderTabGroups: vi.fn(),
}))
vi.mock('../remote/handlers/terminal', () => ({
  handleTerminalInput: vi.fn(),
  handleTerminalResize: vi.fn(),
  handleTerminalAddInstance: vi.fn(),
  handleTerminalRemoveInstance: vi.fn(),
  handleRequestTerminalSnapshot: vi.fn(),
  handleTerminalSelectInstance: vi.fn(),
  handleRenameTab: vi.fn(),
  handleRenameTerminalInstance: vi.fn(),
  handleSetPillColor: vi.fn(),
  handleSetPillIcon: vi.fn(),
}))
vi.mock('../remote/handlers/history', () => ({
  handleRewind: vi.fn(),
  handleForkFromMessage: vi.fn(),
  handleEngineRewind: vi.fn(),
  handleUnpair: vi.fn(),
}))
vi.mock('../remote/handlers/git', () => ({
  handleGitChanges: vi.fn(),
  handleGitGraph: vi.fn(),
  handleGitDiff: vi.fn(),
  handleGitStage: vi.fn(),
  handleGitUnstage: vi.fn(),
  handleGitCommit: vi.fn(),
  handleGitDiscard: vi.fn(),
  handleGitFetch: vi.fn(),
  handleGitPull: vi.fn(),
  handleGitPush: vi.fn(),
  handleGitCommitFiles: vi.fn(),
  handleGitCommitFileDiff: vi.fn(),
}))
vi.mock('../remote/handlers/files', () => ({
  handleFsListDir: vi.fn(),
  handleFsReadFile: vi.fn(),
  handleFsReadImage: vi.fn(),
  handleFsWriteFile: vi.fn(),
  handleFsRename: vi.fn(),
  handleUploadAttachment: vi.fn(),
}))
vi.mock('../remote/handlers/diagnostics', () => ({
  autoPullDiagnosticLogs: vi.fn(),
  handleDiagnosticLogsResponse: vi.fn(),
}))
vi.mock('../remote/handlers/attachments', () => ({ handleLoadAttachments: vi.fn() }))
vi.mock('../remote/handlers/display', () => ({ handleSetRemoteDisplay: vi.fn() }))
vi.mock('../remote/handlers/desktop-settings', () => ({ handleSetDesktopSetting: vi.fn() }))
vi.mock('../remote/handlers/resources', () => ({
  handleRequestResourceContent: vi.fn(),
  handleMarkResourceRead: vi.fn(),
  handleDeleteResource: vi.fn(),
}))
vi.mock('../remote/handlers/plan-content', () => ({ handleRequestPlanContent: vi.fn() }))
vi.mock('../remote/handlers/implement-plan', () => ({ handleImplementPlan: vi.fn() }))

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { handleCreateTab, handlePrompt } from '../remote/handlers/tabs'
import { handleRemoteCommand } from '../remote/command-handler'

// ─── handleCreateTab ──────────────────────────────────────────────────────────

describe('handleCreateTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeJsMock.mockResolvedValue('tab-123')
    mocks.getRemoteTabStatesMock.mockResolvedValue({
      tabs: [{
        id: 'tab-123', title: 'New Tab', status: 'idle',
        workingDirectory: '/home/test', permissionMode: 'auto',
        permissionQueue: [], lastMessage: null, contextTokens: null,
        contextWindow: null, messageCount: 0, queuedPrompts: [], customTitle: null,
      }],
    })
    mocks.readSettingsMock.mockReturnValue({ defaultBaseDirectory: '/home/test' })
  })

  it('creates a plain CLI tab when profileId is absent', async () => {
    await handleCreateTab({ type: 'desktop_create_tab', workingDirectory: '/home/test' })

    const calls = mocks.executeJsMock.mock.calls
    const createCall = calls.find((c) => String(c[0]).includes('createTabInDirectory'))
    expect(createCall).toBeDefined()
    const engineCall = calls.find((c) => String(c[0]).includes('createConversationTab'))
    expect(engineCall).toBeUndefined()
  })

  it('creates an engine tab when profileId is present', async () => {
    await handleCreateTab({ type: 'desktop_create_tab', workingDirectory: '/home/test', profileId: 'prof-abc' })

    const calls = mocks.executeJsMock.mock.calls
    const engineCall = calls.find((c) => String(c[0]).includes('createConversationTab'))
    expect(engineCall).toBeDefined()
    expect(String(engineCall![0])).toContain('prof-abc')
    const plainCall = calls.find((c) => String(c[0]).includes('createTabInDirectory'))
    expect(plainCall).toBeUndefined()
  })

  it('restores activeTabId after engine tab creation', async () => {
    await handleCreateTab({ type: 'desktop_create_tab', workingDirectory: '/home/test', profileId: 'prof-xyz' })

    const calls = mocks.executeJsMock.mock.calls
    const engineCall = calls.find((c) => String(c[0]).includes('createConversationTab'))
    expect(String(engineCall![0])).toContain('activeTabId: prev')
  })

  it('escapes single-quotes in profileId', async () => {
    await handleCreateTab({ type: 'desktop_create_tab', profileId: "it's-a-prof", workingDirectory: '/tmp' })

    const calls = mocks.executeJsMock.mock.calls
    const engineCall = calls.find((c) => String(c[0]).includes('createConversationTab'))
    expect(engineCall).toBeDefined()
    expect(String(engineCall![0])).toContain("it\\'s-a-prof")
  })

  it('uses defaultBaseDirectory when workingDirectory absent (engine path)', async () => {
    mocks.readSettingsMock.mockReturnValue({ defaultBaseDirectory: '/default/dir' })
    await handleCreateTab({ type: 'desktop_create_tab', profileId: 'prof-default' })

    const calls = mocks.executeJsMock.mock.calls
    const engineCall = calls.find((c) => String(c[0]).includes('createConversationTab'))
    expect(engineCall).toBeDefined()
    expect(String(engineCall![0])).toContain('/default/dir')
  })

  it('uses defaultBaseDirectory when workingDirectory absent (plain path)', async () => {
    mocks.readSettingsMock.mockReturnValue({ defaultBaseDirectory: '/default/dir' })
    await handleCreateTab({ type: 'desktop_create_tab' })

    const calls = mocks.executeJsMock.mock.calls
    const createCall = calls.find((c) => String(c[0]).includes('createTabInDirectory'))
    expect(createCall).toBeDefined()
    expect(String(createCall![0])).toContain('/default/dir')
  })
})

// ─── handlePrompt ─────────────────────────────────────────────────────────────

describe('handlePrompt', () => {
  const DEVICE_ID = 'device-001'

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeJsMock.mockResolvedValue(null)
    mocks.encodeAttachmentsMock.mockReturnValue({ encoded: [], rewrittenText: 'hello engine' })
    mocks.processIncomingPromptMock.mockResolvedValue(undefined)
  })

  it('routes CLI prompt (no instanceId) with hasExtensions=false', async () => {
    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-1', text: 'hello cli' },
      DEVICE_ID,
    )

    expect(mocks.processIncomingPromptMock).toHaveBeenCalledOnce()
    const args = mocks.processIncomingPromptMock.mock.calls[0][0]
    expect(args.hasExtensions).toBe(false)
    expect(args.tabId).toBe('tab-1')
    expect(args.text).toBe('hello cli')
  })

  it('echoes user message to iOS on CLI prompt', async () => {
    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-echo', text: 'test text' },
      DEVICE_ID,
    )

    expect(mocks.remoteSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'desktop_message_added',
        tabId: 'tab-echo',
        message: expect.objectContaining({ role: 'user', content: 'test text' }),
      }),
    )
  })

  it('routes engine prompt (instanceId present) with hasExtensions=true', async () => {
    // Return an instanceId so the handler uses it directly without auto-create
    mocks.executeJsMock.mockResolvedValue('inst-abc')

    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-2', text: 'hello engine', instanceId: 'inst-abc' },
      DEVICE_ID,
    )

    expect(mocks.processIncomingPromptMock).toHaveBeenCalledOnce()
    const args = mocks.processIncomingPromptMock.mock.calls[0][0]
    expect(args.hasExtensions).toBe(true)
    expect(args.tabId).toBe('tab-2')
    expect(args.instanceId).toBe('inst-abc')
  })

  it('echoes user message on engine prompt path using clientMsgId as id', async () => {
    // Regression for iOS Remote outgoing-duplication: the engine path must echo
    // the user turn under the iOS-supplied clientMsgId so iOS reconciles its
    // optimistic bubble by id (replace in place) instead of appending a second
    // one. Previously the engine path sent NO live user echo, so the optimistic
    // UUID bubble and the reloaded canonical turn both rendered until a history
    // reload deduped them. With Fix A this test goes RED if the echo is removed.
    mocks.executeJsMock.mockResolvedValue('inst-xyz')

    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-3', text: 'engine text', instanceId: 'inst-xyz', clientMsgId: 'cmid-123' },
      DEVICE_ID,
    )

    const echoCalls = mocks.remoteSendMock.mock.calls.filter(
      (c) => c[0]?.type === 'desktop_message_added' && c[0]?.message?.role === 'user',
    )
    expect(echoCalls).toHaveLength(1)
    expect(echoCalls[0][0].message.id).toBe('cmid-123')
    expect(echoCalls[0][0].message.content).toContain('engine text')
  })

  it('passes implementationPhase to pipeline on CLI path', async () => {
    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-4', text: 'impl', implementationPhase: true },
      DEVICE_ID,
    )

    const args = mocks.processIncomingPromptMock.mock.calls[0][0]
    expect(args.implementationPhase).toBe(true)
  })

  it('passes implementationPhase to pipeline on engine path', async () => {
    mocks.executeJsMock.mockResolvedValue('inst-ip')

    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-5', text: 'impl engine', instanceId: 'inst-ip', implementationPhase: true },
      DEVICE_ID,
    )

    const args = mocks.processIncomingPromptMock.mock.calls[0][0]
    expect(args.implementationPhase).toBe(true)
    expect(args.hasExtensions).toBe(true)
  })

  it('auto-creates engine instance when none exists and instanceId supplied as empty string', async () => {
    // instanceId='' is truthy check for isEnginePrompt but empty means "no explicit id"
    // First executeJs call: active instance lookup → null (no pane)
    // Second: addEngineInstance → 'new-inst'
    // Subsequent: instanceInfo, model override, paths → null
    mocks.executeJsMock
      .mockResolvedValueOnce(null)        // active instance resolution (pane lookup)
      .mockResolvedValueOnce('new-inst')  // addEngineInstance
      .mockResolvedValue(null)            // instanceInfo + model override + paths

    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-6', text: 'first prompt', instanceId: '' },
      DEVICE_ID,
    )

    const calls = mocks.executeJsMock.mock.calls
    const addCall = calls.find((c) => String(c[0]).includes('addEngineInstance'))
    expect(addCall).toBeDefined()

    const args = mocks.processIncomingPromptMock.mock.calls[0][0]
    expect(args.hasExtensions).toBe(true)
    expect(args.instanceId).toBe('new-inst')
  })

  it('calls encodeAttachments on engine path', async () => {
    mocks.executeJsMock.mockResolvedValue('inst-enc')
    mocks.encodeAttachmentsMock.mockReturnValue({ encoded: [], rewrittenText: 'rewritten' })

    await handlePrompt(
      { type: 'desktop_prompt', tabId: 'tab-7', text: 'hi', instanceId: 'inst-enc', attachments: [{ type: 'file', name: 'foo.txt', path: '/tmp/foo.txt' }] },
      DEVICE_ID,
    )

    expect(mocks.encodeAttachmentsMock).toHaveBeenCalledOnce()
    const args = mocks.processIncomingPromptMock.mock.calls[0][0]
    expect(args.text).toBe('rewritten')
  })
})

// ─── Protocol contract ────────────────────────────────────────────────────────

describe('protocol contract: removed command strings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeJsMock.mockResolvedValue(null)
    mocks.processIncomingPromptMock.mockResolvedValue(undefined)
    mocks.readSettingsMock.mockReturnValue({ defaultBaseDirectory: '/tmp' })
    mocks.getRemoteTabStatesMock.mockResolvedValue({ tabs: [] })
  })
  it('desktop_create_engine_tab falls through the switch without error', async () => {
    const staleCmd = { type: 'desktop_create_engine_tab', workingDirectory: '/tmp' } as any
    await expect(handleRemoteCommand(staleCmd, 'dev-0')).resolves.toBeUndefined()
  })

  it('desktop_engine_prompt falls through the switch without error', async () => {
    const staleCmd = { type: 'desktop_engine_prompt', tabId: 'tab-x', text: 'hi' } as any
    await expect(handleRemoteCommand(staleCmd, 'dev-0')).resolves.toBeUndefined()
  })

  it('desktop_create_tab with profileId routes to engine tab creation via command-handler', async () => {
    mocks.executeJsMock.mockResolvedValue('new-tab')
    mocks.getRemoteTabStatesMock.mockResolvedValue({ tabs: [] })
    mocks.readSettingsMock.mockReturnValue({ defaultBaseDirectory: '/tmp' })

    await handleRemoteCommand(
      { type: 'desktop_create_tab', profileId: 'prof-wire', workingDirectory: '/tmp' },
      'dev-1',
    )

    const calls = mocks.executeJsMock.mock.calls
    const engineCall = calls.find((c) => String(c[0]).includes('createConversationTab'))
    expect(engineCall).toBeDefined()
  })

  it('desktop_prompt with instanceId routes to engine pipeline via command-handler', async () => {
    mocks.executeJsMock.mockResolvedValue('inst-wire')

    await handleRemoteCommand(
      { type: 'desktop_prompt', tabId: 'tab-wire', text: 'hi', instanceId: 'inst-wire' },
      'dev-2',
    )

    expect(mocks.processIncomingPromptMock).toHaveBeenCalledOnce()
    const args = mocks.processIncomingPromptMock.mock.calls[0][0]
    expect(args.hasExtensions).toBe(true)
  })
})
