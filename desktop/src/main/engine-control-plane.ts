import { EventEmitter } from 'events'
import { EngineBridge } from './engine-bridge'
import { resolveRemoteWorkingDirectory } from './engine-control-plane-remote-dir'
import { log as _log, warn as _warn, error as _error } from './logger'
import { handleEngineEvent, type TabEntry } from './engine-control-plane-events'
import {
  makeEmptyTab, registerNewTab, registerAdoptedTab, resetTabEntry, restartTabEntry,
  closeTabEntry, markConversationCleared,
} from './engine-control-plane-tab'
import { relocateTabSession, type RelocateResult } from './engine-control-plane-relocate'
import { reconcileSessionWorkingDirectory } from './engine-control-plane-cwd'
import { sendPromptWithRecovery, bridgeSendAdapter } from './engine-control-plane-send'
import { buildHealthReport, anyTabRunning, resyncStatus, applyStatus, type StatusEmit } from './engine-control-plane-status'
import { cancelRequest, cancelTabRun, abortTabDispatch } from './engine-control-plane-cancel'
import * as historyReads from './engine-control-plane-history'
import { dispatchOrderingBaseline } from './engine-control-plane-idle-ordering'
import { resolveSessionThinkingConfig } from './settings-store'
import { resolveClaudeCompat, resolveRunRecoveryConfig } from './engine-control-plane-config'
import { toolGateSessionConfig } from './tool-gate-responder'
import { benchClientWorkspaceContext } from './integration/bench-prompt-context'
import {
  respondToPermission as respondToPermissionImpl,
  respondToElicitation as respondToElicitationImpl,
} from './engine-control-plane-dialog-response'
import { installRecoveredAgentStateListener, makeEventContext } from './engine-control-plane-recovered-agent-state'
import { installAbortDeliveredListener, installReconnectResetListener } from './engine-control-plane-reconnect'
import { makeDrainLatch, drain as drainImpl, checkDrain, shutdown as shutdownImpl } from './engine-control-plane-drain'
import { resolvePermissionDenials as resolvePermissionDenialsImpl } from './engine-control-plane-resolve-denials'
import type {
  EngineConfig,
  ThinkingConfig,
  EngineEvent,
  RunOptions,
  TabStatus,
  HealthReport,
  EnrichedError,
} from '../shared/types'
import type { AbortScope } from '../shared/types-engine'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error(TAG, msg, fields) }

/**
 * EngineControlPlane wraps EngineBridge to present the same public API
 * as the ControlPlane interface.
 *
 * All prompts route through the Ion engine daemon via Unix socket.
 *
 * Events emitted:
 *  - 'event' (tabId, NormalizedEvent)
 *  - 'tab-status-change' (tabId, newStatus, oldStatus)
 *  - 'error' (tabId, EnrichedError)
 *  - 'remote-permission' (tabId, data)
 */
export class EngineControlPlane extends EventEmitter {
  private bridge: EngineBridge
  private tabs = new Map<string, TabEntry>()
  private drainLatch = makeDrainLatch()

  constructor(bridge: EngineBridge) {
    super()
    this.bridge = bridge

    this.bridge.on('event', (key: string, event: EngineEvent) => {
      const tab = this.tabs.get(key)
      if (!tab) return
      handleEngineEvent(makeEventContext(this.bridge, (eventName, ...args) => this.emit(eventName, ...args), (tabId, newStatus) => this._setStatus(tabId, newStatus), () => this._checkDrain()), key, tab, event)
    })

    installRecoveredAgentStateListener(this.bridge, this.tabs, () => makeEventContext(this.bridge, (eventName, ...args) => this.emit(eventName, ...args), (tabId, newStatus) => this._setStatus(tabId, newStatus), () => this._checkDrain()))

    installAbortDeliveredListener(this.bridge, this.tabs, (tabId, newStatus) => this._setStatus(tabId, newStatus))
    installReconnectResetListener(this.bridge, this.tabs)
  }

  createTab(): string {
    return registerNewTab(this.tabs)
  }

  /**
   * Register a tab under a persisted, durable id (restore path) instead of
   * minting one, so the session key is invariant across restarts. See
   * registerAdoptedTab in engine-control-plane-tab.ts.
   */
  adoptTab(tabId: string): string {
    return registerAdoptedTab(this.tabs, tabId)
  }

  hasTab(tabId: string): boolean {
    return this.tabs.has(tabId)
  }

  ensureTab(tabId: string): void {
    if (!this.tabs.has(tabId)) {
      log('ensure_tab: creating missing tab', { tab_id: tabId })
      this.tabs.set(tabId, makeEmptyTab(tabId))
    }
  }

  initSession(tabId: string): void {
    this.ensureTab(tabId)
  }

  resetTabSession(tabId: string): void {
    resetTabEntry(this.tabs, tabId, (id) => { void this.bridge.stopSession(id).catch((err) => warn('reset_tab: stop session failed', { tab_id: id, error: String(err) })) })
  }

  /**
   * Power-cycle a tab's engine session WITHOUT cutting a new conversation
   * (preserves conversationId). The correct primitive for stuck-tab recovery.
   * See restartTabEntry in engine-control-plane-tab.ts.
   */
  restartTabSession(tabId: string): void {
    restartTabEntry(this.tabs, tabId, (id) => { void this.bridge.stopSession(id).catch((err) => warn('restart_tab: stop session failed', { tab_id: id, error: String(err) })) })
  }

  /**
   * Move a LIVE conversation to a different working directory, preserving
   * `conversationId` and its full history. Composed from restartTabSession +
   * ensureSession; see engine-control-plane-relocate.ts for the rationale and
   * why this is a consumer-side composition rather than an engine change.
   *
   * This is the primitive that lets a conversation outlive its worktree.
   */
  relocateSession(tabId: string, workingDirectory: string): Promise<RelocateResult> {
    return relocateTabSession(this.tabs, tabId, workingDirectory, {
      restartSession: (id) => this.restartTabSession(id),
      ensureSession: (id, opts) => this.ensureSession(id, opts),
    })
  }

  closeTab(tabId: string): void {
    closeTabEntry(this.tabs, tabId, (id) => {
      this.bridge.stopSession(id).catch((err) => warn('close_tab: stop session failed', { tab_id: id, error: String(err) }))
    })
  }

  /** See markConversationCleared in engine-control-plane-tab.ts. */
  notifyConversationCleared(tabId: string): void {
    markConversationCleared(this.tabs, tabId)
  }

  /**
   * A pending plan/question card was resolved in the client (dismissed,
   * answered, or approved via Implement). Releases BOTH retentions that would
   * otherwise keep re-offering it — the engine's and this control plane's
   * surfaced-proposal latch. See engine-control-plane-resolve-denials.ts for
   * why clearing only one leaves the defect in place.
   */
  resolvePermissionDenials(tabId: string): void {
    resolvePermissionDenialsImpl(this.bridge, this.tabs, tabId)
  }

  /**
   * Seed a tab's tracked conversationId before its engine session starts.
   *
   * The extension-hosted restore path starts the engine via the ENGINE_START
   * IPC, which calls EngineBridge.startSession directly and bypasses
   * ensureSession (the plain-tab start site that already seeds conversationId at
   * engine-control-plane.ts ~218). Without this seed the control-plane TabEntry
   * for a freshly-restored extension tab has no conversationId, so the
   * engine_status first-bind branch in handleStatusEvent adopts whatever id the
   * engine emits — including an empty pre-minted id on a restore that failed to
   * supply one. Seeding the real id here ARMS the divergence guard so a
   * post-restart pre-mint idle is rejected (resume-driven) instead of adopted.
   *
   * Only seeds when the tab currently has no conversationId, so it never
   * clobbers an already-tracked id (idempotent; a no-op on warm starts).
   */
  seedConversationId(tabId: string, conversationId: string): void {
    if (!conversationId) return
    this.ensureTab(tabId)
    const tab = this.tabs.get(tabId)!
    if (tab.conversationId) {
      log('seed_conversation_id: already tracks, ignoring', { tab_id: tabId, tracked: tab.conversationId, seed: conversationId })
      return
    }
    tab.conversationId = conversationId
    // A caller-supplied id means we are resuming a SAVED conversation, not a
    // fresh mint. Mark it so the slash plan→auto freshness guard treats the
    // next prompt as resumed (scenario B), not fresh (scenario C). See the
    // resumedSavedConversation doc in engine-control-plane-events.ts.
    tab.resumedSavedConversation = true
    log('seed_conversation_id: seeded', { tab_id: tabId, conversation_id: conversationId })
  }

  setPermissionMode(tabId: string, mode: 'auto' | 'plan', source?: string, planFilePath?: string): void {
    this.ensureTab(tabId)
    const tab = this.tabs.get(tabId)!
    tab.permissionMode = mode
    // The plan-mode Bash allowlist is ENGINE POLICY: the engine resolves it
    // fresh from engine.json (limits.planModeAllowedBashCommands) at each
    // prompt dispatch. The desktop no longer pushes a session-scoped override
    // here — doing so would clobber the operator's engine.json and defeat the
    // headless-consumer contract. We always pass undefined ("no change") for
    // the allowlist; the wire field on set_plan_mode is kept for external
    // consumers that still choose to push one.
    // planFilePath restores plan-file continuity when ENTERING plan mode: the
    // engine re-adopts this path (if it exists on disk) so the next prompt
    // reuses the conversation's existing plan instead of allocating a fresh
    // slug. Only forwarded on 'plan'; the engine ignores it on disable.
    const restorePath = mode === 'plan' ? planFilePath : undefined
    this.bridge.sendSetPlanMode(tabId, mode === 'plan', undefined, source, undefined, restorePath)
  }

  approveToolsForTab(tabId: string, toolNames: string[]): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    for (const t of toolNames) {
      if (!tab.approvedTools.includes(t)) {
        tab.approvedTools.push(t)
      }
    }
  }

  /**
   * Idempotent single entry point that guarantees a live engine session
   * exists for a normal (non-engine-extension) tab. Starts the engine session
   * if it is not already started, injecting the tracked conversationId as
   * `sessionId` so the engine RESUMES the same conversation under the same key
   * instead of minting a fresh session identity. A no-op when the session is
   * already started.
   *
   * This is the unification seam: both the lazy first-prompt path
   * (submitPrompt) and the eager restore/open path call this, so a normal tab
   * has exactly one start site and one stable key for its whole life — the
   * same lifecycle engine tabs already get. Eager start on restore means a
   * reopened conversation is immediately clearable and (for engine tabs)
   * background-job capable, instead of being a sessionless shell until the
   * first prompt.
   *
   * Every branch logs with the tab id, conversationId, and outcome so the
   * session-identity lifecycle is reconstructable from ~/.ion/desktop.log.
   */
  async ensureSession(
    tabId: string,
    opts: {
      workingDirectory: string
      conversationId?: string | null
      permissionMode?: 'auto' | 'plan'
      extensions?: string[]
      model?: string
      maxTokens?: number
      thinking?: ThinkingConfig
    },
  ): Promise<{ ok: boolean; error?: string }> {
    this.ensureTab(tabId)
    const tab = this.tabs.get(tabId)!

    // Seed tracked conversationId from the caller when the tab has none yet
    // (restore path supplies the persisted id). This is what makes the resume
    // stable: the same conversationId flows into config.sessionId on every
    // start for this tab.
    if (opts.conversationId && !tab.conversationId) {
      tab.conversationId = opts.conversationId
      // Caller supplied the id → resuming a saved conversation (scenario B).
      // Mark it so the slash plan→auto freshness guard treats this as resumed,
      // not as a fresh mint. See resumedSavedConversation in
      // engine-control-plane-events.ts.
      tab.resumedSavedConversation = true
      log('ensure_session: seeded tracked conversationId from caller', { tab_id: tabId, conversation_id: opts.conversationId })
    }
    if (opts.permissionMode) tab.permissionMode = opts.permissionMode

    if (tab.engineSessionStarted) {
      log('ensure_session: already started, no-op', { tab_id: tabId, conversation_id: tab.conversationId ?? '' })
      // Still re-assert the status. A caller that reached this branch has an
      // optimistic 'connecting' on its own tab and no transition is coming.
      this._resyncStatus(tabId, 'ensure_session_already_started')
      return { ok: true }
    }

    const config: EngineConfig = {
      profileId: 'default',
      extensions: opts.extensions || [],
      workingDirectory: opts.workingDirectory,
      sessionId: opts.conversationId || tab.conversationId || undefined,
      model: opts.model,
      maxTokens: opts.maxTokens,
      // Session thinking default. Resolved HERE rather than threaded from the
      // caller so every start site gets it — the relocate, cwd-reconcile, and
      // eager-restore paths all call ensureSession without a thinking opinion,
      // and a caller-threaded value would silently omit it on those three. An
      // explicit opts.thinking still wins for a caller that has one.
      thinking: opts.thinking ?? resolveSessionThinkingConfig(),
      claudeCompat: resolveClaudeCompat(),
      // Desktop preference owns plain desktop conversations. Extension-backed
      // sessions keep the engine default until their harness selects policy.
      ...(opts.extensions?.length ? {} : { runRecovery: resolveRunRecoveryConfig() }),
      // Client tool gate: bench containment policy + bench client tools. Declared
      // on every session because bench involvement can begin mid-session; policy
      // resolves the workspace fresh per call.
      toolGate: toolGateSessionConfig(),
      clientWorkspaceContext: benchClientWorkspaceContext(opts.workingDirectory) ?? undefined,
    }
    log('ensure_session: starting', { tab_id: tabId, session_id: config.sessionId ?? 'new', dir: config.workingDirectory, client_ws_ctx: config.clientWorkspaceContext?.kind ?? 'none' })
    const result = await this.bridge.startSession(tabId, config)
    if (!result.ok) {
      error('ensure_session: startSession failed', { tab_id: tabId, error: result.error })
      return result
    }
    tab.engineSessionStarted = true
    // Capture the engine-minted conversation id at start time. The engine binds
    // the id inside StartSession and returns it in the start_session result, so
    // it is available before any run emits session_init/engine_status. Recording
    // it here (when the tab has none yet) makes the snapshot and the divergence
    // guard see the real id immediately — mirrors the engine_status capture in
    // engine-control-plane-events.ts. Only set when unset so a later
    // engine_status with the same id is a no-op and a resume keeps the tracked id.
    if (result.conversationId && !tab.conversationId) {
      tab.conversationId = result.conversationId
      // Deliberately do NOT set tab.resumedSavedConversation here: this is an
      // engine-MINTED id for a brand-new session (scenario C), not a resume.
      // Leaving the flag false keeps a first-prompt slash command fresh so it
      // flips plan→auto. See resumedSavedConversation in
      // engine-control-plane-events.ts.
      log('ensure_session: captured minted conversationId', { tab_id: tabId, conversation_id: result.conversationId })
    }
    log('ensure_session: live', { tab_id: tabId, conversation_id: tab.conversationId ?? '' })
    // The session is online: re-assert the plane's status so no consumer is left
    // holding an optimistic 'connecting' that no transition will ever clear.
    this._resyncStatus(tabId, 'ensure_session_live')
    if (tab.permissionMode === 'plan') {
      this.bridge.sendSetPlanMode(tabId, true, undefined, 'session_start')
    }
    return result
  }

  async submitPrompt(tabId: string, requestId: string, options: RunOptions): Promise<{ ok: boolean; error?: string; data?: { accepted?: boolean; alreadyAccepted?: boolean } }> {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      warn('submit_prompt: unknown tab', { tab_id: tabId })
      return { ok: false, error: 'Unknown tab' }
    }

    log('submit_prompt', { tab_id: tabId, request_id: requestId, model: options.model ?? 'default', session_id: options.sessionId ?? 'new', prompt_count: tab.promptCount + 1 })
    tab.activeRequestId = requestId
    // Ordering baseline for the false-completion guard: where the engine's run
    // counter stood BEFORE this prompt, and a cleared acknowledgement. See
    // engine-control-plane-idle-ordering.ts.
    Object.assign(tab, dispatchOrderingBaseline(tab.lastObservedRunEpoch))
    log('submit_prompt: ordering baseline', { tab_id: tabId, request_id: requestId, dispatch_run_epoch: tab.dispatchRunEpoch ?? -1 })
    tab.lastActivityAt = Date.now()
    tab.startedAt = Date.now()
    tab.toolCallCount = 0
    tab.sawPermissionRequest = false
    tab.promptCount++
    // Mirror increment: the freshness checkpoint moves with every prompt
    // submission. The two counters only diverge when /clear advances the
    // checkpoint without resetting the lifetime prompt counter.
    tab.promptCountSinceCheckpoint++
    tab.clearedSinceLastPrompt = false

    this._setStatus(tabId, 'connecting')

    const config: EngineConfig = {
      profileId: 'default',
      extensions: options.extensions || [],
      workingDirectory: options.projectPath,
      sessionId: options.sessionId || tab.conversationId || undefined,
      maxTokens: options.maxTokens,
      // Same resolution as ensureSession: this config is what the send path
      // hands ensureSession, so it must carry the session default too or a
      // first-prompt start would omit what a later relocate would include.
      thinking: options.thinking ?? resolveSessionThinkingConfig(),
      claudeCompat: resolveClaudeCompat(),
      // Same gate declaration as ensureSession so this start path has bench rules.
      toolGate: toolGateSessionConfig(),
    }

    // When the engine is remote, verify the working directory exists on the
    // ENGINE host before starting — see engine-control-plane-remote-dir.ts.
    // Resolves ~-prefixed paths onto `config` in place.
    const dirCheck = await resolveRemoteWorkingDirectory(tabId, config)
    if (!dirCheck.ok) {
      this._setStatus(tabId, 'failed')
      this.emit('error', tabId, {
        message: dirCheck.message,
        stderrTail: [],
        exitCode: 1,
        elapsedMs: 0,
        toolCallCount: 0,
      } as EnrichedError)
      return { ok: false, error: dirCheck.message }
    }

    // A LIVE session keeps the working directory it was started with — the
    // engine pins it at start_session and no wire command changes it. So a
    // prompt whose project path differs from the started directory must
    // base checkout. See engine-control-plane-cwd.ts for the full framing.
    //
    // Awaited: the prompt must land on the reconciled session, not the one it
    // replaced. A failed relocation is logged there and deliberately does NOT
    // abort the prompt — running in the previous directory is worse than
    // ideal, but refusing the operator's prompt outright is worse still, and
    // the warn line makes the condition visible.
    await reconcileSessionWorkingDirectory(
      {
        startedWorkingDirectory: (id) => this.bridge.getSessionConfig(id)?.workingDirectory,
        restartSession: (id) => this.restartTabSession(id),
        ensureSession: (id, opts) => this.ensureSession(id, opts),
      },
      tabId,
      tab,
      config.workingDirectory,
    )

    // Single start site: delegate to ensureSession (idempotent). It is a
    // no-op when the session is already started, and otherwise starts it with
    // the resolved working directory + tracked conversationId so the first
    // prompt and a prior eager restore-start converge on the same key.
    if (!tab.engineSessionStarted) {
      const result = await this.ensureSession(tabId, {
        workingDirectory: config.workingDirectory,
        conversationId: config.sessionId ?? tab.conversationId,
        permissionMode: tab.permissionMode,
        extensions: config.extensions,
        model: config.model,
        maxTokens: config.maxTokens,
        thinking: config.thinking,
      })
      if (!result.ok) {
        error('submit_prompt: ensureSession failed', { tab_id: tabId, error: result.error })
        this._setStatus(tabId, 'failed')
        this.emit('error', tabId, {
          message: result.error || 'Failed to start engine session',
          stderrTail: [],
          exitCode: 1,
          elapsedMs: 0,
          toolCallCount: 0,
        } as EnrichedError)
        return { ok: false, error: result.error || 'Failed to start engine session' }
      }
    }

    this._setStatus(tabId, 'running')
    // Send + one lost-session recovery live in a sibling module; see
    // engine-control-plane-send.ts for why the recovery re-send drops
    // attachments. Status transitions and error emission stay here.
    const result = await sendPromptWithRecovery(
      {
        sendPrompt: bridgeSendAdapter(this.bridge),
        ensureSession: (id, opts) => this.ensureSession(id, opts),
        warn,
        error,
      },
      tabId,
      tab,
      config,
      options,
    )

    // The engine acknowledged the prompt. It assigns run identity inside
    // SendPrompt before replying, so from this point a session-idle snapshot
    // describes a session that HAS this run — the fallback ordering signal for
    // an engine that does not send runEpoch. Set before the failure branch so a
    // send that failed after the engine accepted it does not leave the tab
    // refusing its own completions.
    tab.dispatchAcknowledged = true

    if (!result.ok) {
      error('send_prompt: failed', { tab_id: tabId, error: result.error })
      this._setStatus(tabId, 'failed')
      this.emit('error', tabId, {
        message: result.error || 'Failed to send prompt',
        stderrTail: [],
        exitCode: 1,
        elapsedMs: Date.now() - tab.startedAt,
        toolCallCount: tab.toolCallCount,
      } as EnrichedError)
    }
    return result
  }

  cancel(requestId: string): boolean {
    return cancelRequest(this.tabs, this.bridge, requestId, log, warn)
  }

  cancelTab(tabId: string, scope: AbortScope = 'all'): boolean {
    return cancelTabRun(this.tabs, this.bridge, tabId, scope, log, warn)
  }

  /** Stop one background dispatch; the orchestrator and siblings keep running. */
  abortDispatch(tabId: string, dispatchId: string): boolean {
    return abortTabDispatch(this.tabs, this.bridge, tabId, dispatchId, warn)
  }

  async retry(tabId: string, requestId: string, options: RunOptions): Promise<void> {
    await this.submitPrompt(tabId, requestId, options)
  }

  respondToPermission(tabId: string, questionId: string, optionId: string): boolean {
    // The reconcile + emit seam lives in engine-control-plane-dialog-response.ts.
    // The emit is a callback rather than a direct import there because
    // engine-control-plane -> studio-window-manager -> state ->
    // engine-control-plane is a module cycle; the listener lives in
    // event-wiring.ts (wireSessionPlaneEvents) like every other plane push.
    return respondToPermissionImpl(
      this.tabs, this.bridge, tabId, questionId, optionId,
      (tid, qid) => { this.emit('permission-resolved', tid, qid) },
    )
  }

  respondToElicitation(
    tabId: string,
    requestId: string,
    response: Record<string, unknown> | undefined,
    cancelled: boolean,
    declined = false,
  ): boolean {
    return respondToElicitationImpl(this.tabs, this.bridge, tabId, requestId, response, cancelled, declined)
  }

  getHealth(): HealthReport {
    return buildHealthReport(this.tabs)
  }

  getTabStatus(tabId: string): TabEntry | undefined {
    return this.tabs.get(tabId)
  }

  hasRunningTabs(): boolean {
    return anyTabRunning(this.tabs)
  }

  async listStoredSessions(limit?: number): Promise<any[]> {
    return historyReads.listStoredSessions(this.bridge, limit)
  }
  async loadSessionHistory(sessionId: string): Promise<any[]> {
    return historyReads.loadSessionHistory(this.bridge, sessionId)
  }
  async loadChainHistory(sessionIds: string[]): Promise<any[]> {
    return historyReads.loadChainHistory(this.bridge, sessionIds)
  }
  async getConversation(conversationId: string, offset = 0, limit = 50): Promise<any> {
    return historyReads.getConversation(this.bridge, conversationId, offset, limit)
  }
  async saveSessionLabel(sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    return historyReads.saveSessionLabel(this.bridge, sessionId, label)
  }

  /** Drain/shutdown seam lives in engine-control-plane-drain.ts. */
  async drain(hasExternalWork?: () => boolean): Promise<void> {
    return drainImpl(
      this.drainLatch,
      () => this.hasRunningTabs(),
      () => this.runningTabBlockers(),
      hasExternalWork,
    )
  }

  notifyExternalWorkDone(): void {
    this._checkDrain()
  }

  shutdown(opts: { stopSessions: boolean }): void {
    shutdownImpl(this.drainLatch, this.tabs, this.bridge, opts)
  }

  /** Status seam lives in engine-control-plane-status.ts; see resyncStatus there. */
  private _emitStatus: StatusEmit = (tabId, newStatus, oldStatus) => {
    this.emit('tab-status-change', tabId, newStatus, oldStatus)
  }

  private _resyncStatus(tabId: string, reason: string): void {
    resyncStatus(this.tabs, tabId, reason, this._emitStatus)
  }

  private _setStatus(tabId: string, newStatus: TabStatus): void {
    applyStatus(this.tabs, tabId, newStatus, this._emitStatus)
    this._checkDrain()
  }

  private _checkDrain(): void {
    checkDrain(this.drainLatch, () => this.hasRunningTabs(), () => this.runningTabBlockers())
  }

  private runningTabBlockers(): Array<{ tabId: string; status: TabStatus }> {
    return [...this.tabs.values()]
      .filter((tab) => tab.status === 'running' || tab.status === 'connecting' || tab.status === 'starting')
      .map((tab) => ({ tabId: tab.tabId, status: tab.status }))
  }
}
