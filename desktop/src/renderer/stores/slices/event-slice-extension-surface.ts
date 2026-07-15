// Extension-surface event handlers extracted from event-slice.ts (Fix 1:
// keep the reducer under the 600-line cap). These are the harness/extension
// lifecycle arms of the single normalized-event reducer — they were lifted
// out verbatim, preserving behavior. Each handler mutates the shared reducer
// context (messages, the engine* side-effect maps, the tab `updated` patch)
// through a passed-by-reference context object, exactly as the inline switch
// arms did.
//
// The reducer in event-slice.ts owns the commit; these handlers only stage
// the same local mutations the inline cases used to.
import type { Message } from '../../../shared/types'
import type { ConversationInstance } from '../../../shared/types-engine'
import type { State } from '../session-store-types'
import type { NormalizedEvent } from '../../../shared/types-events'
import { nextMsgId } from '../session-store-helpers'
import { rTrace, rWarn } from '../../rendererLogger'

/**
 * Mutable context shared with the parent reducer for one event. The parent
 * seeds it from its locals, the handler mutates the fields in place (and
 * reassigns the array/map fields), and the parent reads them back after the
 * call. This mirrors the closure-local mutation the inline switch arms relied
 * on, with no behavior change.
 */
export interface ExtensionSurfaceCtx {
  s: State
  tabId: string
  /** The active instance snapshot at reducer entry (read-only here). */
  inst0: (ConversationInstance & { id: string }) | null
  /** Working copy of the active instance's messages (reassigned on append). */
  messages: Message[]
  /** Tab-level patch object; handlers may set status. */
  updated: { status?: string; [k: string]: unknown }
  /** Per-conversation patch object the parent commits onto the instance. */
  instPatch: Partial<ConversationInstance>
  /** Set true when instPatch was mutated (parent reads this back). */
  instTouched: boolean
  /** Side-effect maps; undefined means "no change this event". */
  engineWorkingMessages?: Map<string, string>
  engineNotifications?: Map<string, Array<{ id: string; message: string; level: string; timestamp: number }>>
  engineDialogs?: Map<string, { dialogId: string; method: string; title: string; options?: string[]; defaultValue?: string } | null>
  engineModelFallbacks?: State['engineModelFallbacks']
}

/**
 * Handle the extension-surface event arms. Returns true when the event type
 * was one of these arms (so the parent can skip its own switch for them),
 * false otherwise. Behavior is identical to the former inline cases.
 */
export function handleExtensionSurfaceEvent(ctx: ExtensionSurfaceCtx, event: NormalizedEvent): boolean {
  const { s, tabId } = ctx
  switch (event.type) {
    case 'agent_state':
      // Complete agent-state snapshot. Replace the instance view — do not
      // merge incrementally. The engine contract guarantees a terminal
      // status (done/error/cancelled) for every agent before the next
      // snapshot, so local view stays accurate.
      ctx.instPatch.agentStates = event.agents
      ctx.instTouched = true
      return true

    case 'status':
      // Complete per-session status snapshot, forwarded by the control plane
      // from every engine_status. Replace inst.statusFields wholesale (snapshot
      // semantics, like agent_state) — engine_status always carries the full
      // StatusFields, never a diff. This is what populates inst.statusFields for
      // the StatusBar engine slots (identity, cost, backend badge) and the
      // model-picker actual-model parenthetical; before this arm existed the
      // field was null forever.
      rTrace('event.status', 'statusFields updated', { tab_id: tabId, state: event.fields.state })
      ctx.instPatch.statusFields = event.fields
      ctx.instTouched = true
      return true

    case 'plan_mode_auto_exit':
      // Engine synthesized an auto-exit at end-of-turn. This is a
      // *proposal awaiting user approval*, identical in meaning to a
      // model-driven ExitPlanMode — which does NOT flip permissionMode
      // (see event-slice-plan-mode.ts). Per ADR-003, the instance stays
      // 'plan' until the user approves at the implement-slice.ts
      // chokepoint (onImplement → setPermissionMode('auto','plan_approved'))
      // or changes mode via the manual dropdown. Keeping the instance 'plan'
      // is also correct for tab auto-move: the tab belongs in the planning
      // group until the user decides.
      //
      // Sticky-parent invariant: never write tab.permissionMode here.
      // The regression test in engine-event-slice-plan-auto-exit.test.ts
      // enforces both invariants.
      return true

    case 'model_fallback':
      // Record the model-fallback indicator so TabStripTabPill can show
      // the ⚠ glyph. Keyed by bare tabId — one fallback slot per tab.
      if (ctx.inst0) {
        ctx.engineModelFallbacks = new Map(s.engineModelFallbacks)
        ctx.engineModelFallbacks.set(tabId, {
          requestedModel: event.requestedModel,
          fallbackModel: event.fallbackModel,
          reason: event.reason,
          at: Date.now(),
        })
      }
      return true

    case 'harness_message': {
      // Extension harness display message. Three dedup paths:
      //
      // 1. dedupMode === 'relocate' + dedupKey present: remove any existing
      //    message with that dedupKey from scrollback, then append the new
      //    marker at the end. The marker always stays current — never trails
      //    behind new conversation turns.
      // 2. dedupKey present (no dedupMode / dedupMode absent): suppress-later
      //    — if a message with the same key already exists, drop this one.
      // 3. No dedupKey: append unconditionally.
      const dk = event.dedupKey
      const newMsg = {
        id: nextMsgId(),
        role: 'harness' as any,
        content: event.message,
        timestamp: Date.now(),
        ...(dk ? { dedupKey: dk } : {}),
        ...(event.source ? { harnessSource: event.source } : {}),
      }
      if (event.dedupMode === 'relocate' && dk) {
        // Remove the existing keyed marker (if any), then append the fresh one.
        ctx.messages = [
          ...ctx.messages.filter((m) => (m as any).dedupKey !== dk),
          newMsg,
        ]
      } else {
        const alreadyPresent = dk
          ? ctx.messages.some((m) => (m as any).dedupKey === dk)
          : false
        if (!alreadyPresent) {
          ctx.messages = [...ctx.messages, newMsg]
        }
      }
      return true
    }

    case 'working_message':
      // Transient activity string. Empty string clears the indicator.
      ctx.engineWorkingMessages = new Map(s.engineWorkingMessages)
      if (event.message) {
        ctx.engineWorkingMessages.set(tabId, event.message)
      } else {
        ctx.engineWorkingMessages.delete(tabId)
      }
      return true

    case 'notify':
      // Ephemeral toast notification. Push to the engineNotifications list
      // keyed by bare tabId (matches ConversationView's read key).
      {
        const existing = s.engineNotifications.get(tabId) || []
        ctx.engineNotifications = new Map(s.engineNotifications)
        ctx.engineNotifications.set(tabId, [
          ...existing,
          { id: nextMsgId(), message: event.message, level: event.level, timestamp: Date.now() },
        ])
      }
      return true

    case 'dialog':
      // Modal prompt from the harness. Store under bare tabId so
      // EngineDialog can resolve it without the compound key.
      ctx.engineDialogs = new Map(s.engineDialogs)
      ctx.engineDialogs.set(tabId, {
        dialogId: event.dialogId,
        method: event.method,
        title: event.title,
        options: event.options,
        defaultValue: event.defaultValue,
      })
      return true

    case 'message_end':
      // End of one LLM message within a multi-turn run. Seal the last
      // assistant text row so the next text_chunk starts a fresh row
      // instead of appending to this one. When the event carries the
      // canonical persisted entry ids, re-key the rows to them: the sealed
      // assistant row takes entryId and the turn's user row takes
      // userEntryId, so a later history load (SessionLoadMessage.id) dedups
      // against these rows instead of duplicating them.
      {
        // The message being closed is the most recent assistant TEXT row —
        // walk back past the turn's tool rows (message_end fires after the
        // stream ends but before tool results arrive, so tool rows can sit
        // above the text row). Stop at a user row: nothing to seal.
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
          const m = ctx.messages[i]
          if (m.role === 'user') break
          if (m.role === 'assistant' && !m.toolName) {
            // An already-sealed row belongs to an earlier message_end (this
            // one closed a tool-only assistant message) — its identity is
            // final; never re-key it to a later entry id.
            if (!m.sealed) {
              ctx.messages = [
                ...ctx.messages.slice(0, i),
                { ...m, sealed: true, ...(event.entryId ? { id: event.entryId } : {}) },
                ...ctx.messages.slice(i + 1),
              ]
            }
            break
          }
        }
        if (event.userEntryId) {
          // Re-key the most recent user row (the run-opening turn). A row
          // that already carries the canonical id — a prior message_end of
          // the same run, or a hydrated history row — is left untouched.
          for (let i = ctx.messages.length - 1; i >= 0; i--) {
            const m = ctx.messages[i]
            if (m.role === 'user') {
              if (m.id !== event.userEntryId) {
                ctx.messages = [
                  ...ctx.messages.slice(0, i),
                  { ...m, id: event.userEntryId },
                  ...ctx.messages.slice(i + 1),
                ]
              }
              break
            }
          }
        }
      }
      return true

    case 'extension_died':
      // Extension subprocess crashed. Push an ephemeral notification.
      {
        const existing2 = s.engineNotifications.get(tabId) || []
        ctx.engineNotifications = new Map(s.engineNotifications)
        ctx.engineNotifications.set(tabId, [
          ...existing2,
          { id: nextMsgId(), message: `Extension ${event.extensionName} died — attempting restart`, level: 'warning', timestamp: Date.now() },
        ])
      }
      return true

    case 'extension_respawned':
      // Extension subprocess recovered. Push a clearing notification.
      {
        const existing3 = s.engineNotifications.get(tabId) || []
        ctx.engineNotifications = new Map(s.engineNotifications)
        ctx.engineNotifications.set(tabId, [
          ...existing3,
          { id: nextMsgId(), message: `Extension ${event.extensionName} restarted (attempt ${event.attemptNumber})`, level: 'info', timestamp: Date.now() },
        ])
      }
      return true

    case 'extension_dead_permanent':
      // Extension exceeded crash budget. Mark error so user sees it.
      ctx.messages = [
        ...ctx.messages,
        {
          id: nextMsgId(),
          role: 'system',
          content: `Extension ${event.extensionName} failed permanently after ${event.attemptNumber} restart attempts. Close and reopen the tab to recover.`,
          timestamp: Date.now(),
        },
      ]
      ctx.updated.status = 'failed'
      return true

    case 'events_dropped':
      // Buffer overflow. Log only; no UI action (state may be stale but
      // there's nothing useful the user can do except wait).
      rWarn('event.buffer', 'events dropped', { tab_id: tabId, count: event.count })
      return true
  }
  return false
}
