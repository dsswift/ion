import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { EngineBridge } from './engine-bridge'
import { log as _log, warn as _warn, error as _error } from './logger'
import { handleEngineEvent, type TabEntry, type EventEmitterContext } from './engine-control-plane-events'
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
          log(`resetSessionFlag after reconnect: tabId=${tab.tabId}`)
          tab.engineSessionStarted = false
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
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    log(`closeTab: tabId=${tabId}`)
    this.bridge.stopSession(tabId)
    this.tabs.delete(tabId)
  }

  setPermissionMode(tabId: string, mode: 'auto' | 'plan', source?: string): void {
    this.ensureTab(tabId)
    const tab = this.tabs.get(tabId)!
    tab.permissionMode = mode
    this.bridge.sendSetPlanMode(tabId, mode === 'plan', undefined, source)
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

  async submitPrompt(tabId: string, requestId: string, options: RunOptions): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      warn(`submitPrompt: unknown tab ${tabId}`)
      return
    }

    log(`submitPrompt: tabId=${tabId} requestId=${requestId} model=${options.model ?? 'default'} sessionId=${options.sessionId ?? 'new'} promptCount=${tab.promptCount + 1}`)
    tab.activeRequestId = requestId
    tab.lastActivityAt = Date.now()
    tab.startedAt = Date.now()
    tab.toolCallCount = 0
    tab.sawPermissionRequest = false
    tab.promptCount++

    this._setStatus(tabId, 'connecting')

    const config: EngineConfig = {
      profileId: 'default',
      extensions: options.extensions || [],
      workingDirectory: options.projectPath,
      sessionId: options.sessionId || tab.conversationId || undefined,
      maxTokens: options.maxTokens,
      thinking: options.thinking,
    }

    if (!tab.engineSessionStarted) {
      log(`startSession: tabId=${tabId} model=${config.model} dir=${config.workingDirectory}`)
      const result = await this.bridge.startSession(tabId, config)
      if (!result.ok) {
        error(`startSession failed: tabId=${tabId} err=${result.error}`)
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
      tab.engineSessionStarted = true

      if (tab.permissionMode === 'plan') {
        this.bridge.sendSetPlanMode(tabId, true, undefined, 'session_start')
      }
    }

    this._setStatus(tabId, 'running')

    let result = await this.bridge.sendPrompt(tabId, options.prompt, options.model, options.appendSystemPrompt)

    if (!result.ok && result.error?.includes('not found')) {
      warn(`sendPrompt session lost, re-creating: tabId=${tabId}`)
      tab.engineSessionStarted = false

      const startResult = await this.bridge.startSession(tabId, config)
      if (startResult.ok) {
        tab.engineSessionStarted = true
        if (tab.permissionMode === 'plan') {
          this.bridge.sendSetPlanMode(tabId, true, undefined, 'session_start')
        }
        result = await this.bridge.sendPrompt(tabId, options.prompt, options.model, options.appendSystemPrompt)
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
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: 0,
    toolCallCount: 0,
    sawPermissionRequest: false,
  }
}

