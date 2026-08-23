// Task-lifecycle and run-termination event handlers extracted from
// event-slice.ts (Fix 1: keep the reducer under the 600-line cap). These are
// the `task_update`, `task_complete`, `error`, and `session_dead` arms of the
// single normalized-event reducer, lifted out verbatim. They mutate the shared
// reducer context through a passed-by-reference context object. They keep the
// original reducer semantics while making run completion a durable activity and
// review boundary.
import type { Message, TabState } from '../../../shared/types'
import type { ConversationInstance } from '../../../shared/types-engine'
import type { State, StoreGet } from '../session-store-types'
import { nextMsgId, playNotificationIfHidden } from '../session-store-helpers'
import { maybeScheduleDoneMove } from './event-slice-done-move'
import { rInfo, rWarn } from '../../rendererLogger'
import { logTabStatusPatch } from './tab-status-transition'
import { isPendingUserCardDenial } from '../../../shared/pending-card'

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
  /**
   * Set by the task_complete arm for auto-fix tabs: the pre-clear evidence the
   * post-commit lifecycle decision needs (the reducer clears the queues and
   * denial state in the same set() that flips status, so the decision cannot
   * re-read them afterwards). The parent reports this to the owner action after
   * committing.
   */
  autoFixEvidence?: import('./event-slice-auto-fix-lifecycle').AutoFixCompletionEvidence
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
      rInfo('event.task', 'task complete', { tab_id: tabId.slice(0, 8), prev_status: ctx.tab.status, prev_perm_mode: ctx.inst0?.permissionMode ?? 'auto', has_denials: !!(event.permissionDenials?.length), reason: event.reason ?? 'absent' })
      // Auto-fix lifecycle evidence, captured BEFORE the clears below wipe it.
      // hadPendingAsk covers a run that stopped mid-question: a non-empty
      // permission or elicitation queue at completion means the model asked
      // and nobody could answer in a locked tab.
      if (ctx.tab.tabRole === 'conflict-auto-fix') {
        ctx.autoFixEvidence = {
          reason: event.reason,
          hadDenials: !!(event.permissionDenials && event.permissionDenials.length > 0),
          hadPendingAsk: ctx.permissionQueue.length > 0 || ctx.elicitationQueue.length > 0,
          runRequestId: ctx.tab.activeRequestId,
        }
      }
      logTabStatusPatch(tabId, ctx.tab.status, 'completed', 'event.task-complete',
        { reason: event.reason ?? 'absent' })
      ctx.updated.status = 'completed'
      ctx.updated.activeRequestId = null
      ctx.updated.currentActivity = ''
      // A completion is real conversation activity even when the run produced
      // no final assistant text. One timestamp keeps the activity clock, review
      // marker, and idle clock on the exact run-exit boundary.
      const suppressInboxMessage = ctx.updated.inboxMessageSuppressed === true
      const completedAt = Date.now()
      ctx.updated.lastCompletionAt = completedAt
      ctx.updated.lastActivityAt = completedAt
      ctx.updated.idleSince = completedAt
      // A settled conversation is inert. A late completion is a shutdown race,
      // not new activity, so it must never clear the settlement lock.
      ctx.permissionQueue = []
      ctx.elicitationQueue = []
      if (event.sessionId) {
        ctx.updated.conversationId = event.sessionId
        ctx.updated.lastKnownSessionId = event.sessionId
      }
      ctx.updated.lastResult = {
        totalCostUsd: event.costUsd,
        durationMs: event.durationMs,
        reason: event.reason,
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
          const timestamp = Date.now()
          ctx.messages = [
            ...ctx.messages,
            { id: nextMsgId(), role: 'assistant' as const, content: event.result, timestamp },
          ]
          if (!suppressInboxMessage) ctx.updated.lastMessageAt = timestamp
        }
      }
      // Do not mark an active conversation reviewed here. A completed run is
      // new information until the user enters the conversation after this
      // timestamp; merely leaving it open while work runs is not a review.
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
        rInfo('event.task', 'permission denied set', { tab_id: tabId.slice(0, 8), tools: event.permissionDenials.map((t: any) => t.toolName), perm_mode: ctx.instPatch.permissionMode ?? ctx.inst0?.permissionMode ?? 'auto' })
      } else {
        // task_complete carries no denials. Normally that means "clear the
        // approval card." But a pending user-facing card is a workflow signal
        // task_complete does NOT own: some backends (codex, grok's ACP)
        // capture the plan via a native plan item and emit
        // engine_plan_proposal, which the plan-mode reducer already
        // synthesized into permissionDenied — WITHOUT ever putting an
        // ExitPlanMode denial on task_complete (only claude-code does that).
        // Nulling here would wipe the just-synthesized card, so the user gets
        // a clickable plan marker but no approve/implement card. Preserve any
        // outstanding AskUserQuestion / ExitPlanMode entry; it is cleared
        // instead on the next prompt (send-slice) or on approval.
        const existingDenied =
          'permissionDenied' in ctx.instPatch ? ctx.instPatch.permissionDenied : ctx.inst0?.permissionDenied
        // Any outstanding user-facing card survives, not just a lone
        // ExitPlanMode: an AskUserQuestion is equally a question awaiting the
        // user, and a proposal that arrives alongside another denial is still a
        // proposal. The shared predicate is the one definition of that rule
        // (shared/pending-card.ts), so this branch and the session_init branch
        // in event-slice.ts cannot drift apart.
        const isPendingPlanProposal = isPendingUserCardDenial(existingDenied)
        if (isPendingPlanProposal) {
          rInfo('event.task', 'no denials but preserving pending user card', {
            tab_id: tabId.slice(0, 8),
            tools: (existingDenied?.tools ?? []).map((t) => t.toolName).join(','),
          })
        } else {
          rInfo('event.task', 'no denials, clearing card', { tab_id: tabId.slice(0, 8), had_denial: existingDenied != null })
          ctx.instPatch.permissionDenied = null
          ctx.instTouched = true
        }
      }
      void playNotificationIfHidden()
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
      ctx.updated.inboxMessageSuppressed = false
      return true

    case 'error':
      logTabStatusPatch(tabId, ctx.tab.status, 'failed', 'event.task-failed')
      ctx.updated.status = 'failed'
      ctx.updated.lastActivityAt = Date.now()
      ctx.updated.lastFailureAt = Date.now()
      ctx.updated.idleSince = Date.now()
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
      logTabStatusPatch(tabId, ctx.tab.status, 'dead', 'event.task-dead',
        { exit_code: event.exitCode })
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
