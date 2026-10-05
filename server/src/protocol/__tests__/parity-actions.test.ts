/**
 * Pins the actions that close the gap between the desktop_* wire and the
 * Studio wire: each reaches the same function the desktop_* handler calls,
 * names its tab for ownership, carries its scope, and declines a bad argument
 * instead of silently doing nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  readAgentRoster: vi.fn((tabId: string, instanceId: string | null) => ({ tabId, instanceId: instanceId ?? 'main', agents: [{ name: 'scout' }] })),
  loadTabAttachments: vi.fn(async () => [{ id: 'att-1' }]),
  openTerminalApplication: vi.fn(() => true),
  setVoiceConfig: vi.fn(),
  handleSetPermissionMode: vi.fn(async (cmd: { mode: string }) => cmd.mode === 'auto' || cmd.mode === 'plan'),
  handleSetThinkingEffort: vi.fn(async (cmd: { effort: string }) => cmd.effort !== 'bogus'),
  handleWorktreeCommand: vi.fn(async () => true),
  buildWorktreeState: vi.fn(async (repoPath: string) => ({ repoPath, worktrees: [], benches: [] })),
  resetTabSession: vi.fn(),
  handleEngineAbort: vi.fn(),
  revokeClient: vi.fn(() => true),
  liveConnections: [] as Array<{ pairedClientId: string | null; isClosed: boolean; close: ReturnType<typeof vi.fn> }>,
  createTabForClient: vi.fn(async (): Promise<string | null> => 't-new'),
  createTerminalTabForClient: vi.fn(async (): Promise<string | null> => 't-term'),
  notifyTabCreated: vi.fn(async (): Promise<boolean> => true),
  handleResetEngineSession: vi.fn(async () => undefined),
  closeTabGuarded: vi.fn(async () => ({ closed: true, blocked: false, orchestratorRunning: false, agentCount: 0, shellCount: 0 })),
  submitClientPrompt: vi.fn(async (cmd: { clientMsgId?: string }) => ({ accepted: true, clientMsgId: cmd.clientMsgId ?? 'remote-1' })),
  forkConversationFromMessage: vi.fn(async (): Promise<{ tabId: string; pendingInput: string } | null> => ({ tabId: 't-fork', pendingInput: 'try again' })),
  rewindConversationInstance: vi.fn(async () => ({ ok: true, pendingInput: 'earlier turn' })),
  handleImplementPlan: vi.fn(async () => undefined),
  applyProjectableSetting: vi.fn((): { ok: true } | { ok: false; code: string; message: string } => ({ ok: true })),
  handleDiagnosticLogsResponse: vi.fn(),
  diagnosticLogCursor: vi.fn(() => 42),
  readTerminalPaneSnapshot: vi.fn(async (tabId: string): Promise<unknown> => ({ tabId, instances: [{ id: 'i1', label: 'Shell', kind: 'user', readOnly: false, cwd: '/repo' }], activeInstanceId: 'i1', buffers: { i1: '$ ls' } })),
}))
vi.mock('../../remote/handlers/agent-state', () => ({ readAgentRoster: deps.readAgentRoster }))
vi.mock('../../remote/handlers/attachments', () => ({ loadTabAttachments: deps.loadTabAttachments }))
vi.mock('../../remote/handlers/terminal', () => ({ openTerminalApplication: deps.openTerminalApplication, readTerminalPaneSnapshot: deps.readTerminalPaneSnapshot }))
vi.mock('../../remote/handlers/engine', () => ({ setVoiceConfig: deps.setVoiceConfig, handleEngineAbort: deps.handleEngineAbort, handleResetEngineSession: deps.handleResetEngineSession }))
vi.mock('../../remote/handlers/tabs', () => ({ handleSetPermissionMode: deps.handleSetPermissionMode, handleSetThinkingEffort: deps.handleSetThinkingEffort, closeTabGuarded: deps.closeTabGuarded }))
vi.mock('../../remote/handlers/tabs-create-echo', () => ({ createTabForClient: deps.createTabForClient, createTerminalTabForClient: deps.createTerminalTabForClient, notifyTabCreated: deps.notifyTabCreated }))
vi.mock('../../remote/handlers/tabs-prompt', () => ({ submitClientPrompt: deps.submitClientPrompt }))
vi.mock('../../remote/handlers/history', () => ({ forkConversationFromMessage: deps.forkConversationFromMessage, rewindConversationInstance: deps.rewindConversationInstance }))
vi.mock('../../remote/handlers/implement-plan', () => ({ handleImplementPlan: deps.handleImplementPlan }))
vi.mock('../../remote/handlers/desktop-settings', () => ({ applyProjectableSetting: deps.applyProjectableSetting }))
vi.mock('../../remote/handlers/diagnostics', () => ({ handleDiagnosticLogsResponse: deps.handleDiagnosticLogsResponse, diagnosticLogCursor: deps.diagnosticLogCursor }))
vi.mock('../../remote/handlers/worktree', () => ({ handleWorktreeCommand: deps.handleWorktreeCommand, buildWorktreeState: deps.buildWorktreeState }))
vi.mock('../../auth/credentials-store', () => ({ credentialsStore: () => 'store' }))
vi.mock('../../auth/pairing-links', () => ({ revokeClient: deps.revokeClient }))
vi.mock('../connection', () => ({ connectionRegistry: { all: () => deps.liveConnections } }))
vi.mock('../../state', () => ({ sessionPlane: { resetTabSession: deps.resetTabSession } }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { PARITY_ACTIONS } from '../parity-actions'
import type { Connection } from '../connection'

const conn = { id: 'conn-1', clientId: 'hello-id', pairedClientId: 'phone-1', principal: { subject: 'oidc:alice' } } as unknown as Connection
const run = (name: string, arg: unknown, on: Connection = conn) => PARITY_ACTIONS[name].handler(on, [arg])
const declined = (message: string) => ({ ok: false, error: { code: 'invalid_argument', message } })
beforeEach(() => {
  for (const fn of Object.values(deps)) if (typeof fn === 'function') fn.mockClear()
  deps.liveConnections.length = 0
})

describe('PARITY_ACTIONS', () => {
  it('reads return what the client renders', async () => {
    expect(await run('engine.agentState', { tabId: 't1', instanceId: 'i2' })).toEqual({ ok: true, value: { tabId: 't1', instanceId: 'i2', agents: [{ name: 'scout' }] } })
    expect(deps.readAgentRoster).toHaveBeenCalledWith('t1', 'i2', 'conn-1')
    await run('engine.agentState', { tabId: 't1' })
    expect(deps.readAgentRoster).toHaveBeenLastCalledWith('t1', null, 'conn-1')
    expect(await run('session.tabAttachments', { tabId: 't1' })).toEqual({ ok: true, value: { tabId: 't1', attachments: [{ id: 'att-1' }] } })
    expect(await run('worktree.state', { repoPath: '/repo' })).toEqual({ ok: true, value: { repoPath: '/repo', worktrees: [], benches: [] } })
  })

  it('the tab-addressed verbs act on the tab they name, not the active one', async () => {
    expect(await run('session.setPermissionMode', { tabId: 't7', mode: 'plan' })).toEqual({ ok: true, value: true })
    expect(deps.handleSetPermissionMode).toHaveBeenCalledWith({ tabId: 't7', mode: 'plan' })
    expect(await run('session.setThinkingEffort', { tabId: 't7', effort: 'high' })).toEqual({ ok: true, value: true })
    expect(deps.handleSetThinkingEffort).toHaveBeenCalledWith({ tabId: 't7', effort: 'high' })
    await run('session.resetTab', { tabId: 't7' })
    expect(deps.resetTabSession).toHaveBeenCalledWith('t7')
  })

  it('terminal and worktree verbs reach the shared implementation', async () => {
    expect(await run('terminal.openApplication', { tabId: 't1', url: 'http://localhost:5173' })).toEqual({ ok: true, value: true })
    expect(deps.openTerminalApplication).toHaveBeenCalledWith('t1', 'http://localhost:5173')
    deps.openTerminalApplication.mockReturnValueOnce(false)
    expect(await run('terminal.openApplication', { tabId: 't1', url: 'http://evil.example' })).toEqual({ ok: true, value: false })
    await run('worktree.syncAll', { repoPath: '/repo' })
    expect(deps.handleWorktreeCommand).toHaveBeenCalledWith({ type: 'desktop_worktree_sync_all', repoPath: '/repo' })
  })

  it('voice config is kept under the pairing, so either wire reads what either set', async () => {
    await run('voice.setConfig', { enabled: true, mode: 'desktop', systemPrompt: 'Be brief.' })
    expect(deps.setVoiceConfig).toHaveBeenCalledWith('phone-1', { enabled: true, mode: 'desktop', systemPrompt: 'Be brief.' })
    await run('voice.setConfig', { enabled: false, mode: 'client' }, { id: 'conn-2', clientId: 'hello-id', pairedClientId: null } as unknown as Connection)
    expect(deps.setVoiceConfig).toHaveBeenLastCalledWith('hello-id', { enabled: false, mode: 'client', systemPrompt: undefined })
  })

  it('session.prompt submits as the calling client and answers the real outcome', async () => {
    expect(await run('session.prompt', { tabId: 't1', text: '/review now', clientMsgId: 'msg-7', instanceId: '', attachments: [{ type: 'image', name: 'a.png', path: '/u/a.png' }], implementationPhase: true }))
      .toEqual({ ok: true, value: { accepted: true, clientMsgId: 'msg-7' } })
    expect(deps.submitClientPrompt).toHaveBeenCalledWith(
      { tabId: 't1', text: '/review now', clientMsgId: 'msg-7', instanceId: '', attachments: [{ type: 'image', name: 'a.png', path: '/u/a.png' }], implementationPhase: true },
      { kind: 'caller', clientId: 'phone-1', principalSubject: 'oidc:alice' },
    )
    // No instanceId is a plain conversation: the key stays absent rather than becoming an empty target.
    await run('session.prompt', { tabId: 't1', text: 'hello' })
    expect(deps.submitClientPrompt.mock.lastCall?.[0]).toEqual({ tabId: 't1', text: 'hello', attachments: undefined, clientMsgId: undefined, instanceId: undefined, implementationPhase: undefined })
    deps.submitClientPrompt.mockResolvedValueOnce({ accepted: false, reason: 'Not sent: this conversation is locked.', clientMsgId: 'msg-8' } as never)
    expect(await run('session.prompt', { tabId: 't1', text: 'hi', clientMsgId: 'msg-8' })).toEqual({ ok: true, value: { accepted: false, reason: 'Not sent: this conversation is locked.', clientMsgId: 'msg-8' } })
  })

  it('session.prompt hands the client traceparent to the server span', async () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    await run('session.prompt', { tabId: 't1', text: 'hello', traceparent })
    expect(deps.submitClientPrompt.mock.lastCall?.[0]).toMatchObject({ tabId: 't1', traceparent })
    // A non-string is dropped here; the span treats a missing traceparent as a new root.
    await run('session.prompt', { tabId: 't1', text: 'hello', traceparent: 7 })
    expect(deps.submitClientPrompt.mock.lastCall?.[0]).not.toHaveProperty('traceparent', expect.anything())
  })

  it('tabs.create answers the new tab and passes only what the client named', async () => {
    expect(await run('tabs.create', { workingDirectory: '/repo', profileId: 'example-profile', useWorktree: true, sourceBranch: 'main', clientCmdId: 'cmd-1' })).toEqual({ ok: true, value: { tabId: 't-new' } })
    expect(deps.createTabForClient).toHaveBeenCalledWith({ workingDirectory: '/repo', profileId: 'example-profile', useWorktree: true, sourceBranch: 'main', ephemeralWorktree: undefined, clientCmdId: 'cmd-1' })
    await run('tabs.create', {})
    expect(deps.createTabForClient).toHaveBeenLastCalledWith({ workingDirectory: undefined, profileId: undefined, useWorktree: undefined, sourceBranch: undefined, ephemeralWorktree: undefined, clientCmdId: undefined })
    await run('tabs.create', { workingDirectory: '/repo', useWorktree: true, ephemeralWorktree: true })
    expect(deps.createTabForClient).toHaveBeenLastCalledWith(expect.objectContaining({ useWorktree: true, ephemeralWorktree: true }))
    await run('tabs.create', { workingDirectory: '/repo', useWorktree: true, ephemeralWorktree: 'yes' })
    expect(deps.createTabForClient).toHaveBeenLastCalledWith(expect.objectContaining({ ephemeralWorktree: undefined }))
    deps.createTabForClient.mockResolvedValueOnce(null)
    expect(await run('tabs.create', { workingDirectory: '/gone' })).toEqual({ ok: true, value: { tabId: null } })
    // Every other client renders the new conversation from the echo, and the
    // caller's confirm-or-resend loop waits for it, so a create made through
    // the action announces itself exactly as one made through the command.
    expect(deps.notifyTabCreated.mock.calls).toEqual([['t-new', 'cmd-1'], ['t-new', undefined], ['t-new', undefined], ['t-new', undefined]])
    expect(await run('tabs.createTerminal', { workingDirectory: '/repo' })).toEqual({ ok: true, value: { tabId: 't-term' } })
    expect(deps.notifyTabCreated).toHaveBeenLastCalledWith('t-term', undefined)
    expect(deps.createTerminalTabForClient).toHaveBeenCalledWith({ workingDirectory: '/repo', clientCmdId: undefined })
  })

  it('tabs.close answers the guard, so a refusal says what is still running', async () => {
    expect(await run('tabs.close', { tabId: 't1' })).toEqual({ ok: true, value: { closed: true, blocked: false, orchestratorRunning: false, agentCount: 0, shellCount: 0 } })
    expect(deps.closeTabGuarded).toHaveBeenCalledWith('t1')
    deps.closeTabGuarded.mockResolvedValueOnce({ closed: false, blocked: true, orchestratorRunning: true, agentCount: 2, shellCount: 1 })
    expect(await run('tabs.close', { tabId: 't1' })).toEqual({ ok: true, value: { closed: false, blocked: true, orchestratorRunning: true, agentCount: 2, shellCount: 1 } })
  })

  it('fork and rewind answer the draft they seed, not only an id', async () => {
    expect(await run('session.forkFromMessage', { tabId: 't1', messageId: 'm3' })).toEqual({ ok: true, value: { tabId: 't-fork', pendingInput: 'try again' } })
    expect(deps.forkConversationFromMessage).toHaveBeenCalledWith('t1', 'm3')
    deps.forkConversationFromMessage.mockResolvedValueOnce(null)
    expect(await run('session.forkFromMessage', { tabId: 't1', messageId: 'gone' })).toEqual({ ok: true, value: null })
    expect(await run('engine.rewind', { tabId: 't1', instanceId: 'i1', messageId: 'm2', userTurnIndex: 4 })).toEqual({ ok: true, value: { ok: true, pendingInput: 'earlier turn' } })
    expect(deps.rewindConversationInstance).toHaveBeenCalledWith('t1', 'i1', 'm2', 4)
    await run('engine.rewind', { tabId: 't1', instanceId: 'i1', messageId: 'm2' })
    expect(deps.rewindConversationInstance).toHaveBeenLastCalledWith('t1', 'i1', 'm2', null)
  })

  it('engine.resetInstance stops the session, engine.abort only aborts, and implementPlan carries the question', async () => {
    await run('engine.resetInstance', { tabId: 't1', instanceId: 'i1' })
    expect(deps.handleResetEngineSession).toHaveBeenCalledWith({ type: 'desktop_reset_engine_session', tabId: 't1', instanceId: 'i1' })
    await run('engine.abort', { tabId: 't1' })
    expect(deps.handleEngineAbort).toHaveBeenCalledWith({ type: 'desktop_engine_abort', tabId: 't1' })
    await run('session.implementPlan', { tabId: 't1', questionId: 'q-9', instanceId: 'i1', clearContext: true })
    expect(deps.handleImplementPlan).toHaveBeenCalledWith({ type: 'desktop_implement_plan', tabId: 't1', questionId: 'q-9', instanceId: 'i1', clearContext: true })
    await run('session.implementPlan', { tabId: 't1', questionId: 'q-9' })
    expect(deps.handleImplementPlan).toHaveBeenLastCalledWith({ type: 'desktop_implement_plan', tabId: 't1', questionId: 'q-9', instanceId: undefined, clearContext: false })
  })

  it('settings writes carry the caller, and a refusal comes back as a value', async () => {
    expect(await run('settings.setProjectable', { key: 'expandToolResults', value: false })).toEqual({ ok: true, value: { ok: true } })
    expect(deps.applyProjectableSetting).toHaveBeenCalledWith('expandToolResults', false, expect.objectContaining({ label: 'client=phone-1' }))
    deps.applyProjectableSetting.mockReturnValueOnce({ ok: false, code: 'settings_locked', message: 'the theme is locked by enterprise policy' })
    expect(await run('settings.setProjectable', { key: 'selectedTheme', value: 'dusk' })).toEqual({ ok: true, value: { ok: false, code: 'settings_locked', message: 'the theme is locked by enterprise policy' } })
    // null is a value (it clears a setting); a missing key is not.
    await run('settings.setProjectable', { key: 'defaultBaseDirectory', value: null })
    expect(deps.applyProjectableSetting).toHaveBeenLastCalledWith('defaultBaseDirectory', null, expect.objectContaining({ label: 'client=phone-1' }))
  })

  it('clientLog.append persists under the pairing and answers the cursor', async () => {
    expect(await run('clientLog.append', { lines: '{"seq":41}\n', nextSeq: 42, pairingId: 'pair-1', withheldUnstamped: 3 })).toEqual({ ok: true, value: { nextSeq: 42 } })
    expect(deps.handleDiagnosticLogsResponse).toHaveBeenCalledWith({ type: 'desktop_diagnostic_logs_response', logs: '{"seq":41}\n', pairingId: 'pair-1', nextSeq: 42, withheldUnstamped: 3, withheldOtherPairing: undefined }, 'phone-1')
    expect(deps.diagnosticLogCursor).toHaveBeenCalledWith('phone-1')
  })

  it('auth.forgetSelf revokes only the pairing the caller rides, and closes its sessions after answering', async () => {
    const mine = { pairedClientId: 'phone-1', isClosed: false, close: vi.fn() }
    const other = { pairedClientId: 'phone-2', isClosed: false, close: vi.fn() }
    deps.liveConnections.push(mine, other)
    // Whatever the caller sends, the only pairing it can name is its own.
    expect(await run('auth.forgetSelf', { clientId: 'phone-2' })).toEqual({ ok: true, value: { revoked: true, closed: 1 } })
    expect(deps.revokeClient).toHaveBeenCalledWith('store', 'phone-1')
    expect(mine.close).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r))
    expect(mine.close).toHaveBeenCalledWith('revoked')
    expect(other.close).not.toHaveBeenCalled()
  })

  it('auth.forgetSelf declines a connection that did not come in on a pairing', async () => {
    const local = { id: 'conn-local', clientId: 'desktop', pairedClientId: null } as unknown as Connection
    expect(await run('auth.forgetSelf', {}, local)).toEqual(declined('this connection is not a paired client, so there is no pairing to forget'))
    expect(deps.revokeClient).not.toHaveBeenCalled()
  })

  it('terminal.paneSnapshot answers every instance and its scrollback, or null for a tab that is gone', async () => {
    expect(await run('terminal.paneSnapshot', { tabId: 't1' })).toEqual({ ok: true, value: { tabId: 't1', instances: [{ id: 'i1', label: 'Shell', kind: 'user', readOnly: false, cwd: '/repo' }], activeInstanceId: 'i1', buffers: { i1: '$ ls' } } })
    deps.readTerminalPaneSnapshot.mockResolvedValueOnce(null)
    expect(await run('terminal.paneSnapshot', { tabId: 'gone' })).toEqual({ ok: true, value: null })
  })

  it('declines a bad argument rather than doing nothing silently', async () => {
    expect(await run('engine.agentState', {})).toEqual(declined('tabId is required'))
    expect(await run('session.setPermissionMode', { tabId: 't1', mode: 'yolo' })).toEqual(declined(`mode must be 'auto' or 'plan'`))
    expect(await run('session.setThinkingEffort', { tabId: 't1', effort: 'bogus' })).toEqual(declined('effort is not a thinking-effort level'))
    expect(await run('terminal.openApplication', { tabId: 't1' })).toEqual(declined('url is required'))
    expect(await run('voice.setConfig', { enabled: 'yes', mode: 'desktop' })).toEqual(declined(`enabled must be a boolean and mode 'client' or 'desktop'`))
    expect(await run('worktree.syncAll', {})).toEqual(declined('repoPath is required'))
    expect(await run('session.prompt', { tabId: 't1' })).toEqual(declined('text is required'))
    expect(await run('session.prompt', { tabId: 't1', text: 'x', instanceId: 7 })).toEqual(declined('instanceId must be a string'))
    expect(await run('session.prompt', { tabId: 't1', text: 'x', attachments: 'a.png' })).toEqual(declined('attachments must be a list'))
    expect(await run('tabs.close', {})).toEqual(declined('tabId is required'))
    expect(await run('session.forkFromMessage', { tabId: 't1' })).toEqual(declined('messageId is required'))
    expect(await run('engine.rewind', { tabId: 't1', messageId: 'm' })).toEqual(declined('instanceId and messageId are required'))
    expect(await run('engine.resetInstance', { tabId: 't1' })).toEqual(declined('instanceId is required'))
    expect(await run('session.implementPlan', { tabId: 't1' })).toEqual(declined('questionId is required'))
    expect(await run('settings.setProjectable', { value: 1 })).toEqual(declined('key is required'))
    expect(await run('settings.setProjectable', { key: 'k' })).toEqual(declined('value is required'))
    expect(await run('clientLog.append', { lines: 7, nextSeq: 1 })).toEqual(declined('lines must be a string of newline-separated JSONL'))
    expect(await run('clientLog.append', { lines: '', nextSeq: -1 })).toEqual(declined('nextSeq must be a non-negative number'))
    expect(deps.submitClientPrompt).not.toHaveBeenCalled()
    expect(deps.handleDiagnosticLogsResponse).not.toHaveBeenCalled()
    expect(deps.handleWorktreeCommand).not.toHaveBeenCalled()
  })

  it('a thrown implementation becomes a failed action', async () => {
    deps.loadTabAttachments.mockRejectedValueOnce(new Error('store gone'))
    expect(await run('session.tabAttachments', { tabId: 't1' })).toEqual({ ok: false, error: { code: 'action_failed', message: 'Error: store gone' } })
  })

  it('every tab verb names its tab for the ownership check, and scopes match what each does', () => {
    for (const name of ['engine.agentState', 'session.tabAttachments', 'session.resetTab', 'session.setPermissionMode', 'session.setThinkingEffort', 'terminal.openApplication', 'session.prompt', 'tabs.close', 'session.forkFromMessage', 'engine.rewind', 'engine.resetInstance', 'engine.abort', 'session.implementPlan', 'terminal.paneSnapshot']) {
      expect(PARITY_ACTIONS[name].tabIdAt?.([{ tabId: 't9' }]), name).toBe('t9')
      expect(PARITY_ACTIONS[name].tabIdAt?.([{}]), name).toBeUndefined()
    }
    const scopes = Object.fromEntries(Object.entries(PARITY_ACTIONS).map(([name, spec]) => [name, spec.requiredScope]))
    expect(scopes).toEqual({
      'engine.agentState': 'conversations:read',
      'session.tabAttachments': 'conversations:read',
      'session.resetTab': 'conversations:operate',
      'session.setPermissionMode': 'conversations:operate',
      'session.setThinkingEffort': 'conversations:operate',
      'terminal.openApplication': 'terminal:operate',
      'voice.setConfig': 'conversations:operate',
      'worktree.state': 'git:write',
      'worktree.syncAll': 'git:write',
      'session.prompt': 'conversations:operate',
      'tabs.create': 'conversations:operate',
      'tabs.createTerminal': 'terminal:operate',
      'tabs.close': 'conversations:operate',
      'session.forkFromMessage': 'conversations:operate',
      'engine.rewind': 'conversations:operate',
      'engine.resetInstance': 'conversations:operate',
      'engine.abort': 'conversations:operate',
      'session.implementPlan': 'conversations:operate',
      'settings.setProjectable': 'conversations:operate',
      'clientLog.append': 'conversations:operate',
      'terminal.paneSnapshot': 'terminal:operate',
      'auth.forgetSelf': 'conversations:read',
    })
  })
})
