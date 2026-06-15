import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { EngineBridge } from './engine-bridge'
import { engineIsRemote, getEngineHostInfo, listEngineDirectory } from './engine-bridge-fs'
import { log as _log, warn as _warn, error as _error } from './logger'
import { handleEngineEvent, type TabEntry, type EventEmitterContext } from './engine-control-plane-events'
import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
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
function log(msg: string): void { _log(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

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
          log(`resetSessionFlag after reconnect: tabId=${tab.tabId} conversationId=${tab.conversationId ?? 'none'} (preserved)`)
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
    const tabId = randomUUID()
    log(`createTab: tabId=${tabId}`)
    this.tabs.set(tabId, makeEmptyTab(tabId))
    return tabId
  }

  hasTab(tabId: string): boolean {
    return this.tabs.has(tabId)
  }

  ensureTab(tabId: string): void {
    if (!this.tabs.has(tabId)) {
      log(`ensureTab: creating missing tab ${tabId}`)
      this.tabs.set(tabId, makeEmptyTab(tabId))
    }
  }

  initSession(tabId: string): void {
    this.ensureTab(tabId)
  }

  resetTabSession(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    log(`resetTabSession: tabId=${tabId}`)
    this.bridge.stopSession(tabId)
    tab.conversationId = null
    tab.engineSessionStarted = false
    tab.promptCount = 0
    // Full session reset advances the freshness checkpoint: the next
    // slash command on this tab is the first prompt of a blank session.
    tab.promptCountSinceCheckpoint = 0
    tab.clearedSinceLastPrompt = false
    tab.activeRequestId = null
    tab.status = 'idle'         // Prevent stale events from the dying session
    tab.startedAt = 0           // from triggering task_complete synthesis
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    log(`closeTab: tabId=${tabId}`)
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
      log(`notifyConversationCleared: tabId=${tabId} (no such tab — ignoring)`)
      return
    }
    log(`notifyConversationCleared: tabId=${tabId} promptCount=${tab.promptCount} promptCountSinceCheckpoint=${tab.promptCountSinceCheckpoint}→0 clearedSinceLastPrompt→true conversationId=${tab.conversationId ?? 'null'} (preserved)`)
    tab.promptCountSinceCheckpoint = 0
    tab.clearedSinceLastPrompt = true
  }

  setPermissionMode(tabId: string, mode: 'auto' | 'plan', source?: string): void {
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
    this.bridge.sendSetPlanMode(tabId, mode === 'plan', undefined, source, bashCmds)
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
      log(`ensureSession: tabId=${tabId} seeded tracked conversationId=${opts.conversationId} from caller`)
    }
    if (opts.permissionMode) tab.permissionMode = opts.permissionMode

    if (tab.engineSessionStarted) {
      log(`ensureSession: tabId=${tabId} already started (conversationId=${tab.conversationId ?? 'none'}) — no-op`)
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
    log(`ensureSession: tabId=${tabId} starting engine session sessionId=${config.sessionId ?? 'new'} dir=${config.workingDirectory}`)
    const result = await this.bridge.startSession(tabId, config)
    if (!result.ok) {
      error(`ensureSession: tabId=${tabId} startSession failed err=${result.error}`)
      return result
    }
    tab.engineSessionStarted = true
    log(`ensureSession: tabId=${tabId} engine session live (conversationId=${tab.conversationId ?? 'none'})`)
    if (tab.permissionMode === 'plan') {
      this.bridge.sendSetPlanMode(tabId, true, undefined, 'session_start')
    }
    return result
  }

  async submitPrompt(tabId: string, requestId: string, options: RunOptions): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      warn(`submitPrompt: unknown tab ${tabId}`)
      return
    }

    log(`submitPrompt: tabId=${tabId} requestId=${requestId} model=${options.model ?? 'default'} sessionId=${options.sessionId ?? 'new'} promptCount=${tab.promptCount + 1} promptCountSinceCheckpoint=${tab.promptCountSinceCheckpoint + 1}`)
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
        warn(`workingDirectory unreachable on engine: tabId=${tabId} dir=${wd} err=${probe.error}`)
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
      log(`workingDirectory confirmed on engine: tabId=${tabId} dir=${wd}`)
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
        error(`submitPrompt: tabId=${tabId} ensureSession failed err=${result.error}`)
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

    let result = await this.bridge.sendPrompt(tabId, options.prompt, options.model, options.appendSystemPrompt, options.imageAttachments, options.implementationPhase, options.enterPlanModeDescription, options.planModeSparseReminder, options.planFilePath)

    if (!result.ok && result.error?.includes('not found')) {
      warn(`sendPrompt session lost, re-creating: tabId=${tabId}`)
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
        result = await this.bridge.sendPrompt(tabId, options.prompt, options.model, options.appendSystemPrompt, undefined, options.implementationPhase, options.enterPlanModeDescription, options.planModeSparseReminder, options.planFilePath)
      } else {
        error(`session re-create failed: tabId=${tabId} err=${startResult.error}`)
        result = startResult
      }
    }

    if (!result.ok) {
      error(`sendPrompt failed: tabId=${tabId} err=${result.error}`)
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
        log(`cancel: found tab=${tabId} for requestId=${requestId}, sending abort`)
        this.bridge.sendAbort(tabId)
        return true
      }
    }
    warn(`cancel: no tab found for requestId=${requestId}`)
    return false
  }

  cancelTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) {
      warn(`cancelTab: tab=${tabId} not found in control plane`)
      return false
    }
    log(`cancelTab: tab=${tabId}, sending abort`)
    this.bridge.sendAbort(tabId)
    return true
  }

  steerSession(tabId: string, message: string): void {
    if (!this.tabs.has(tabId)) return
    log(`steerSession: tab=${tabId} len=${message.length}`)
    this.bridge.sendSteer(tabId, message)
  }

  async retry(tabId: string, requestId: string, options: RunOptions): Promise<void> {
    return this.submitPrompt(tabId, requestId, options)
  }

  respondToPermission(tabId: string, questionId: string, optionId: string): boolean {
    if (!this.tabs.has(tabId)) return false
    this.bridge.sendPermissionResponse(tabId, questionId, optionId)
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
    return this.bridge.listStoredSessions(limit)
  }

  async loadSessionHistory(sessionId: string): Promise<any[]> {
    return this.bridge.loadSessionHistory(sessionId)
  }

  async loadChainHistory(sessionIds: string[]): Promise<any[]> {
    return this.bridge.loadChainHistory(sessionIds)
  }

  async getConversation(conversationId: string, offset = 0, limit = 50): Promise<any> {
    return this.bridge.getConversation(conversationId, offset, limit)
  }

  async saveSessionLabel(sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    return this.bridge.saveSessionLabel(sessionId, label)
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
    log(`status: tabId=${tabId} ${oldStatus} -> ${newStatus}`)
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

function makeEmptyTab(tabId: string): TabEntry {
  return {
    tabId,
    status: 'idle',
    activeRequestId: null,
    conversationId: null,
    engineSessionStarted: false,
    lastActivityAt: Date.now(),
    promptCount: 0,
    promptCountSinceCheckpoint: 0,
    clearedSinceLastPrompt: false,
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: 0,
    toolCallCount: 0,
    sawPermissionRequest: false,
  }
}

