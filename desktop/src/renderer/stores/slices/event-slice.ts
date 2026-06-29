import type { TabStatus, Message } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId, totalInputTokens } from '../session-store-helpers'
import { formatSteerAppliedDivider } from '../../../shared/clear-divider'
import { captureSessionInitId } from './session-init-capture'
import { activeInstance, commitInstance } from '../conversation-instance'
import { handleThinkingEvent, discardActiveThinking } from './event-slice-thinking'
import { handleCrossNormalizedEvent } from './engine-event-slice-messages'
import { maybeScheduleDoneMove } from './event-slice-done-move'
import { maybeScheduleRunningMove } from './event-slice-running-move'
import { handleExtensionSurfaceEvent } from './event-slice-extension-surface'
import { handlePlanModeEvent } from './event-slice-plan-mode'
import { maybeApplyPlanModeGroupMove } from './event-slice-plan-mode-move'
import { handleTaskEvent } from './event-slice-task'
import { handleErrorAction } from './event-slice-error'

/** Compact a multi-line message into a single ~80-char preview for the tab strip. */
function formatMessagePreview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? flat.slice(0, 77) + '…' : flat
}

export function createEventSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    handleNormalizedEvent: (tabId, event) => {
      // Cross-cutting events (resource snapshots, command lifecycle, notifications)
      // flow through the normalized stream after WI-001. They are processed before
      // the per-tab reducer and do NOT touch conversation state.
      if (handleCrossNormalizedEvent(set, get, tabId, event)) return

      set((s) => {
        const { activeTabId } = s
        // Resolve the active conversation instance for this tab ONCE (1B).
        // All message writes mutate this local `messages` array across every
        // event case; the instance + tab are committed together in a single
        // set at the end. Per-conversation fields (permissionDenied,
        // permissionQueue, planFilePath, modelOverride) ride on `instPatch`
        // and are merged into the instance at commit time. Tab-level fields
        // (status, currentActivity, conversationId, lastResult, …) stay on
        // `updated`.
        const inst0 = activeInstance(s.conversationPanes, tabId)
        let messages: Message[] = inst0 ? inst0.messages.slice() : []
        const instPatch: Partial<import('../../../shared/types-engine').ConversationInstance> = {}
        let instTouched = false
        // permissionQueue lives on the instance now; seed the working copy
        // from the instance and write back through instPatch when it changes.
        let permissionQueue = inst0 ? inst0.permissionQueue.slice() : []
        // elicitationQueue (extension ctx.elicit) follows the same pattern:
        // seed from the instance, mutate on elicitation_request, commit back.
        let elicitationQueue = inst0 ? inst0.elicitationQueue.slice() : []

        // Side-effect state: collected outside tabs.map() and merged into the
        // return patch so all store updates land in the same Zustand tick.
        let engineWorkingMessages: Map<string, string> | undefined
        let engineNotifications: Map<string, Array<{ id: string; message: string; level: string; timestamp: number }>> | undefined
        let engineDialogs: Map<string, { dialogId: string; method: string; title: string; options?: string[]; defaultValue?: string } | null> | undefined
        let engineModelFallbacks: typeof s.engineModelFallbacks | undefined

        const tabs = s.tabs.map((tab) => {
          if (tab.id !== tabId) return tab
          const updated = { ...tab, lastEventAt: Date.now() }

          // Extended thinking (issue #158), plain-conversation path. The three
          // thinking_* events delegate to event-slice-thinking.ts (mirrors
          // engine-event-slice.ts). Applied before the main switch so the
          // reducer carries one call, not three cases; for any non-thinking
          // event this returns the messages array unchanged and the switch
          // below handles it as before (no thinking_* case remains there).
          messages = handleThinkingEvent(messages, event) ?? messages

          switch (event.type) {
            case 'session_init':
              if (updated.conversationId && updated.conversationId !== event.sessionId
                  && !updated.historicalSessionIds.includes(updated.conversationId)) {
                updated.historicalSessionIds = [...updated.historicalSessionIds, updated.conversationId]
              }
              updated.conversationId = event.sessionId
              updated.lastKnownSessionId = event.sessionId
              instPatch.sessionModel = event.model
              instTouched = true
              updated.sessionTools = event.tools
              updated.sessionMcpServers = event.mcpServers
              updated.sessionSkills = event.skills
              updated.sessionVersion = event.version
              // WI-001: capture sessionId into the conversation chain + grow the
              // reasoned session ledger. See captureSessionInitId for the full
              // rationale (single authoritative capture site; cut-reason ledger).
              if (inst0 && event.sessionId) {
                const capture = captureSessionInitId(inst0, event.sessionId, Date.now())
                if (capture.conversationIds) {
                  Object.assign(instPatch, capture)
                  if (typeof window !== 'undefined' && (window as any).__ionForceFlushTabs) {
                    ;(window as any).__ionForceFlushTabs()
                  }
                }
              }
              // Gate the running transition on an in-flight user request.
              //
              // A `session_init` is emitted by the engine runloop at the start
              // of EVERY run (engine/internal/backend/runloop.go). That includes
              // runs the user did NOT initiate from this client: a restored
              // extension tab re-starts its engine session on load
              // (useTabRestoration-engine.ts → window.ion.engineStart), and the
              // harness's session_start hook commonly fires an initial turn,
              // producing a `session_init` with no preceding user prompt.
              //
              // Restored extension tabs bypass the control plane
              // (ipc/engine.ts ENGINE_START → engineBridge.startSession with no
              // sessionPlane.ensureTab), so the control plane's
              // engine_status→task_complete idle mediation never runs for them.
              // If this reducer flipped status to 'running' off that warmup
              // session_init, nothing would ever clear it back to idle and the
              // tab would be stuck 'running' after a restart (the
              // reinstall/restart symptom).
              //
              // `isWarmup` alone is not a sufficient guard: it is a desktop-only
              // synthesized flag (only ever set false in
              // engine-control-plane-events.ts) — the engine never sets it, so a
              // raw extension-tab session_init always has it undefined/false.
              // The authoritative signal that THIS client is driving a run is
              // the send path's own state: send-slice sets status='connecting'
              // and activeRequestId BEFORE dispatching (send-slice.ts), so a
              // genuine user-initiated session_init always arrives on a
              // connecting/running tab with a non-null activeRequestId. A
              // session_init that lands on an idle tab with no active request is
              // a restore/reconnect warmup and must not flip to running.
              //
              // NOTE: this gate covers only the status flip. The conversationId
              // capture above runs unconditionally so restored sessions still
              // record their sessionId.
              const hasActiveRun =
                updated.status === 'connecting' ||
                updated.status === 'running' ||
                updated.activeRequestId != null
              if (!event.isWarmup && hasActiveRun) {
                const isTerminal = updated.status === 'failed' || updated.status === 'dead' || updated.status === 'completed'
                if (isTerminal) break
                updated.status = 'running'
                updated.currentActivity = 'Thinking...'
                instPatch.permissionDenied = null
                instTouched = true
                if (updated.queuedPrompts.length > 0) {
                  const [nextPrompt, ...rest] = updated.queuedPrompts
                  updated.queuedPrompts = rest
                  messages = [
                    ...messages,
                    { id: nextMsgId(), role: 'user' as const, content: nextPrompt, timestamp: Date.now() },
                  ]
                }
              }
              break

            case 'stream_reset': {
              // Engine retrying mid-turn: discard trailing in-progress
              // assistant text AND any still-active thinking row (a sealed
              // thinking row from earlier in the turn survives). Mirrors
              // engine-event-slice.ts.
              const lastMsgReset = messages[messages.length - 1]
              if (lastMsgReset?.role === 'assistant' && !lastMsgReset.toolName) {
                messages = messages.slice(0, -1)
              }
              messages = discardActiveThinking(messages)
              break
            }

            case 'compacting':
              if (event.active) {
                updated.currentActivity = 'Compacting...'
                updated.isCompacting = true
              } else {
                updated.currentActivity = 'Thinking...'
                updated.isCompacting = false
                // Insert a compaction marker message so the user can see when compaction happened.
                if (event.messagesBefore || event.summary) {
                  const parts = ['[Compaction]']
                  if (event.strategy) parts.push(event.strategy)
                  if (event.messagesBefore && event.messagesAfter != null) {
                    parts.push(`${event.messagesBefore} → ${event.messagesAfter} messages`)
                  }
                  if (event.clearedBlocks) parts.push(`${event.clearedBlocks} blocks cleared`)
                  let content = parts.join(' · ')
                  if (event.summary) content += '\n\n' + event.summary
                  messages = [
                    ...messages,
                    { id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() },
                  ]
                }
              }
              break

            case 'tool_stalled':
              updated.currentActivity = `Running ${event.toolName} (${Math.round(event.elapsed)}s)...`
              break

            case 'steer_injected':
              // Engine confirmed a mid-turn steer landed in the
              // conversation as a user turn. Resolve the optimistic
              // pending bubble (clear steerPending) and append a
              // "Steer applied" divider so the user can see where
              // the steer fell in the scrollback.
              messages = messages.map((m) =>
                m.steerPending ? { ...m, steerPending: undefined } : m,
              )
              messages = [
                ...messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: formatSteerAppliedDivider(new Date(), event.messageLength),
                  timestamp: Date.now(),
                },
              ]
              break

            case 'text_chunk': {
              console.debug(`[DIAG] text_chunk: tab=${tabId} instance=main len=${(event as any).text?.length} prev_msg_len=${messages[messages.length - 1]?.content?.length ?? 'N/A'}`)
              updated.currentActivity = 'Writing...'
              const lastMsg = messages[messages.length - 1]
              if (lastMsg?.role === 'assistant' && !lastMsg.toolName) {
                messages = [
                  ...messages.slice(0, -1),
                  { ...lastMsg, content: lastMsg.content + event.text },
                ]
              } else {
                messages = [
                  ...messages,
                  { id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() },
                ]
              }
              break
            }

            case 'tool_call':
              updated.currentActivity = `Running ${event.toolName}...`
              messages = [
                ...messages,
                {
                  id: nextMsgId(),
                  role: 'tool',
                  content: '',
                  toolName: event.toolName,
                  toolId: event.toolId,
                  toolInput: '',
                  toolStatus: 'running',
                  timestamp: Date.now(),
                },
              ]
              break

            case 'tool_call_update': {
              const msgs = [...messages]
              const lastTool = [...msgs].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
              if (lastTool) {
                lastTool.toolInput = (lastTool.toolInput || '') + event.partialInput
              }
              messages = msgs
              break
            }

            case 'tool_call_complete': {
              const msgs2 = [...messages]
              const runningTool = [...msgs2].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
              if (runningTool) {
                runningTool.toolStatus = 'completed'
              }
              messages = msgs2
              break
            }

            case 'tool_result': {
              const msgs3 = [...messages]
              const targetTool = [...msgs3].reverse().find((m) => m.role === 'tool' && m.toolId === event.toolId)
              if (targetTool) {
                targetTool.content = event.content
                if (event.isError && targetTool.toolName !== 'ExitPlanMode' && targetTool.toolName !== 'AskUserQuestion') {
                  targetTool.toolStatus = 'error'
                } else {
                  targetTool.toolStatus = 'completed'
                }
                if (usePreferencesStore.getState().expandToolResults && ['Write', 'Edit', 'NotebookEdit'].includes(targetTool.toolName || '')) {
                  targetTool.autoExpandResult = true
                }
                const FILE_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit']
                if (!event.isError && FILE_WRITE_TOOLS.includes(targetTool.toolName || '')) {
                  updated.hasFileActivity = true
                }
              }
              messages = msgs3
              break
            }

            case 'task_update':
            case 'task_complete':
            case 'error':
            case 'session_dead': {
              // Task-lifecycle + run-termination arms extracted to
              // event-slice-task.ts (Fix 1: keep this reducer under the size
              // cap). The handler mutates a shared context (messages, the tab
              // `updated` patch, permissionQueue, instPatch/instTouched,
              // engineModelFallbacks) exactly as the inline cases did; read the
              // results back so the single commit below is unchanged.
              const ctx = {
                s,
                get,
                tabId,
                activeTabId,
                tab,
                inst0,
                messages,
                permissionQueue,
                elicitationQueue,
                updated,
                instPatch,
                instTouched,
                engineModelFallbacks,
              }
              handleTaskEvent(ctx, event)
              messages = ctx.messages
              permissionQueue = ctx.permissionQueue
              elicitationQueue = ctx.elicitationQueue
              instTouched = ctx.instTouched
              engineModelFallbacks = ctx.engineModelFallbacks
              break
            }

            case 'usage': {
              const usageTokens = totalInputTokens(event.usage)
              if (usageTokens > 0) {
                updated.contextTokens = usageTokens
              }
              break
            }

            case 'engine_plan_mode_changed' as any:
            case 'engine_plan_file_written' as any:
            case 'engine_plan_proposal' as any: {
              // Plan-mode arms extracted to event-slice-plan-mode.ts (Fix 1:
              // keep this reducer under the size cap). The handler mutates a
              // shared context (messages + instPatch + instTouched) exactly as
              // the inline cases did; read the results back so the single commit
              // below is unchanged.
              const ctx = { tabId, inst0, messages, instPatch, instTouched }
              handlePlanModeEvent(ctx, event)
              messages = ctx.messages
              instTouched = ctx.instTouched
              break
            }

            case 'permission_request': {
              const newReq: import('../../../shared/types').PermissionRequest = {
                questionId: event.questionId,
                toolTitle: event.toolName,
                toolDescription: event.toolDescription,
                toolInput: event.toolInput,
                options: event.options.map((o) => ({
                  optionId: o.id,
                  kind: o.kind,
                  label: o.label,
                })),
              }
              permissionQueue = [...permissionQueue, newReq]
              updated.currentActivity = `Waiting for permission: ${event.toolName}`
              break
            }

            case 'elicitation_request': {
              // An extension called ctx.elicit(); the engine is parked on an
              // indefinite human-wait until the user answers. Push onto the
              // instance elicitationQueue so the renderer shows an approval
              // card and respondElicitation can answer.
              const newElicit: import('../../../shared/types-session').ElicitationRequest = {
                requestId: event.requestId,
                mode: event.mode,
                schema: event.schema,
                url: event.url,
              }
              elicitationQueue = [...elicitationQueue, newElicit]
              updated.currentActivity = 'Waiting for approval'
              break
            }

            case 'rate_limit':
              if (event.status !== 'allowed') {
                messages = [
                  ...messages,
                  {
                    id: nextMsgId(),
                    role: 'system',
                    content: `Rate limited (${event.rateLimitType}). Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`,
                    timestamp: Date.now(),
                  },
                ]
              }
              break

            // --- WI-001: single-path collapse events ---
            // These variants were previously handled exclusively by the raw
            // engine_* stream in engine-event-slice.ts. They now flow through
            // handleNormalizedEvent so every conversation (plain + extension)
            // uses one reducer.

            case 'plan_mode_auto_exit':
            case 'model_fallback':
            case 'agent_state':
            case 'status':
            case 'harness_message':
            case 'working_message':
            case 'notify':
            case 'dialog':
            case 'message_end':
            case 'extension_died':
            case 'extension_respawned':
            case 'extension_dead_permanent':
            case 'events_dropped': {
              // Extension-surface arms extracted to event-slice-extension-surface.ts
              // (Fix 1: keep this reducer under the size cap). The handler mutates
              // a shared context (messages + engine* side-effect maps + the tab
              // `updated` patch + instPatch/instTouched) exactly as the inline
              // cases did, then we read the results back here so the single commit
              // below is unchanged.
              const ctx = {
                s,
                tabId,
                inst0,
                messages,
                updated,
                instPatch,
                instTouched,
                engineWorkingMessages,
                engineNotifications,
                engineDialogs,
                engineModelFallbacks,
              }
              handleExtensionSurfaceEvent(ctx, event)
              messages = ctx.messages
              instTouched = ctx.instTouched
              engineWorkingMessages = ctx.engineWorkingMessages
              engineNotifications = ctx.engineNotifications
              engineDialogs = ctx.engineDialogs
              engineModelFallbacks = ctx.engineModelFallbacks
              break
            }

            case 'run_stalled':
              // Advisory watchdog. Surface through currentActivity so the user
              // can see the engine is still alive but not making progress.
              updated.currentActivity = 'Still running...'
              break
          }

          // Refresh last-message preview from whichever message ended up
          // most recent. Used as a tab-pill subtitle to help distinguish
          // multiple concurrent sessions.
          const lastMsg = messages[messages.length - 1]
          if (lastMsg) {
            updated.lastMessagePreview = formatMessagePreview(lastMsg.content)
          }

          return updated
        })

        // Commit the working message list + per-conversation patch back onto
        // the active instance in a single set (1B). conversationPanes is replaced
        // only when the tab existed and the instance was found.
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => {
          const next = { ...inst, messages, permissionQueue, elicitationQueue }
          if (instTouched) {
            if ('permissionDenied' in instPatch) next.permissionDenied = instPatch.permissionDenied!
            if ('planFilePath' in instPatch) next.planFilePath = instPatch.planFilePath ?? null
            if ('sessionModel' in instPatch) next.sessionModel = instPatch.sessionModel ?? null
            if ('permissionMode' in instPatch) next.permissionMode = instPatch.permissionMode!
            if ('agentStates' in instPatch) next.agentStates = instPatch.agentStates!
            if ('statusFields' in instPatch) next.statusFields = instPatch.statusFields!
            if ('conversationIds' in instPatch) next.conversationIds = instPatch.conversationIds!
            if ('sessions' in instPatch) next.sessions = instPatch.sessions!
            if ('pendingCutReason' in instPatch) next.pendingCutReason = instPatch.pendingCutReason
          }
          return next
        })

        return {
          tabs,
          conversationPanes,
          ...(engineWorkingMessages !== undefined ? { engineWorkingMessages } : {}),
          ...(engineNotifications !== undefined ? { engineNotifications } : {}),
          ...(engineDialogs !== undefined ? { engineDialogs } : {}),
          ...(engineModelFallbacks !== undefined ? { engineModelFallbacks } : {}),
        }
      })
      maybeApplyPlanModeGroupMove(tabId, event.type, get) // post-commit: re-evaluate group after plan-mode event
    },

    handleStatusChange: (tabId, newStatus) => {
      if (newStatus === 'dead') {
        console.warn(`[Ion] handleStatusChange: tab=${tabId} status=dead`)
      }
      set((s) => {
        // Capture the PRE-transition status: the auto-move-to-done decision
        // fires only on a running→clean-terminal transition. This is the path
        // that engine_dead clean-exit and reconnect idle flow through — neither
        // emits task_complete, so without this the tab is stranded in the
        // in-progress group (see event-slice-done-move.ts).
        const prevTab = s.tabs.find((t) => t.id === tabId)
        const prevStatus = prevTab?.status ?? 'idle'
        // permissionQueue + permissionDenied are per-conversation now.
        //
        // permissionQueue is run-scoped: clear it on ANY terminal status. A
        // live permission queue belongs to an in-flight run and is stale once
        // the run ends, regardless of how we got to idle.
        //
        // permissionDenied is the plan-ready / AskUserQuestion card source and
        // is GATED on a genuine active→terminal transition. On restore the
        // desktop synthesizes the denial from message history
        // (useTabRestoration-engine.ts pendingCardOutcome) onto an ALREADY-idle
        // tab; the engine then emits passive idle snapshots every few seconds
        // (reconcile reason=query / heartbeat). Those are idle→idle (or
        // completed→idle) ticks, NOT a run finishing. Clearing the denial on
        // them wiped the just-synthesized plan-ready card seconds after the
        // user opened the conversation. We only clear the denial when the tab
        // was actually active before this transition (running/connecting →
        // terminal), i.e. a real run ended — which is the case the clear was
        // meant for. A model-driven proposal arrives via task_complete on its
        // own event and is unaffected.
        const wasActive = prevStatus === 'running' || prevStatus === 'connecting'
        const clearQueue = newStatus === 'idle' || newStatus === 'failed' || newStatus === 'dead' || newStatus === 'completed'
        const clearDenied = wasActive && (newStatus === 'idle' || newStatus === 'failed' || newStatus === 'dead')
        const conversationPanes = clearQueue
          ? commitInstance(s.conversationPanes, tabId, (inst) => ({
              ...inst,
              permissionQueue: [],
              elicitationQueue: [],
              ...(clearDenied ? { permissionDenied: null } : {}),
            }))
          : s.conversationPanes
        const tabs = s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                status: newStatus as TabStatus,
                ...(newStatus === 'idle' || newStatus === 'failed' || newStatus === 'dead' || newStatus === 'completed'
                  ? { activeRequestId: null, currentActivity: '' }
                  : {}),
              }
            : t
        )
        // Schedule the done-group move using the post-transition tab + panes.
        // The denial state was just cleared on a clean terminal transition
        // (clearDenied), so the committed `conversationPanes` read inside the
        // helper reflects the correct no-denial state. The helper's own guards
        // (prevStatus === 'running', clean terminal, auto mode, not pinned)
        // decide whether anything is scheduled.
        const movedTab = tabs.find((t) => t.id === tabId)
        if (movedTab) {
          maybeScheduleDoneMove(tabId, prevStatus, newStatus, movedTab, conversationPanes, get, 'status_change')
          // Symmetric counterpart: when the tab transitions INTO running (via any
          // path — resume, relaunch, reconnect, remote — not just a local send),
          // re-evaluate its planning/in-progress group so a running tab is never
          // stranded in the done group. The helper no-ops unless newStatus is
          // 'running'.
          maybeScheduleRunningMove(tabId, prevStatus, newStatus, movedTab, conversationPanes, get, 'status_change')
        }
        return { conversationPanes, tabs }
      })
    },

    handleError: (tabId, error) => {
      handleErrorAction(set, tabId, error)
    },
  }
}
