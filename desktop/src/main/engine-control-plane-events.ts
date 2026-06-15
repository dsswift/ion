import type { EngineBridge } from './engine-bridge'
import type { EngineEvent, NormalizedEvent, TabStatus, EnrichedError, EngineConfig } from '../shared/types'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'
import { handleExportEvent } from './engine-export-handler'

const TAG = 'SessionPlane'
function log(msg: string): void { _log(TAG, msg) }
function debug(msg: string): void { _debug(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

export interface TabEntry {
  tabId: string
  status: TabStatus
  activeRequestId: string | null
  conversationId: string | null
  engineSessionStarted: boolean
  lastActivityAt: number
  promptCount: number
  /**
   * Number of prompts submitted since the last freshness checkpoint.
   *
   * A "checkpoint" is any event that semantically restores the tab to
   * "fresh blank session" status for the purpose of the slash-command
   * plan→auto auto-switch guard (`isFirstPromptForTab` in slash-classify.ts).
   * Two events advance this checkpoint:
   *
   *   1. `resetTabSession` — full session reset (stops the engine session,
   *      drops the conversation id). Zeros `promptCount` too.
   *   2. `notifyConversationCleared` — `/clear` succeeded. The engine
   *      session and conversation id intentionally stay alive (it's a
   *      checkpoint, not a session restart), but the LLM-visible history
   *      has been wiped, so the next slash command should be treated as
   *      the first prompt of a blank conversation. `promptCount` is
   *      preserved in that case because it remains a useful "total prompts
   *      this app boot" counter for logging.
   *
   * Why a separate field rather than reusing `promptCount`: callers of
   * `getTabStatus` may still want the total prompt count (e.g. logging),
   * so we keep both. The guard consults this checkpoint-relative counter
   * exclusively.
   */
  promptCountSinceCheckpoint: number
  /**
   * Set `true` by `notifyConversationCleared`, cleared by `submitPrompt`.
   *
   * This flag disambiguates two states that look identical to the
   * `promptCountSinceCheckpoint` counter alone:
   *
   *   A. Tab just cleared (`/clear` fired) — `promptCountSinceCheckpoint`
   *      is 0, but the renderer still sends its stale `conversationId` as
   *      `runOptions.sessionId`. The guard should treat this as fresh.
   *   B. Tab restored from disk (app restart) — `promptCountSinceCheckpoint`
   *      is 0, and the renderer sends the restored `conversationId` as
   *      `runOptions.sessionId`. The guard should treat this as resumed.
   *
   * Without this flag the guard cannot tell A from B — both have
   * `promptCountSinceCheckpoint === 0` and `runOptionsSessionId` set.
   * With the flag: A has `clearedSinceLastPrompt === true`, so the guard
   * returns "fresh" and the plan→auto switch fires. B has the flag
   * `false` (never set after a restore), so the guard returns "not fresh".
   */
  clearedSinceLastPrompt: boolean
  permissionMode: 'auto' | 'plan'
  approvedTools: string[]
  startedAt: number
  toolCallCount: number
  sawPermissionRequest: boolean
}

export interface EventEmitterContext {
  bridge: EngineBridge
  emit: (eventName: string, ...args: unknown[]) => void
  setStatus: (tabId: string, newStatus: TabStatus) => void
  checkDrain: () => void
}

export function handleEngineEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: EngineEvent,
): void {
  tab.lastActivityAt = Date.now()
  debug(`event: tabId=${tabId} type=${event.type}`)

  switch (event.type) {
    case 'engine_text_delta':
      ctx.emit('event', tabId, { type: 'text_chunk', text: event.text } as NormalizedEvent)
      break

    case 'engine_tool_start':
      tab.toolCallCount++
      log(`tool_start: tabId=${tabId} tool=${event.toolName} toolId=${event.toolId} count=${tab.toolCallCount}`)
      ctx.emit('event', tabId, {
        type: 'tool_call',
        toolName: event.toolName,
        toolId: event.toolId,
        index: tab.toolCallCount - 1,
      } as NormalizedEvent)
      break

    case 'engine_tool_update':
      ctx.emit('event', tabId, {
        type: 'tool_call_update',
        toolId: event.toolId,
        partialInput: event.partialInput,
      } as NormalizedEvent)
      break

    case 'engine_tool_complete':
      ctx.emit('event', tabId, {
        type: 'tool_call_complete',
        index: event.index,
      } as NormalizedEvent)
      break

    case 'engine_tool_end':
      debug(`tool_end: tabId=${tabId} toolId=${event.toolId} isError=${event.isError}`)
      ctx.emit('event', tabId, {
        type: 'tool_result',
        toolId: event.toolId,
        content: event.result || '',
        isError: event.isError || false,
      } as NormalizedEvent)
      break

    case 'engine_message_end':
      if (event.usage) {
        log(`message_end: tabId=${tabId} in=${event.usage.inputTokens} out=${event.usage.outputTokens} cost=$${event.usage.cost ?? 0}`)
        ctx.emit('event', tabId, {
          type: 'usage',
          usage: {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
          },
        } as NormalizedEvent)
      }
      break

    case 'engine_status':
      handleStatusEvent(ctx, tabId, tab, event)
      break

    case 'engine_error':
      error(`engine_error: tabId=${tabId} msg=${event.message}`)
      ctx.emit('event', tabId, {
        type: 'error',
        message: event.message,
        isError: true,
      } as NormalizedEvent)
      break

    case 'engine_dead':
      handleDeadEvent(ctx, tabId, tab, event)
      break

    case 'engine_permission_request':
      log(`permission_request: tabId=${tabId} tool=${event.permToolName}`)
      tab.sawPermissionRequest = true
      ctx.emit('event', tabId, {
        type: 'permission_request',
        questionId: event.questionId,
        toolName: event.permToolName,
        toolDescription: event.permToolDescription,
        toolInput: event.permToolInput,
        options: event.permOptions,
      } as NormalizedEvent)
      ctx.emit('remote-permission', tabId, {
        questionId: event.questionId,
        toolName: event.permToolName,
        toolInput: event.permToolInput,
        options: event.permOptions,
      })
      break

    case 'engine_dialog':
      ctx.emit('event', tabId, {
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
      break

    case 'engine_notify':
      if (event.level === 'error') {
        ctx.emit('event', tabId, {
          type: 'error',
          message: event.message,
          isError: true,
        } as NormalizedEvent)
      }
      break

    case 'engine_plan_mode_changed':
      log(`plan_mode_changed: tabId=${tabId} enabled=${event.planModeEnabled}`)
      // Only Enabled:true is authoritative — model-initiated EnterPlanMode
      // confirms the session has entered plan mode and the snapshot must
      // reflect that. Enabled:false is intentionally NOT synced here: the
      // engine no longer emits it for ExitPlanMode (model proposal only),
      // and the user-approval gate in the renderer's onImplement handler
      // is the single chokepoint for the mode flip back to 'auto'. If a
      // false event ever arrives (e.g. from a future engine path) we still
      // forward it to the renderer but do not mutate permissionMode here.
      if (event.planModeEnabled) {
        if (tab.permissionMode !== 'plan') {
          tab.permissionMode = 'plan'
          log(`plan_mode_changed: tabId=${tabId} engine flipped to plan, syncing tab.permissionMode`)
        }
      } else {
        log(`plan_mode_changed: tabId=${tabId} enabled=false ignored (mode flip deferred to user-approval chokepoint)`)
      }
      ctx.emit('event', tabId, event as any)
      break

    case 'engine_plan_proposal':
      // The model has proposed a plan-mode transition (currently only
      // kind="exit" — the model called ExitPlanMode). This is a workflow
      // event, NOT a state transition: the actual mode change is deferred
      // to the user-approval chokepoint in usePermissionDeniedHandlers.
      // The desktop forwards the event to the renderer as the authoritative
      // signal that an approval card should render; the permission_denial
      // path on engine_status remains the fallback card-render trigger so
      // existing logic keeps working during the migration. See
      // docs/architecture/adr/003-state-events-vs-workflow-events.md.
      log(
        `plan_proposal: tabId=${tabId} kind=${event.planProposalKind} planFilePath=${event.planFilePath ?? ''} planSlug=${event.planSlug ?? ''}`,
      )
      ctx.emit('event', tabId, event as any)
      break

    case 'engine_stream_reset':
      log(`stream_reset: tabId=${tabId} (retry in progress, discarding partial text)`)
      ctx.emit('event', tabId, { type: 'stream_reset' } as NormalizedEvent)
      break

    case 'engine_compacting':
      log(`compacting: tabId=${tabId} active=${event.active}`)
      ctx.emit('event', tabId, { type: 'compacting', active: event.active } as NormalizedEvent)
      break

    case 'engine_tool_stalled':
      debug(`tool_stalled: tabId=${tabId} tool=${event.toolName} elapsed=${event.toolElapsed}s`)
      ctx.emit('event', tabId, {
        type: 'tool_stalled',
        toolId: event.toolId,
        toolName: event.toolName,
        elapsed: event.toolElapsed,
      } as NormalizedEvent)
      break

    case 'engine_steer_injected':
      // Mid-turn steer-drain confirmation. The runloop captures a steer
      // message between turns, inside the end_turn checkpoint, or after
      // tool execution; this event tells consumers the steer landed in
      // the conversation as a user turn before the next LLM call.
      log(`steer_injected: tabId=${tabId} messageLength=${event.steerMessageLength}`)
      ctx.emit('event', tabId, {
        type: 'steer_injected',
        messageLength: event.steerMessageLength,
      } as NormalizedEvent)
      break

    case 'engine_agent_state':
      ctx.emit('event', tabId, event as any)
      break

    case 'engine_early_stop_decision_request':
      // The engine is asking whether to nudge the model to keep working.
      // Promote this to a Bridge-level event so the policy module
      // (early-stop-policy.ts, wired in engine-bridge.ts) can build a
      // response synchronously from the persisted setting. The engine
      // gives us 100ms to reply; the policy module must respond off the
      // event loop, not via any async I/O.
      log(
        `early_stop_decision_request: tabId=${tabId} requestId=${event.earlyStopRequestId} run=${event.earlyStopRunId} turn=${event.earlyStopTurnNumber} wouldContinue=${event.earlyStopWouldContinue}`,
      )
      ctx.emit('engine_early_stop_decision_request', tabId, event)
      break

    case 'engine_intercept':
      // Fire-and-forget signal: bubble up via ctx.emit so event-wiring.ts's
      // wireSessionPlaneEvents can call handleInterceptEvent without creating
      // a circular import through state.ts. The event carries the raw payload
      // and tabId; the wiring layer in event-wiring.ts does the routing.
      log(`intercept: tabId=${tabId} level=${event.interceptLevel} title=${event.interceptTitle}`)
      ctx.emit('engine_intercept', tabId, event)
      break

    case 'engine_export':
      // The engine has rendered a /export payload. Surface the save-as
      // dialog so the user can write it to disk. The engine_command_result
      // arrives next and is handled by the existing result-routing path.
      // exportFormat is the engine-resolved format (markdown/json/html/jsonl);
      // the handler maps it to a file extension without sniffing the payload.
      log(`export: tabId=${tabId} format=${event.exportFormat ?? 'absent'} payloadBytes=${event.message?.length ?? 0}`)
      // Fire-and-forget: the dialog is async but the engine event stream
      // continues without waiting. Errors are logged inside the handler.
      void handleExportEvent(event.message || '', event.exportFormat)
      break
  }
}

function handleStatusEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: Extract<EngineEvent, { type: 'engine_status' }>,
): void {
  if (!event.fields) return
  log(`engine_status: tabId=${tabId} state=${event.fields.state} sessionId=${event.fields.sessionId ?? 'none'} cost=$${event.fields.totalCostUsd ?? 0}`)
  if (event.fields.state === 'idle') {
    if (event.fields.sessionId) {
      if (!tab.conversationId) {
        // First-ever bind: adopt the engine's id (normal first-start path).
        tab.conversationId = event.fields.sessionId
        ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
      } else if (tab.conversationId === event.fields.sessionId) {
        // Matching id: no-op (normal heartbeat tick or stable idle).
        ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
      } else {
        // Divergence: the engine has a different id. This is the post-restart
        // pre-mint footgun (issue #230 B1). Do NOT clobber the tracked id.
        // Drive a resume so the engine rebinds the key to the real conversation.
        //
        // Carry the tab's REAL config into the resume (workingDirectory,
        // extensions, model) rather than empty placeholders: a bare config would
        // start a degraded session (wrong cwd, no extensions). The bridge holds
        // the last EngineConfig used for this key; we reuse it and override only
        // sessionId so the engine resumes the original conversation with the same
        // working session. Falls back to a minimal config only if the bridge has
        // no record (should not happen for a started session). (#231)
        const priorConfig = ctx.bridge.getSessionConfig(tabId)
        const resumeConfig: EngineConfig = priorConfig
          ? { ...priorConfig, sessionId: tab.conversationId, forceNewConversation: false }
          : { profileId: 'default', extensions: [], workingDirectory: '', sessionId: tab.conversationId }
        warn(
          `engine_status: tabId=${tabId} engine sessionId=${event.fields.sessionId} diverges from tracked conversationId=${tab.conversationId} — driving resume to restore original conversation (dir=${resumeConfig.workingDirectory || 'none'} model=${resumeConfig.model ?? 'default'} extensions=${resumeConfig.extensions.length})`,
        )
        ctx.bridge.updateSessionConversationId(tabId, tab.conversationId)
        void ctx.bridge.startSession(tabId, resumeConfig)
      }
    }

    if (tab.status === 'completed' || tab.status === 'idle' || tab.status === 'connecting') {
      // 'completed' / 'idle': already synthesized task_complete for this
      // idle transition — skip duplicates from cost-only heartbeat ticks.
      // 'connecting': submitPrompt has been called (new prompt in flight)
      // but the engine hasn't responded with state='running' yet. Any
      // engine_status(idle + denials) in this window is stale — the engine
      // is about to clear its lastPermissionDenials in prompt_dispatch.
      // Synthesizing a task_complete here would resurrect a dismissed
      // ExitPlanMode / AskUserQuestion card.
      log(`engine_status: skipping idle for ${tab.status} tab ${tabId}`)
      return
    }

    const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
    ctx.emit('event', tabId, {
      type: 'task_complete',
      result: '',
      costUsd: event.fields.totalCostUsd || 0,
      durationMs,
      numTurns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      sessionId: tab.conversationId || '',
      permissionDenials: event.fields.permissionDenials,
    } as NormalizedEvent)

    tab.activeRequestId = null
    // Preserve 'completed' status whenever the engine reported denials that
    // require a user response. Otherwise a subsequent engine_status state=idle
    // (e.g. a cost-only update fired ~1ms later) will fail the guard at the
    // top of this branch (`tab.status === 'completed'`), synthesize a second
    // task_complete with empty permissionDenials, and clobber the renderer's
    // permissionDenied state — making the AskUserQuestion / ExitPlanMode card
    // never appear. ExitPlanMode was already handled; AskUserQuestion was the
    // missed case.
    const needsUserResponse = event.fields.permissionDenials?.some(
      (d: any) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion',
    )
    log(`engine_status: tabId=${tabId} task_complete synthesized denials=${event.fields.permissionDenials?.length ?? 0} needsUserResponse=${needsUserResponse}`)
    ctx.setStatus(tabId, needsUserResponse ? 'completed' : 'idle')
    ctx.checkDrain()
  } else if (event.fields.state === 'running') {
    if (tab.status !== 'running') {
      ctx.emit('event', tabId, {
        type: 'session_init',
        sessionId: tab.conversationId || '',
        tools: [],
        model: event.fields.model || '',
        mcpServers: [],
        skills: [],
        version: '',
        isWarmup: false,
      } as NormalizedEvent)
    }
    ctx.setStatus(tabId, 'running')
  }
}

function handleDeadEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: Extract<EngineEvent, { type: 'engine_dead' }>,
): void {
  log(`engine_dead: tabId=${tabId} exitCode=${event.exitCode} signal=${event.signal} type=${typeof event.exitCode}`)
  if (event.exitCode === 0 || event.exitCode === null || event.exitCode === undefined) {
    tab.activeRequestId = null
    if (!event.signal) {
      tab.engineSessionStarted = false
    }
    if (tab.status !== 'completed') {
      ctx.setStatus(tabId, 'idle')
    }
    ctx.checkDrain()
    return
  }
  const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
  ctx.emit('error', tabId, {
    message: `Engine process exited with code ${event.exitCode}`,
    stderrTail: event.stderrTail || [],
    exitCode: event.exitCode ?? null,
    elapsedMs: durationMs,
    toolCallCount: tab.toolCallCount,
    sawPermissionRequest: tab.sawPermissionRequest,
  } as EnrichedError)
  tab.activeRequestId = null
  ctx.setStatus(tabId, 'dead')
  ctx.checkDrain()
}
