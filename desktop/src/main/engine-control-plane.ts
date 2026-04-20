import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { EngineBridge } from './engine-bridge'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'
import type {
  EngineConfig,
  EngineEvent,
  NormalizedEvent,
  RunOptions,
  TabStatus,
  HealthReport,
  EnrichedError,
} from '../shared/types'

const TAG = 'SessionPlane'
function log(msg: string): void { _log(TAG, msg) }
function debug(msg: string): void { _debug(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

// Appended to Claude's default system prompt so it knows it's running inside Ion.
const ION_SYSTEM_HINT = [
  'IMPORTANT: You are NOT running in a terminal. You are running inside Ion,',
  'a desktop chat application with a rich UI that renders full markdown.',
  'Ion is a GUI wrapper around Claude Code — the user sees your output in a',
  'styled conversation view, not a raw terminal.',
  '',
  'Because Ion renders markdown natively, you MUST use rich formatting when it helps:',
  '- Always use clickable markdown links: [label](https://url) — they render as real buttons.',
  '- When the user asks for images, and public web images are appropriate, proactively find and render them in Ion.',
  '- Workflow: WebSearch for relevant public pages -> WebFetch those pages -> extract real image URLs -> render with markdown ![alt](url).',
  '- Do not guess, fabricate, or construct image URLs from memory.',
  '- Only embed images when the URL is a real publicly accessible image URL found through tools or explicitly provided by the user.',
  '- If real image URLs cannot be obtained confidently, fall back to clickable links and briefly say so.',
  '- Do not ask whether Ion can render images; assume it can.',
  '- Use tables, bold, headers, and bullet lists freely — they all render beautifully.',
  '- Use code blocks with language tags for syntax highlighting.',
  '',
  'You are still a software engineering assistant. Keep using your tools (Read, Edit, Bash, etc.)',
  'normally. But when presenting information, links, resources, or explanations to the user,',
  'take full advantage of the rich UI. The user expects a polished chat experience, not raw terminal text.',
].join('\n')

interface TabEntry {
  tabId: string
  status: TabStatus
  activeRequestId: string | null
  conversationId: string | null
  engineSessionStarted: boolean
  lastActivityAt: number
  promptCount: number
  permissionMode: 'auto' | 'plan'
  approvedTools: string[]
  startedAt: number
  toolCallCount: number
  sawPermissionRequest: boolean
}

/**
 * EngineControlPlane wraps EngineBridge to present the same public API
 * as the legacy ControlPlane (which spawned Claude CLI directly).
 *
 * All prompts now route through the Ion engine daemon via Unix socket.
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

  constructor() {
    super()
    this.bridge = new EngineBridge()

    this.bridge.on('event', (key: string, event: EngineEvent) => {
      // Engine keys are tabId (we use tabId as the session key)
      const tabId = key
      const tab = this.tabs.get(tabId)
      if (!tab) return

      this._handleEngineEvent(tabId, tab, event)
    })
  }

  // ─── Tab management ───

  createTab(): string {
    const tabId = randomUUID()
    log(`createTab: tabId=${tabId}`)
    this.tabs.set(tabId, {
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
    })
    return tabId
  }

  hasTab(tabId: string): boolean {
    return this.tabs.has(tabId)
  }

  ensureTab(tabId: string): void {
    if (!this.tabs.has(tabId)) {
      log(`ensureTab: creating missing tab ${tabId}`)
      this.tabs.set(tabId, {
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
      })
    }
  }

  initSession(tabId: string): void {
    // Engine sessions are created on first prompt; nothing to do here
    this.ensureTab(tabId)
  }

  resetTabSession(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    log(`resetTabSession: tabId=${tabId}`)
    // Stop existing engine session and clear session ID so next prompt creates fresh
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

  // ─── Permission mode ───

  setPermissionMode(tabId: string, mode: 'auto' | 'plan'): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.permissionMode = mode
    // Forward to engine for CLI backend
    this.bridge.sendSetPlanMode(tabId, mode === 'plan')
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

  // ─── Prompting ───

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

    // Build engine config for session start (first prompt) or send prompt
    const config: EngineConfig = {
      profileId: 'default',
      extensionDir: '',
      model: options.model,
      workingDirectory: options.projectPath,
      sessionId: options.sessionId,
      maxTokens: options.maxTokens,
      thinking: options.thinking,
    }

    // Start engine session on first prompt (including resumed tabs)
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
    }

    this._setStatus(tabId, 'running')

    // Send the prompt (include model for per-prompt override if changed mid-session)
    const result = await this.bridge.sendPrompt(tabId, options.prompt, options.model)
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
        this.bridge.sendAbort(tabId)
        return true
      }
    }
    return false
  }

  cancelTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false
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

  // ─── Health & status ───

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

  // ─── Shutdown / drain ───

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
    // Stop all sessions and disconnect
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

  // ─── Engine event translation ───

  private _handleEngineEvent(tabId: string, tab: TabEntry, event: EngineEvent): void {
    tab.lastActivityAt = Date.now()
    debug(`event: tabId=${tabId} type=${event.type}`)

    switch (event.type) {
      case 'engine_text_delta':
        this.emit('event', tabId, { type: 'text_chunk', text: event.text } as NormalizedEvent)
        break

      case 'engine_tool_start':
        tab.toolCallCount++
        log(`tool_start: tabId=${tabId} tool=${event.toolName} toolId=${event.toolId} count=${tab.toolCallCount}`)
        this.emit('event', tabId, {
          type: 'tool_call',
          toolName: event.toolName,
          toolId: event.toolId,
          index: tab.toolCallCount - 1,
        } as NormalizedEvent)
        break

      case 'engine_tool_end':
        debug(`tool_end: tabId=${tabId} toolId=${event.toolId} isError=${event.isError}`)
        this.emit('event', tabId, {
          type: 'tool_result',
          toolId: event.toolId,
          content: event.result || '',
          isError: event.isError || false,
        } as NormalizedEvent)
        break

      case 'engine_message_end':
        if (event.usage) {
          log(`message_end: tabId=${tabId} in=${event.usage.inputTokens} out=${event.usage.outputTokens} cost=$${event.usage.cost ?? 0}`)
          this.emit('event', tabId, {
            type: 'usage',
            usage: {
              input_tokens: event.usage.inputTokens,
              output_tokens: event.usage.outputTokens,
            },
          } as NormalizedEvent)
        }
        break

      case 'engine_status':
        if (event.fields) {
          log(`engine_status: tabId=${tabId} state=${event.fields.state} sessionId=${event.fields.sessionId ?? 'none'} cost=$${event.fields.totalCostUsd ?? 0}`)
          if (event.fields.state === 'idle') {
            // Sync conversation ID from engine
            if (event.fields.sessionId) {
              tab.conversationId = event.fields.sessionId
            }
            // Run completed
            const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
            this.emit('event', tabId, {
              type: 'task_complete',
              result: '',
              costUsd: event.fields.totalCostUsd || 0,
              durationMs,
              numTurns: 1,
              usage: { input_tokens: 0, output_tokens: 0 },
              sessionId: tab.conversationId || '',
            } as NormalizedEvent)

            tab.activeRequestId = null
            this._setStatus(tabId, 'idle')
            this._checkDrain()
          } else if (event.fields.state === 'running') {
            this._setStatus(tabId, 'running')
          }
        }
        break

      case 'engine_error':
        error(`engine_error: tabId=${tabId} msg=${event.message}`)
        this.emit('event', tabId, {
          type: 'error',
          message: event.message,
          isError: true,
        } as NormalizedEvent)
        break

      case 'engine_dead': {
        log(`engine_dead: tabId=${tabId} exitCode=${event.exitCode} type=${typeof event.exitCode}`)
        // Code 0 = normal run completion (engine emits engine_dead after every
        // run exit). Only treat non-zero as a real error.
        if (event.exitCode === 0 || event.exitCode === null || event.exitCode === undefined) {
          tab.activeRequestId = null
          this._setStatus(tabId, 'idle')
          this._checkDrain()
          break
        }
        const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
        this.emit('error', tabId, {
          message: `Engine process exited with code ${event.exitCode}`,
          stderrTail: event.stderrTail || [],
          exitCode: event.exitCode ?? null,
          elapsedMs: durationMs,
          toolCallCount: tab.toolCallCount,
          sawPermissionRequest: tab.sawPermissionRequest,
        } as EnrichedError)
        tab.activeRequestId = null
        this._setStatus(tabId, 'dead')
        this._checkDrain()
        break
      }

      case 'engine_permission_request':
        log(`permission_request: tabId=${tabId} tool=${event.permToolName}`)
        tab.sawPermissionRequest = true
        this.emit('event', tabId, {
          type: 'permission_request',
          questionId: event.questionId,
          toolName: event.permToolName,
          toolDescription: event.permToolDescription,
          toolInput: event.permToolInput,
          options: event.permOptions,
        } as NormalizedEvent)
        // Also emit for remote transport (iOS)
        this.emit('remote-permission', tabId, {
          questionId: event.questionId,
          toolName: event.permToolName,
          toolInput: event.permToolInput,
          options: event.permOptions,
        })
        break

      case 'engine_dialog':
        // Forward dialog as-is via bridge dialog_response mechanism
        this.emit('event', tabId, {
          type: 'dialog' as any,
          dialogId: event.dialogId,
          method: event.method,
          title: event.title,
          message: event.message,
          options: event.options,
          defaultValue: event.defaultValue,
        } as any)
        break

      case 'engine_working_message':
        // Informational status -- no direct NormalizedEvent equivalent
        break

      case 'engine_notify':
        if (event.level === 'error') {
          this.emit('event', tabId, {
            type: 'error',
            message: event.message,
            isError: true,
          } as NormalizedEvent)
        }
        break

      case 'engine_agent_state':
        // Agent state updates -- emit as-is for renderer consumption
        this.emit('event', tabId, event as any)
        break
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
