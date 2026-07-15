import { EventEmitter } from 'events'
import { EngineBridge } from './engine-bridge'
import { engineIsRemote, getEngineHostInfo, listEngineDirectory } from './engine-bridge-fs'
import { log as _log, warn as _warn, error as _error } from './logger'
import { handleEngineEvent, type TabEntry, type EventEmitterContext } from './engine-control-plane-events'
import { makeEmptyTab, registerNewTab, registerAdoptedTab, resetTabEntry, restartTabEntry } from './engine-control-plane-tab'
import { performUnifiedInterrupt } from './engine-control-plane-interrupt'
import * as historyReads from './engine-control-plane-history'
import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
import { resolveAtvPermission } from './atv-state-cache'
import { notifyAtvPermissionResolved } from './atv-window-manager'
import { resolveBashAllowlistFromSettings } from './plan-mode-bash-allowlist'
import type {
  EngineConfig,
  EngineEvent,
  RunOptions,
  TabStatus,
  HealthReport,
  EnrichedError,
} from '../shared/types'

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
  private drainResolve: (() => void) | null = null
  private drainExternalCheck: (() => boolean) | null = null

  constructor(bridge: EngineBridge) {
    super()
    this.bridge = bridge

    this.bridge.on('event', (key: string, event: EngineEvent) => {
      const tabId = key
      const tab = this.tabs.get(tabId)
      if (!tab) return

      const ctx: EventEmitterContext = {
        bridge: this.bridge,
        emit: (eventName, ...args) => { this.emit(eventName, ...args) },
        setStatus: (tabId, newStatus) => this._setStatus(tabId, newStatus),
        checkDrain: () => this._checkDrain(),
      }
      handleEngineEvent(ctx, tabId, tab, event)
    })

    this.bridge.on('reconnected', () => {
      for (const tab of this.tabs.values()) {
        if (tab.engineSessionStarted) {
          log('reset_session_flag after reconnect', { tab_id: tab.tabId, conversation_id: tab.conversationId ?? '' })
          tab.engineSessionStarted = false
          // conversationId is intentionally preserved here. The bridge's
          // _reRegisterSessions will re-send start_session with this id so
          // the engine resumes the original conversation, not a fresh one.
          // The B1 guard in handleStatusEvent ensures the post-restart
          // pre-mint idle event does not clobber it.
        }
      }
    })
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
    resetTabEntry(this.tabs, tabId, (id) => this.bridge.stopSession(id))
  }

  /**
   * Power-cycle a tab's engine session WITHOUT cutting a new conversation
   * (preserves conversationId). The correct primitive for stuck-tab recovery.
   * See restartTabEntry in engine-control-plane-tab.ts.
   */
  restartTabSession(tabId: string): void {
    restartTabEntry(this.tabs, tabId, (id) => this.bridge.stopSession(id))
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    log('close_tab', { tab_id: tabId })
    this.bridge.stopSession(tabId)
    this.tabs.delete(tabId)
  }

  /**
   * Mark the tab's conversation as cleared (the engine's `/clear` command
   * has succeeded, or the desktop short-circuited a `/clear` locally for a
   * never-started session).
   *
   * Unlike `resetTabSession`, this does NOT stop the engine session, drop
   * `conversationId`, or zero `promptCount`. `/clear` is a checkpoint, not a
   * session restart — the engine keeps the same `conversationID` and the
   * on-disk file (now empty) is reused. The only thing that changes from the
   * desktop's perspective is the freshness checkpoint that the slash-command
   * plan→auto guard consults: the next slash command should behave as if
   * it's the first prompt of a blank conversation.
   *
   * This is intentionally a narrow sibling of `resetTabSession` — it only
   * resets `promptCountSinceCheckpoint`. See the TabEntry doc comment in
   * engine-control-plane-events.ts for the full semantic distinction.
   */
  notifyConversationCleared(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      log('notify_conversation_cleared: no such tab', { tab_id: tabId })
      return
    }
    log('notify_conversation_cleared', { tab_id: tabId, prompt_count: tab.promptCount, prompt_count_since_checkpoint: tab.promptCountSinceCheckpoint, conversation_id: tab.conversationId ?? '' })
    tab.promptCountSinceCheckpoint = 0
    tab.clearedSinceLastPrompt = true
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
    // Tri-valued bash-allowlist projection per docs/protocol/client-commands.md
    // § set_plan_mode:
    //   - undefined        → "no change" to engine's existing allowlist
    //   - []               → "clear" allowlist; Bash blocked entirely
    //   - ["gh", ...]      → "replace" allowlist with this set
    // The helper preserves the empty-array case end-to-end. The previous
    // inline guard collapsed [] to undefined, which silently demoted an
    // explicit user clear to a no-op on the engine side.
    const bashCmds = mode === 'plan' ? resolveBashAllowlistFromSettings() : undefined
    // planFilePath restores plan-file continuity when ENTERING plan mode: the
    // engine re-adopts this path (if it exists on disk) so the next prompt
    // reuses the conversation's existing plan instead of allocating a fresh
    // slug. Only forwarded on 'plan'; the engine ignores it on disable.
    const restorePath = mode === 'plan' ? planFilePath : undefined
    this.bridge.sendSetPlanMode(tabId, mode === 'plan', undefined, source, bashCmds, restorePath)
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
      thinking?: { enabled: boolean; budgetTokens?: number }
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
      return { ok: true }
    }

    const config: EngineConfig = {
      profileId: 'default',
      extensions: opts.extensions || [],
      workingDirectory: opts.workingDirectory,
      sessionId: opts.conversationId || tab.conversationId || undefined,
      model: opts.model,
      maxTokens: opts.maxTokens,
      thinking: opts.thinking,
      claudeCompat: (() => {
        try { return readSettings().enableClaudeCompat ?? SETTINGS_DEFAULTS.enableClaudeCompat }
        catch { return SETTINGS_DEFAULTS.enableClaudeCompat }
      })(),
    }
    log('ensure_session: starting', { tab_id: tabId, session_id: config.sessionId ?? 'new', dir: config.workingDirectory })
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
    if (tab.permissionMode === 'plan') {
      this.bridge.sendSetPlanMode(tabId, true, undefined, 'session_start')
    }
    return result
  }

  async submitPrompt(tabId: string, requestId: string, options: RunOptions): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      warn('submit_prompt: unknown tab', { tab_id: tabId })
      return
    }

    log('submit_prompt', { tab_id: tabId, request_id: requestId, model: options.model ?? 'default', session_id: options.sessionId ?? 'new', prompt_count: tab.promptCount + 1 })
    tab.activeRequestId = requestId
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
      thinking: options.thinking,
      claudeCompat: (() => {
        try { return readSettings().enableClaudeCompat ?? SETTINGS_DEFAULTS.enableClaudeCompat }
        catch { return SETTINGS_DEFAULTS.enableClaudeCompat }
      })(),
    }

    // When the engine is remote, the workingDirectory must exist on the engine
    // host (the desktop's local file dialog cannot know that). If a stale path
    // from this desktop's filesystem is sent, the CLI dies with chdir errors
    // and the tab silently stays idle. Resolve ~/~-prefixed paths against the
    // engine's home, then probe the engine and surface a clear error instead.
    if (engineIsRemote() && config.workingDirectory) {
      let wd = config.workingDirectory
      if (wd === '~' || wd.startsWith('~/')) {
        const hostInfo = await getEngineHostInfo()
        if (hostInfo.ok && hostInfo.data?.home) {
          wd = wd === '~' ? hostInfo.data.home : `${hostInfo.data.home}/${wd.slice(2)}`
          config.workingDirectory = wd
        }
      }
      const probe = await listEngineDirectory(wd, false)
      if (!probe.ok) {
        warn('working_directory: unreachable on engine', { tab_id: tabId, dir: wd, error: probe.error })
        this._setStatus(tabId, 'failed')
        this.emit('error', tabId, {
          message:
            `Working directory "${wd}" does not exist on the engine host. ` +
            'Choose a directory on the remote engine via the status-bar folder picker, then try again.',
          stderrTail: [],
          exitCode: 1,
          elapsedMs: 0,
          toolCallCount: 0,
        } as EnrichedError)
        return
      }
      log('working_directory: confirmed', { tab_id: tabId, dir: wd })
    }

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
        return
      }
    }

    this._setStatus(tabId, 'running')

    let result = await this.bridge.sendPrompt(tabId, options.prompt, options.model, options.appendSystemPrompt, options.imageAttachments, options.implementationPhase, options.enterPlanModeDescription, options.planModeSparseReminder, options.planFilePath, undefined, options.thinkingEffort, options.resolveSlash)

    if (!result.ok && result.error?.includes('not found')) {
      warn('send_prompt: session lost, re-creating', { tab_id: tabId })
      // Reset the started flag so ensureSession actually re-starts (it no-ops
      // when the flag is set). Route the recovery through the same single
      // start site rather than re-issuing startSession inline.
      tab.engineSessionStarted = false

      const startResult = await this.ensureSession(tabId, {
        workingDirectory: config.workingDirectory,
        conversationId: config.sessionId ?? tab.conversationId,
        permissionMode: tab.permissionMode,
        extensions: config.extensions,
        model: config.model,
        maxTokens: config.maxTokens,
        thinking: config.thinking,
      })
      if (startResult.ok) {
        result = await this.bridge.sendPrompt(tabId, options.prompt, options.model, options.appendSystemPrompt, undefined, options.implementationPhase, options.enterPlanModeDescription, options.planModeSparseReminder, options.planFilePath, undefined, options.thinkingEffort, options.resolveSlash)
      } else {
        error('session re-create failed', { tab_id: tabId, error: startResult.error })
        result = startResult
      }
    }

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
  }

  cancel(requestId: string): boolean {
    for (const [tabId, tab] of this.tabs) {
      if (tab.activeRequestId === requestId) {
        log('cancel: found tab, sending abort', { tab_id: tabId, request_id: requestId })
        this.bridge.sendAbort(tabId)
        return true
      }
    }
    warn('cancel: no tab found', { request_id: requestId })
    return false
  }

  cancelTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) {
      warn('cancel_tab: not found', { tab_id: tabId })
      return false
    }
    log('cancel_tab: unified interrupt', { tab_id: tabId })
    performUnifiedInterrupt(this.bridge, tabId)
    return true
  }

  async retry(tabId: string, requestId: string, options: RunOptions): Promise<void> {
    return this.submitPrompt(tabId, requestId, options)
  }

  respondToPermission(tabId: string, questionId: string, optionId: string): boolean {
    if (!this.tabs.has(tabId)) { log('respond_to_permission: dropped, unknown tab', { tab_id: tabId, question_id: questionId }); return false }
    this.bridge.sendPermissionResponse(tabId, questionId, optionId)
    // Cross-surface reconcile (mirror-store architecture): this is the ONE
    // spot every surface's answer funnels through — overlay card, iOS
    // remote, ATV approval. Resolving the ATV pending queue and pushing the
    // resolution here means an answer from ANY surface clears the others
    // instantly, instead of waiting for the next status transition.
    resolveAtvPermission(tabId, questionId)
    notifyAtvPermissionResolved(tabId, questionId)
    return true
  }

  respondToElicitation(tabId: string, requestId: string, response: Record<string, unknown> | undefined, cancelled: boolean): boolean {
    if (!this.tabs.has(tabId)) { log('respond_to_elicitation: dropped, unknown tab', { tab_id: tabId, request_id: requestId, cancelled }); return false }
    this.bridge.sendElicitationResponse(tabId, requestId, response, cancelled)
    return true
  }

  getHealth(): HealthReport {
    const tabs: HealthReport['tabs'] = []
    for (const tab of this.tabs.values()) {
      tabs.push({
        tabId: tab.tabId,
        status: tab.status,
        activeRequestId: tab.activeRequestId,
        conversationId: tab.conversationId,
        alive: tab.status !== 'dead' && tab.status !== 'failed',
        lastActivityAt: tab.lastActivityAt,
      })
    }
    return { tabs, queueDepth: 0 }
  }

  getTabStatus(tabId: string): TabEntry | undefined {
    return this.tabs.get(tabId)
  }

  hasRunningTabs(): boolean {
    for (const tab of this.tabs.values()) {
      if (tab.status === 'running' || tab.status === 'connecting') {
        return true
      }
    }
    return false
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

  async drain(hasExternalWork?: () => boolean): Promise<void> {
    if (!this.hasRunningTabs() && (!hasExternalWork || !hasExternalWork())) {
      return
    }
    this.drainExternalCheck = hasExternalWork || null
    return new Promise<void>((resolve) => {
      this.drainResolve = resolve
    })
  }

  notifyExternalWorkDone(): void {
    this._checkDrain()
  }

  shutdown(): void {
    for (const tabId of this.tabs.keys()) {
      this.bridge.stopSession(tabId)
    }
    this.bridge.stopAll()
    this.tabs.clear()
    if (this.drainResolve) {
      this.drainResolve()
      this.drainResolve = null
    }
  }

  private _setStatus(tabId: string, newStatus: TabStatus): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const oldStatus = tab.status
    if (oldStatus === newStatus) return
    log('status_transition', { tab_id: tabId, from: oldStatus, to: newStatus })
    tab.status = newStatus
    this.emit('tab-status-change', tabId, newStatus, oldStatus)
  }

  private _checkDrain(): void {
    if (!this.drainResolve) return
    if (this.hasRunningTabs()) return
    if (this.drainExternalCheck && this.drainExternalCheck()) return
    this.drainResolve()
    this.drainResolve = null
    this.drainExternalCheck = null
  }
}
