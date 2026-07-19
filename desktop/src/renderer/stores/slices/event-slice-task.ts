// Task-lifecycle and run-termination event handlers extracted from
// event-slice.ts (Fix 1: keep the reducer under the 600-line cap). These are
// the `task_update`, `task_complete`, `error`, and `session_dead` arms of the
// single normalized-event reducer, lifted out verbatim. They mutate the shared
// reducer context through a passed-by-reference context object, exactly as the
// inline switch arms did. No behavior change.
import type { Message, TabState } from '../../../shared/types'
import type { ConversationInstance } from '../../../shared/types-engine'
import type { State, StoreGet } from '../session-store-types'
import { nextMsgId, playNotificationIfHidden } from '../session-store-helpers'
import { maybeScheduleDoneMove } from './event-slice-done-move'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

/**
 * Mutable context shared with the parent reducer for one task-lifecycle event.
 * The parent seeds it from its locals; the handler mutates the fields in place
 * (reassigning arrays/maps); the parent reads them back after the call. The
 * `updated` tab patch and `inst0` snapshot follow the same shapes the reducer
 * uses inline.
 */
export interface TaskCtx {
  s: State
  get: StoreGet
  tabId: string
  activeTabId: string | null
  /** The tab being updated (read-only here; mutations go through `updated`). */
  tab: TabState
  /** The active instance snapshot at reducer entry (read-only here). */
  inst0: (ConversationInstance & { id: string }) | null
  /** Working copy of the active instance's messages (reassigned on append). */
  messages: Message[]
  /** Working copy of the permission queue (reassigned on clear). */
  permissionQueue: unknown[]
  /** Working copy of the elicitation queue (reassigned on clear). */
  elicitationQueue: unknown[]
  /** Tab-level patch object the parent commits onto the tab. */
  updated: TabState
  /** Per-conversation patch object the parent commits onto the instance. */
  instPatch: Partial<ConversationInstance>
  /** Set true when instPatch was mutated (parent reads this back). */
  instTouched: boolean
  /** Reassigned when a model-fallback entry must be cleared; else untouched. */
  engineModelFallbacks?: State['engineModelFallbacks']
}

/**
 * Handle the task-lifecycle event arms. Returns true when the event type was
 * one of these arms, false otherwise. Behavior is identical to the former
 * inline cases.
 */
export function handleTaskEvent(ctx: TaskCtx, event: any): boolean {
  const { s, tabId } = ctx
  switch (event.type) {
    case 'task_update': {
      if (event.message?.content) {
        const lastUserIdx = (() => {
          for (let i = ctx.messages.length - 1; i >= 0; i--) {
            if (ctx.messages[i].role === 'user') return i
          }
          return -1
        })()
        const hasStreamedText = ctx.messages
          .slice(lastUserIdx + 1)
          .some((m) => m.role === 'assistant' && !m.toolName)

        if (!hasStreamedText) {
          const textContent = event.message.content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text!)
            .join('')
          if (textContent) {
            ctx.messages = [
              ...ctx.messages,
              { id: nextMsgId(), role: 'assistant' as const, content: textContent, timestamp: Date.now() },
            ]
          }
        }

        for (const block of event.message.content) {
          if (block.type === 'tool_use' && block.name) {
            const exists: Message | undefined = ctx.messages.find(
              (m) => m.role === 'tool' && m.toolName === block.name && !m.content
            )
            if (!exists) {
              ctx.messages = [
                ...ctx.messages,
                {
                  id: nextMsgId(),
                  role: 'tool',
                  content: '',
                  toolName: block.name,
                  toolInput: JSON.stringify(block.input, null, 2),
                  toolStatus: 'completed',
                  timestamp: Date.now(),
                },
              ]
            } else if (block.input) {
              const completeInput = JSON.stringify(block.input, null, 2)
              if (exists.toolInput !== completeInput) {
                ctx.messages = ctx.messages.map((m) =>
                  m === exists ? { ...m, toolInput: completeInput } : m
                )
              }
            }
          }
        }
      }
      return true
    }

    case 'task_complete':
      rInfo('event.task', 'task complete', { tab_id: tabId.slice(0, 8), prev_status: ctx.tab.status, prev_perm_mode: ctx.inst0?.permissionMode ?? 'auto', has_denials: !!(event.permissionDenials?.length) })
      ctx.updated.status = 'completed'
      ctx.updated.activeRequestId = null
      ctx.updated.currentActivity = ''
      ctx.permissionQueue = []
      ctx.elicitationQueue = []
      if (event.sessionId) {
        ctx.updated.conversationId = event.sessionId
        ctx.updated.lastKnownSessionId = event.sessionId
      }
      ctx.updated.lastResult = {
        totalCostUsd: event.costUsd,
        durationMs: event.durationMs,
        numTurns: event.numTurns,
        conversationTurns: event.conversationTurns,
        usage: event.usage,
        sessionId: event.sessionId,
      }
      if (event.result) {
        const lastUserIdx2 = (() => {
          for (let i = ctx.messages.length - 1; i >= 0; i--) {
            if (ctx.messages[i].role === 'user') return i
          }
          return -1
        })()
        const hasAnyText = ctx.messages
          .slice(lastUserIdx2 + 1)
          .some((m) => m.role === 'assistant' && !m.toolName)
        if (!hasAnyText) {
          ctx.messages = [
            ...ctx.messages,
            { id: nextMsgId(), role: 'assistant' as const, content: event.result, timestamp: Date.now() },
          ]
        }
      }
      if (tabId !== ctx.activeTabId || !s.isExpanded) {
        ctx.updated.hasUnread = true
      }
      if (event.permissionDenials && event.permissionDenials.length > 0) {
        // The engine no longer emits PlanModeChangedEvent{Enabled:false}
        // on the ExitPlanMode tool call, so the previous race that
        // forced this branch to filter out "stale" ExitPlanMode
        // denials (and to inject the synthetic "Plan mode is not
        // active" user message) is gone. task_complete now arrives
        // while permissionMode is still 'plan', and the approval
        // card renders cleanly from the unfiltered denials.
        ctx.instPatch.permissionDenied = { tools: event.permissionDenials }
        ctx.instTouched = true
        rDebug('event.task', 'permission denied set', { tab_id: tabId.slice(0, 8), tools: event.permissionDenials.map((t: any) => t.toolName), perm_mode: ctx.instPatch.permissionMode ?? ctx.inst0?.permissionMode ?? 'auto' })
      } else {
        // task_complete carries no denials. Normally that means "clear the
        // approval card." But a pending ExitPlanMode plan proposal is a
        // workflow signal task_complete does NOT own: some backends (codex,
        // grok's ACP) capture the plan via a native plan item and emit
        // engine_plan_proposal, which the plan-mode reducer already
        // synthesized into permissionDenied — WITHOUT ever putting an
        // ExitPlanMode denial on task_complete (only claude-code does that).
        // Nulling here would wipe the just-synthesized card, so the user gets
        // a clickable plan marker but no approve/implement card. Preserve a
        // permissionDenied whose sole entry is a pending ExitPlanMode proposal;
        // it is cleared instead on the next prompt (send-slice) or on approval.
        const existingDenied =
          'permissionDenied' in ctx.instPatch ? ctx.instPatch.permissionDenied : ctx.inst0?.permissionDenied
        const isPendingPlanProposal =
          !!existingDenied &&
          existingDenied.tools?.length === 1 &&
          existingDenied.tools[0]?.toolName === 'ExitPlanMode'
        if (isPendingPlanProposal) {
          rDebug('event.task', 'no denials but preserving pending ExitPlanMode plan proposal', { tab_id: tabId.slice(0, 8) })
        } else {
          rDebug('event.task', 'no denials', { tab_id: tabId.slice(0, 8) })
          ctx.instPatch.permissionDenied = null
          ctx.instTouched = true
        }
      }
      playNotificationIfHidden()
      // WI-001: clear any model-fallback indicator for the active instance on run exit.
      // The indicator was set when the engine reported a model fallback mid-run.
      if (ctx.inst0 && s.engineModelFallbacks) {
        const fallbackKey = tabId
        if (s.engineModelFallbacks.has(fallbackKey)) {
          ctx.engineModelFallbacks = new Map(s.engineModelFallbacks)
          ctx.engineModelFallbacks.delete(fallbackKey)
        }
      }
      // Auto-move to done group on clean auto-mode completion.
      // Scheduled with a delay so the tab is visible in the in-progress
      // group before moving. The send-slice cancels pending done-moves
      // if the user re-sends, so the tab stays in in-progress.
      // Guard: only move if tab was actually running (not a stale task_complete
      // from a killed session during resetTabSession → implement flow).
      // The move decision (mode, denials, group, pin, delayed re-check)
      // lives in maybeScheduleDoneMove so the SAME logic fires from the
      // handleStatusChange path too (engine_dead clean-exit / reconnect
      // idle never emit task_complete — see event-slice-done-move.ts).
      // deniedOverride must reflect the RESOLVED permissionDenied: when the
      // else-branch above preserved a pending plan proposal via inst0 (without
      // writing instPatch), reading only instPatch would report "not denied"
      // and could schedule a done-move out from under the pending card. Fall
      // back to inst0 so the flag is accurate. (The plan-mode guard also blocks
      // the move, but the flag must not lie.)
      const resolvedDenied =
        'permissionDenied' in ctx.instPatch ? ctx.instPatch.permissionDenied : ctx.inst0?.permissionDenied
      maybeScheduleDoneMove(tabId, ctx.tab.status, 'completed', ctx.updated, s.conversationPanes, ctx.get, 'task_complete', resolvedDenied != null)
      return true

    case 'error':
      ctx.updated.status = 'failed'
      ctx.updated.activeRequestId = null
      ctx.updated.currentActivity = ''
      ctx.permissionQueue = []
      ctx.elicitationQueue = []
      ctx.instPatch.permissionDenied = null
      ctx.instTouched = true
      // Fail any steer bubble that the engine never drained.
      ctx.messages = ctx.messages.map((m) =>
        m.steerPending ? { ...m, steerPending: undefined, steerFailed: true } : m,
      )
      ctx.messages = [
        ...ctx.messages,
        { id: nextMsgId(), role: 'system', content: `Error: ${event.message}`, timestamp: Date.now() },
      ]
      return true

    case 'session_dead':
      rWarn('event.session', 'session dead', { tab_id: tabId, exit_code: event.exitCode })
      ctx.updated.status = 'dead'
      ctx.updated.activeRequestId = null
      ctx.updated.currentActivity = ''
      ctx.permissionQueue = []
      ctx.elicitationQueue = []
      ctx.instPatch.permissionDenied = null
      ctx.instTouched = true
      // Fail any steer bubble that the engine never drained.
      ctx.messages = ctx.messages.map((m) =>
        m.steerPending ? { ...m, steerPending: undefined, steerFailed: true } : m,
      )
      ctx.messages = [
        ...ctx.messages,
        {
          id: nextMsgId(),
          role: 'system',
          content: `Session ended unexpectedly (exit ${event.exitCode})`,
          timestamp: Date.now(),
        },
      ]
      return true
  }
  return false
}
