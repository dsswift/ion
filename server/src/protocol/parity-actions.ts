/**
 * parity-actions -- what a client could do on the `desktop_*` wire and had no
 * way to do on the Studio wire.
 *
 * Each is one `studio_action` over the same function the `desktop_*` handler
 * calls, so the two wires cannot drift while both exist, and nothing here is
 * specific to a phone: any Studio client may call them.
 *
 * Two of them name a tab explicitly where the store's own action acts on the
 * ACTIVE tab (`setPermissionMode`, `setThinkingEffort`). A client that is not
 * looking at the desktop's active tab would otherwise have to steal its focus
 * to change a different conversation.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Reads are `conversations:read`; anything that steers a conversation or
 * rearranges tabs is `conversations:operate`; worktree verbs are `git:write`.
 * Everything that names a tab is ownership-checked through `tabIdAt`.
 */
import { readAgentRoster } from '../remote/handlers/agent-state'
import { loadTabAttachments } from '../remote/handlers/attachments'
import { openTerminalApplication } from '../remote/handlers/terminal'
import { handleEngineAbort, handleResetEngineSession, setVoiceConfig } from '../remote/handlers/engine'
import { closeTabGuarded, handleSetPermissionMode, handleSetThinkingEffort } from '../remote/handlers/tabs'
import { submitClientPrompt } from '../remote/handlers/tabs-prompt'
import { createTabForClient, createTerminalTabForClient, notifyTabCreated } from '../remote/handlers/tabs-create-echo'
import { forkConversationFromMessage, rewindConversationInstance } from '../remote/handlers/history'
import { handleImplementPlan } from '../remote/handlers/implement-plan'
import { handleWorktreeCommand, buildWorktreeState } from '../remote/handlers/worktree'
import { sessionPlane } from '../state'
import type { SessionActionSpec } from './session-actions'
import { Declined, clientKey, requireTab, str, tabAt, wrap } from './parity-wrap'
import { PARITY_CLIENT_ACTIONS } from './parity-client-actions'

export const PARITY_ACTIONS: Record<string, SessionActionSpec> = {
  // [{ tabId, instanceId? }] -> { tabId, instanceId, agents }. A complete
  // roster, never a delta; an unknown tab answers with an empty one.
  'engine.agentState': wrap('engine.agentState', 'conversations:read', (a, conn) =>
    readAgentRoster(requireTab(a), str(a.instanceId) || null, conn.id), tabAt),

  // [{ tabId }] -> { tabId, attachments }
  'session.tabAttachments': wrap('session.tabAttachments', 'conversations:read', async (a) => {
    const tabId = requireTab(a)
    return { tabId, attachments: await loadTabAttachments(tabId) }
  }, tabAt),

  // [{ tabId }] -- stops the session and resets the tab's store-side session state; `engine.stop` only stops.
  'session.resetTab': wrap('session.resetTab', 'conversations:operate', (a) => {
    sessionPlane.resetTabSession(requireTab(a))
    return true
  }, tabAt),

  // [{ tabId, mode: 'auto' | 'plan' }] -- the named tab, with plan-file continuity.
  'session.setPermissionMode': wrap('session.setPermissionMode', 'conversations:operate', async (a) => {
    if (!(await handleSetPermissionMode({ tabId: requireTab(a), mode: a.mode as 'auto' | 'plan' }))) throw new Declined(`mode must be 'auto' or 'plan'`)
    return true
  }, tabAt),

  // [{ tabId, effort }] -- the named tab's active instance; 'off' clears it.
  'session.setThinkingEffort': wrap('session.setThinkingEffort', 'conversations:operate', async (a) => {
    if (!(await handleSetThinkingEffort({ tabId: requireTab(a), effort: a.effort as never }))) throw new Declined('effort is not a thinking-effort level')
    return true
  }, tabAt),

  // [{ tabId, url }] -> opened. Refused unless a terminal of that tab still serves `url`.
  'terminal.openApplication': wrap('terminal.openApplication', 'terminal:operate', (a) => {
    const url = str(a.url)
    if (!url) throw new Declined('url is required')
    return openTerminalApplication(requireTab(a), url)
  }, tabAt),

  // [{ enabled, mode: 'client' | 'desktop', systemPrompt? }] -- kept per client, read when that client submits a prompt.
  'voice.setConfig': wrap('voice.setConfig', 'conversations:operate', (a, conn) => {
    if (typeof a.enabled !== 'boolean' || (a.mode !== 'client' && a.mode !== 'desktop')) throw new Declined(`enabled must be a boolean and mode 'client' or 'desktop'`)
    setVoiceConfig(clientKey(conn), { enabled: a.enabled, mode: a.mode, systemPrompt: str(a.systemPrompt) || undefined })
    return true
  }),

  // [{ repoPath }] -> RemoteWorktreeState: the projection a client renders, pulled rather than awaited.
  'worktree.state': wrap('worktree.state', 'git:write', (a) => {
    const repoPath = str(a.repoPath)
    if (!repoPath) throw new Declined('repoPath is required')
    return buildWorktreeState(repoPath)
  }),

  // [{ tabId, text, attachments?, clientMsgId?, instanceId?, implementationPhase?, traceparent? }]
  //   -> { accepted, reason?, clientMsgId }
  // A prompt as a client typed it: slash commands, `!` shell lines, and
  // attachments included. Naming `instanceId` (an empty string means "the
  // active one") targets an extension-hosted conversation and creates its
  // first instance when it has none. The value is the real outcome, so a
  // composer clears on acceptance and keeps its text on a rejection.
  // `clientMsgId` is the id the user turn is echoed under, and it rides the
  // store row the prompt made, so a thin client can match its pending bubble
  // to that row in the transcript it is sent. It is not written to disk.
  // `traceparent` names the client's prompt.send span; the server's
  // prompt.handle span joins that trace (a missing or invalid one starts a new root).
  'session.prompt': wrap('session.prompt', 'conversations:operate', (a, conn) => {
    const tabId = requireTab(a)
    if (typeof a.text !== 'string') throw new Declined('text is required')
    if (a.attachments !== undefined && !Array.isArray(a.attachments)) throw new Declined('attachments must be a list')
    if (a.instanceId !== undefined && typeof a.instanceId !== 'string') throw new Declined('instanceId must be a string')
    return submitClientPrompt({
      tabId,
      text: a.text,
      attachments: a.attachments as never,
      clientMsgId: str(a.clientMsgId) || undefined,
      instanceId: a.instanceId,
      implementationPhase: a.implementationPhase === true || undefined,
      traceparent: str(a.traceparent) || undefined,
    }, { kind: 'caller', clientId: clientKey(conn), principalSubject: conn.principal?.subject })
  }, tabAt),

  // [{ workingDirectory?, profileId?, useWorktree?, sourceBranch?, clientCmdId? }] -> { tabId: string | null }
  // A conversation made by a client that is not the desktop: the desktop's
  // active tab stays where it was (the store's own create actions make the new
  // tab active, which every mirror follows), no directory means the configured
  // default, and a repeated `clientCmdId` answers the tab the first call made.
  // `profileId` makes it an extension-hosted conversation.
  // The value answers the caller; the `desktop_tab_created` echo is what every
  // OTHER client renders the new conversation from, and it is what a caller's
  // confirm-or-resend loop waits for. The `desktop_*` command handler sends it
  // too, so an action-created tab is announced exactly as a command-created one.
  'tabs.create': wrap('tabs.create', 'conversations:operate', async (a) => {
    const clientCmdId = str(a.clientCmdId) || undefined
    const tabId = await createTabForClient({
      workingDirectory: str(a.workingDirectory) || undefined,
      profileId: str(a.profileId) || undefined,
      useWorktree: a.useWorktree === true || undefined,
      sourceBranch: str(a.sourceBranch) || undefined,
      clientCmdId,
    })
    if (tabId) await notifyTabCreated(tabId, clientCmdId)
    return { tabId }
  }),

  // [{ workingDirectory?, clientCmdId? }] -> { tabId: string | null }. A terminal-only tab with its first shell, under the same rules.
  'tabs.createTerminal': wrap('tabs.createTerminal', 'terminal:operate', async (a) => {
    const clientCmdId = str(a.clientCmdId) || undefined
    const tabId = await createTerminalTabForClient({ workingDirectory: str(a.workingDirectory) || undefined, clientCmdId })
    if (tabId) await notifyTabCreated(tabId, clientCmdId)
    return { tabId }
  }),

  // [{ tabId }] -> { closed, blocked, orchestratorRunning, agentCount, shellCount }
  // Refuses while the conversation has work in flight, and says what is
  // running. The store's own `closeTab` asks no such question: Studio asks
  // it first, through `requestCloseTab`, and a client with no such step
  // closes through here.
  'tabs.close': wrap('tabs.close', 'conversations:operate', (a) => closeTabGuarded(requireTab(a)), tabAt),

  // [{ tabId, messageId }] -> { tabId, pendingInput } | null. The new tab and the draft the fork seeded it with.
  'session.forkFromMessage': wrap('session.forkFromMessage', 'conversations:operate', (a) => {
    const messageId = str(a.messageId)
    if (!messageId) throw new Declined('messageId is required')
    return forkConversationFromMessage(requireTab(a), messageId)
  }, tabAt),

  // [{ tabId, instanceId, messageId, userTurnIndex? }] -> { ok, error?, pendingInput? }. `pendingInput` is the rewound turn's text.
  'engine.rewind': wrap('engine.rewind', 'conversations:operate', (a) => {
    const instanceId = str(a.instanceId)
    const messageId = str(a.messageId)
    if (!instanceId || !messageId) throw new Declined('instanceId and messageId are required')
    return rewindConversationInstance(requireTab(a), instanceId, messageId, typeof a.userTurnIndex === 'number' ? a.userTurnIndex : null)
  }, tabAt),

  // [{ tabId, instanceId }] -- STOPS the engine session, then wipes the
  // instance's state. The store's `resetEngineInstance` only aborts the run,
  // which leaves the session and its context alive.
  'engine.resetInstance': wrap('engine.resetInstance', 'conversations:operate', async (a) => {
    const instanceId = str(a.instanceId)
    if (!instanceId) throw new Declined('instanceId is required')
    await handleResetEngineSession({ type: 'desktop_reset_engine_session', tabId: requireTab(a), instanceId })
    return true
  }, tabAt),

  // [{ tabId }] -- a bare engine abort with no scope and no session-plane
  // bookkeeping. `interrupt` is the scoped stop a person presses.
  'engine.abort': wrap('engine.abort', 'conversations:operate', (a) => {
    handleEngineAbort({ type: 'desktop_engine_abort', tabId: requireTab(a) })
    return true
  }, tabAt),

  // [{ tabId, questionId, instanceId?, clearContext? }] -- approve the plan a
  // named ExitPlanMode question carries and start implementing it. The plan
  // body never crosses the wire: the server reads it from disk.
  'session.implementPlan': wrap('session.implementPlan', 'conversations:operate', async (a) => {
    const questionId = str(a.questionId)
    if (!questionId) throw new Declined('questionId is required')
    await handleImplementPlan({ type: 'desktop_implement_plan', tabId: requireTab(a), questionId, instanceId: str(a.instanceId) || undefined, clearContext: a.clearContext === true })
    return true
  }, tabAt),

  // [{ repoPath }] -- the mechanical bulk sync, never the AI-gated pipeline.
  // The outcome and the refreshed state are published as events, as for every worktree verb.
  'worktree.syncAll': wrap('worktree.syncAll', 'git:write', async (a) => {
    const repoPath = str(a.repoPath)
    if (!repoPath) throw new Declined('repoPath is required')
    return handleWorktreeCommand({ type: 'desktop_worktree_sync_all', repoPath })
  }),

  // Settings, the client's own diagnostic log, and the terminal pane (`parity-client-actions.ts`).
  ...PARITY_CLIENT_ACTIONS,
}
