/**
 * HostApi engine domain — the server-side replacement for the desktop
 * preload's `window.ion.engine*` / `window.ion.prompt`/`steer` contextBridge
 * calls, plus tab lifecycle.
 *
 * Every function delegates to the SAME underlying implementation the
 * desktop's `ipcMain.handle` registrations called (`engineBridge`,
 * `sessionPlane`) — behavior is unchanged, only the transport is removed.
 * See `host-api-git.ts` and `host-api-misc.ts` for the other domains; split
 * at the file-size cap.
 */
import {
  activeAssistantMessages,
  engineBridge,
  extensionCommandRegistry,
  lastForwardedTabMeta,
  lastForwardedTabStatus,
  lastMessagePreview,
  sessionPlane,
} from '../state'
import { isValidProjectPath } from '../ipc-validation'
import { listBranches, switchBranch } from '../engine/engine-bridge-conversations'
import type { ConversationBranches } from '@ion/shared/conversation-branches'
import type { Attachment, RunOptions, SteerMeta } from '@ion/shared/types'
import type { ModelEntry, ProviderEntry } from '@ion/shared/types-models'
import type { RelocateResult } from '../engine/engine-control-plane-relocate'
import { echoUserTurn } from '../user-turn-echo'
import { parseSlash } from '../slash-parse'
import { getAutomationRuntime } from '../automation/runtime'
import { emitFreshMessageSubmitted, emitSteerMessageSubmitted } from '../engine/session-message-automation'
import { settlePromptDelivery, takeRemotePromptDelivery } from '../remote/prompt-delivery'
import { startPromptHandleSpan, traceFields } from '../tracing/prompt-span'
import type { Span } from '@ion/shared/trace-context'
import type { IncomingPrompt } from '../engine/prompt-pipeline'
import { log as _log, warn as _warn, debug as _debug } from '../logger'
import { sendRemoteEvent, remoteClientsPresent } from '../thin-view/remote-out'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('host-api-engine', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('host-api-engine', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('host-api-engine', msg, fields)
}

/**
 * Tell every paired device a tab now exists, immediately rather than on the
 * next structural snapshot tick. The tab record is read back through the
 * same projection the snapshot uses so the device sees the identical shape.
 */
function notifyRemoteTabCreated(tabId: string, origin: 'create_tab' | 'adopt_tab'): void {
  if (!remoteClientsPresent()) return
  void import('../remote/snapshot')
    .then(({ getRemoteTabStates }) => getRemoteTabStates())
    .then(({ tabs }) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab) sendRemoteEvent({ type: 'desktop_tab_created', tab })
      // Expected on every restored tab: adoption precedes the store's record,
      // and the structural snapshot carries it. Debug, not a boot-time flood.
      else debug('tab absent from the remote projection, no tab-created push', { origin, tab_id: tabId })
    })
    .catch((err) => warn('remote tab-created notify failed', { origin, tab_id: tabId, error: String(err) }))
}

export function engineStart(key: string, config: import('@ion/shared/types').EngineConfig) {
  if (config.sessionId) sessionPlane.seedConversationId(key, config.sessionId)
  return engineBridge.startSession(key, config)
}

export function engineAbort(key: string, scope?: import('@ion/shared/types-engine').AbortScope): Promise<void> {
  const resolved = scope === 'orchestrator' || scope === 'all_work' ? scope : 'all'
  engineBridge.sendAbort(key, resolved)
  return Promise.resolve()
}

export function engineAbortDispatch(key: string, dispatchId: string): Promise<void> {
  // A blank id addresses nothing and the engine rejects it; drop it here so
  // the reason is visible on this side too.
  if (typeof dispatchId !== 'string' || dispatchId.trim() === '') {
    warn('engine_abort_dispatch: rejecting empty dispatchId', { key })
    return Promise.resolve()
  }
  log('engine_abort_dispatch', { key, dispatch_id: dispatchId })
  engineBridge.sendAbortDispatch(key, dispatchId)
  return Promise.resolve()
}

export async function engineStopBackgroundTask(key: string, taskId: string): Promise<{ ok: boolean; error?: string; status?: string }> {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    warn('engine_stop_background_task: rejecting empty taskId', { key })
    return { ok: false, error: 'taskId is required' }
  }
  log('engine_stop_background_task', { key, task_id: taskId })
  const result = await engineBridge.stopBackgroundTask(key, taskId)
  if (!result.ok) warn('engine_stop_background_task: engine rejected request', { key, task_id: taskId, error: result.error ?? 'unknown error' })
  else log('engine_stop_background_task: completed', { key, task_id: taskId, status: result.status ?? 'unknown' })
  return result
}

/**
 * Tree-native rewind: move the conversation leaf to the parent of the given
 * entry so the next prompt replaces it on the active path. Rejects on an
 * unknown entry, which is expected when the rewound session got a genuinely
 * fresh conversation instead of a rebound one.
 */
export function engineBranchBefore(key: string, entryId: string): Promise<void> {
  log('engine_branch_before', { key, entry_id: entryId })
  return engineBridge.branchSessionBefore(key, entryId)
}

/** Every branch of the conversation behind `key` (the tab id). */
export function engineListBranches(key: string): Promise<ConversationBranches> {
  return listBranches(engineBridge, key)
}

/** Moves the conversation onto the branch ending at `leafId`; the transcript reload rides `engine_active_path_changed`. */
export function engineSwitchBranch(key: string, leafId: string): Promise<void> {
  return switchBranch(engineBridge, key, leafId)
}

export function engineRemapSession(oldKey: string, newKey: string): void {
  log('engine_remap_session', { old_key: oldKey, new_key: newKey })
  engineBridge.remapSession(oldKey, newKey)
}

export function engineDialogResponse(key: string, dialogId: string, value: unknown): Promise<void> {
  return engineBridge.sendDialogResponse(key, dialogId, value)
}

export function engineStop(key: string): Promise<void> {
  return engineBridge.stopSession(key)
}

export function engineRewind(key: string, target: { entryId?: string; userTurnIndex?: number }) {
  return engineBridge.rewindSession(key, target)
}

export function engineFork(key: string, newKey: string, target: { messageIndex: number; entryId?: string; userTurnIndex?: number }) {
  return sessionPlane.forkSession(key, newKey, target)
}

export function engineSetPlanMode(key: string, enabled: boolean, planFilePath?: string): void {
  const safe = planFilePath && isValidProjectPath(planFilePath) ? planFilePath : undefined
  engineBridge.sendSetPlanMode(key, enabled, undefined, 'prompt_sync', undefined, safe)
}

export function setPermissionMode(tabId: string, mode: string, source?: string, planFilePath?: string): void {
  if (mode !== 'auto' && mode !== 'plan') return
  const safe = planFilePath && isValidProjectPath(planFilePath) ? planFilePath : undefined
  sessionPlane.setPermissionMode(tabId, mode, source, safe)
}

export function resolvePermissionDenials(tabId: string): void {
  sessionPlane.resolvePermissionDenials(tabId)
}

export async function engineBroadcastHistory(tabId: string, instanceId: string | null, opts?: { queueUntilTabExists?: boolean }): Promise<void> {
  log('engine_broadcast_history', { tab_id: tabId, instance_id: instanceId || '', queue_until_tab_exists: opts?.queueUntilTabExists ?? false })
  const { readEngineHistoryFromStore } = await import('../remote/handlers/engine-history')
  // Every attached Studio client replaces the instance's messages wholesale
  // (`studio:history-replace`), read from the one now-truncated store. A thin
  // client receives the same truncation as a transcript patch.
  const { notifyStudioHistoryReplace } = await import('../engine/studio-window-manager')
  const { instanceId: resolvedInstanceId, messages } = readEngineHistoryFromStore(tabId, instanceId)
  notifyStudioHistoryReplace({ tabId, instanceId: resolvedInstanceId, messages, ...opts })
}

/**
 * Lists this server's models. `_environmentId` is accepted so the store's
 * per-Environment fetch has one signature in both processes: the server
 * process holds exactly one engine, so the hint is informational here; the
 * renderer's stub routes it to the named Environment's server.
 */
export async function listModels(_environmentId?: string): Promise<{ models: ModelEntry[]; providers: ProviderEntry[] }> {
  const { listModels: bridgeListModels } = await import('../engine/engine-bridge-providers')
  return bridgeListModels(engineBridge)
}

export async function resolveModelTier(tier: string) {
  const { resolveModelTier: bridgeResolveModelTier } = await import('../engine/engine-bridge-providers')
  return bridgeResolveModelTier(engineBridge, tier)
}

/** Cancels an in-flight delegated-CLI login on this server (`_environmentId`: see listModels). */
export async function providerLoginCancel(provider: string, _environmentId?: string) {
  const { providerLoginCancel: bridgeCancel } = await import('../engine/engine-bridge-providers')
  return bridgeCancel(engineBridge, provider)
}

export function createTab(): { tabId: string } {
  const tabId = sessionPlane.createTab()
  log('create_tab', { tab_id: tabId })
  notifyRemoteTabCreated(tabId, 'create_tab')
  return { tabId }
}

/**
 * Register a tab under a caller-supplied (persisted) id instead of minting
 * one, so the session key is invariant across restarts and the engine
 * binding store hits. Idempotent: an existing entry is preserved.
 */
export function adoptTab(tabId: string): { tabId: string } {
  const adopted = sessionPlane.adoptTab(tabId)
  log('adopt_tab', { tab_id: adopted })
  notifyRemoteTabCreated(adopted, 'adopt_tab')
  return { tabId: adopted }
}

export async function closeTab(tabId: string): Promise<void> {
  log('close_tab', { tab_id: tabId })
  sessionPlane.closeTab(tabId)
  const { terminalManager } = await import('../terminal/terminal-manager-instance')
  terminalManager.destroyByPrefix(`${tabId}:`)
  // Conversations key their engine session by the bare tabId (ADR-010), so
  // that session is stopped directly; stopByPrefix only matches compound
  // keys (terminals, legacy `${tabId}:main`).
  engineBridge.stopSession(tabId).catch((err: unknown) => warn('close_tab: stop session failed', { tab_id: tabId, error: String(err) }))
  engineBridge.stopByPrefix(`${tabId}:`)

  if (remoteClientsPresent()) sendRemoteEvent({ type: 'desktop_tab_closed', tabId })

  // Every per-tab process-level record, or the maps grow for the life of the
  // server.
  activeAssistantMessages.delete(tabId)
  lastMessagePreview.delete(tabId)
  lastForwardedTabStatus.delete(tabId)
  lastForwardedTabMeta.delete(tabId)
  const { evictStudioTab } = await import('../engine/studio-state-cache')
  evictStudioTab(tabId)
  for (const key of extensionCommandRegistry.keys()) {
    if (key === tabId || key.startsWith(`${tabId}:`)) extensionCommandRegistry.delete(key)
  }
  const { composerActionsBoard } = await import('../engine/composer-actions-wiring')
  composerActionsBoard.forgetTab(tabId)
}

export function stopTab(tabId: string): Promise<boolean> {
  return Promise.resolve(sessionPlane.cancelTab(tabId))
}

export function resetTabSession(tabId: string): void {
  sessionPlane.resetTabSession(tabId)
}

export function relocateTabSession(tabId: string, workingDirectory: string): Promise<RelocateResult> {
  if (!isValidProjectPath(workingDirectory)) {
    return Promise.resolve({ ok: false, error: `Invalid working directory: ${workingDirectory}` })
  }
  return sessionPlane.relocateSession(tabId, workingDirectory)
}

export function ensureEngineSession(args: { tabId: string; workingDirectory: string; conversationId?: string | null; permissionMode?: 'auto' | 'plan'; extensions?: string[] }) {
  return sessionPlane.ensureSession(args.tabId, {
    workingDirectory: args.workingDirectory,
    conversationId: args.conversationId,
    permissionMode: args.permissionMode,
    extensions: args.extensions,
  })
}

export async function prompt(tabId: string, requestId: string, options: RunOptions): Promise<void> {
  if (!tabId) throw new Error('No tabId provided — prompt rejected')
  if (!requestId) throw new Error('No requestId provided — prompt rejected')

  // A prompt a client submitted is acknowledged to THAT submitter once the
  // pipeline admits it (or rejected with the reason), so its composer clears
  // -- or keeps the text -- on a real outcome.
  const remoteDelivery = takeRemotePromptDelivery(requestId)
  // The server's hop in the prompt's trace. A submitter that registered a
  // delivery already opened prompt.handle and ends it itself; any other
  // prompt (Studio's submit, a server-originated turn) opens it here, as a
  // child of the client's span when the client sent one.
  const handleSpan = remoteDelivery?.traceparent
    ? undefined
    : startPromptHandleSpan({
        traceparent: options.traceparent,
        tabId,
        requestId,
        surface: options.source === 'remote' || options.source === 'machine' ? options.source : 'studio',
        conversationId: options.sessionId,
      })
  // From here on the traceparent names the server's span. The engine
  // bridge opens its engine.send_prompt call span under it, and the engine's
  // run is that call's child.
  options.traceparent = remoteDelivery?.traceparent ?? handleSpan?.traceparent
  const trace = traceFields(options.traceparent)
  log('prompt', { tab_id: tabId, request_id: requestId, ...trace })

  const slash = parseSlash(options.prompt)
  const permissionMode = typeof sessionPlane.getTabStatus === 'function' ? (sessionPlane.getTabStatus(tabId)?.permissionMode ?? '') : ''
  const promptPayload = {
    tabId,
    requestId,
    deliveryId: options.deliveryId ?? requestId,
    prompt: options.prompt,
    promptLength: options.prompt.length,
    source: options.source ?? 'desktop',
    projectPath: options.projectPath,
    worktreePath: options.projectPath,
    permissionMode,
    isSlash: !!slash,
    slashCommand: slash?.command ?? '',
    slashArgs: slash?.args ?? '',
  }

  if (!sessionPlane.hasTab(tabId)) {
    log('prompt: tab not found, auto-registering', { tab_id: tabId, ...trace })
    sessionPlane.ensureTab(tabId)
  }

  const { processIncomingPrompt } = await import('../engine/prompt-pipeline')
  try {
    // Source is always 'desktop' at the pipeline: this is the sink of the
    // remote → store → here roundtrip, and the store has already done the
    // optimistic insert; forwarding 'remote' would re-broadcast the message
    // and never submit. The automation payload keeps the real source.
    const incoming: IncomingPrompt = {
      tabId,
      text: options.prompt,
      displayText: options.displayText,
      publishUserTurn: options.publishUserTurn,
      reqId: requestId,
      source: 'desktop',
      attachments: options.rawAttachments,
      hasExtensions: (options.extensions?.length ?? 0) > 0,
      projectPath: options.projectPath,
      runOptions: options,
      resolveSlash: options.resolveSlash,
      traceparent: options.traceparent,
    }
    await processIncomingPrompt(incoming)
    endHandleSpan(handleSpan, incoming.engineOutcome)
    await getAutomationRuntime().trigger({ type: 'prompt:submitted', payload: promptPayload }, options.automationCausation)
    // The one authorship-classified submission fact: fires for every admitted
    // client Message and carries messageKind + isSteer so a rule can target
    // only real operator prompts. A mid-run Steer emits the same from `steer`.
    await emitFreshMessageSubmitted({
      tabId,
      requestId,
      clientMessageId: options.deliveryId ?? requestId,
      projectPath: options.projectPath,
      permissionMode,
      source: options.source,
      messageKind: options.messageKind,
      injectionKind: options.injectionKind,
      isSlash: !!slash,
      causation: options.automationCausation,
    })
    if (slash) {
      await getAutomationRuntime().trigger({ type: 'conversation:slash', payload: promptPayload }, options.automationCausation)
    }
    if (remoteDelivery) settlePromptDelivery(remoteDelivery, requestId, { accepted: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    handleSpan?.end({ accepted: false }, msg)
    warn('prompt: error', { tab_id: tabId, request_id: requestId, error: msg, ...trace })
    if (remoteDelivery) settlePromptDelivery(remoteDelivery, requestId, { accepted: false, reason: msg })
    throw err
  }
}

/**
 * Ends the prompt.handle span this call opened, with what the engine answered
 * when the prompt reached it. A prompt the pipeline handled without the
 * engine (a command the engine ran, a shell line) has no engine outcome.
 */
function endHandleSpan(span: Span | undefined, engine: IncomingPrompt['engineOutcome']): void {
  if (!span) return
  if (!engine) {
    span.end({ accepted: true, engine_dispatched: false })
    return
  }
  span.end({ accepted: engine.ok, engine_dispatched: true }, engine.ok ? undefined : engine.error ?? 'the engine did not accept the prompt')
}

/**
 * Publish the optimistic user bubble the owner store just inserted to every
 * Studio mirror. A Studio client forwards `submit` here and inserts nothing
 * itself, and user turns never ride engine events, so without this echo the
 * operator's own message is missing from the transcript that shows the
 * assistant's reply to it.
 */
export function echoUserTurnToStudio(echo: { tabId: string; id: string; content: string; timestamp: number; implementationPhase?: boolean; injectionKind?: string; attachments?: Attachment[] }): void {
  const { attachments, ...rest } = echo
  echoUserTurn({ ...rest, studioAttachments: attachments })
}

export function steer(tabId: string, message: string, clientMessageId?: string, meta?: SteerMeta): void {
  // An unregistered steer is a bug in the caller: log and drop rather than
  // dispatch a steer_agent command against a key with no backing session.
  if (!sessionPlane.hasTab(tabId)) {
    log('steer: not registered, dropping', { tab_id: tabId, len: message.length })
    return
  }
  log('steer', { tab_id: tabId, len: message.length, client_message_id: clientMessageId ?? '' })
  engineBridge.sendSteer(tabId, message, clientMessageId)
  // A mid-run human Steer is an admitted client Message too: the same
  // authorship-classified automation fact as a fresh prompt, with isSteer.
  emitSteerMessageSubmitted({
    tabId,
    message,
    clientMessageId,
    meta,
    permissionMode: typeof sessionPlane.getTabStatus === 'function' ? (sessionPlane.getTabStatus(tabId)?.permissionMode ?? '') : '',
  })
}

export function respondPermission(tabId: string, questionId: string, optionId: string): Promise<void> {
  return engineBridge
    .sendCommand({ key: tabId, text: '' }, 'respond_permission', JSON.stringify({ questionId, optionId }))
    .then(() => undefined)
}
