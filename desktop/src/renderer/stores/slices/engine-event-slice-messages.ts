/**
 * engine-event-slice-messages — message-writing engine event handlers
 *
 * Extracted from engine-event-slice.ts to keep that file under the
 * 600-line TypeScript cap. Handles all engine events that write messages,
 * notifications, or resource state into the store:
 *
 *   Cross-cutting (apply before the engine-tab-only guard):
 *     engine_command_registry, engine_command_result
 *     engine_resource_snapshot, engine_resource_delta  ← global AND session
 *     engine_notification
 *
 *   Engine-tab-only (compound key required):
 *     engine_tool_start, engine_tool_update, engine_tool_end
 *     engine_dead, engine_error
 *     engine_extension_died, engine_extension_respawned,
 *     engine_extension_dead_permanent, engine_events_dropped
 *     engine_run_stalled
 *     engine_compacting
 *     engine_plan_mode_changed
 *     engine_steer_injected
 *     engine_model_fallback
 *
 * IMPORTANT: engine_resource_snapshot and engine_resource_delta are
 * cross-cutting, not engine-tab-only. Global (workspace-scoped) resources
 * arrive with key="" which contains no ":" and would be silently dropped
 * by the engine-tab-only guard. Both resource event types are handled in
 * handleCrossEngineEvent so they fire for any key, including "".
 *
 * The dispatch site (engine-event-slice.ts:handleEngineEvent) calls
 * handleCrossEngineEvent for the first group (before the compound-key
 * guard) and handleMessageEvents for the second group (inside the
 * switch on event.type after the guard).
 *
 * Returns true when the caller should break/return from its dispatch
 * loop (for cross-cutting events that short-circuit further processing),
 * or void when the event was handled inline.
 */

import type { StoreSet, StoreGet } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { formatClearDivider, formatPlanCreatedDivider, formatSteerAppliedDivider } from '../../../shared/clear-divider'
import { applyResourceSnapshot, applyResourceDelta } from './resource-slice'
import type { ResourceItem } from '../../../shared/types-engine'
import { extensionCommandsByKey, withInstanceMessages, withRunningAgentsErrored } from './engine-event-slice-helpers'
import { withInstancePatch } from './engine-event-status'
import { commitInstance } from '../conversation-instance'
import { parseSessionKey, instanceIdFromKey, tabIdFromKey, isCompoundKey } from '../../../shared/session-key'

/**
 * Handle cross-cutting events that apply to both CLI tabs (bare tabId key)
 * and engine tabs (compound tabId:instanceId key).
 *
 * Returns true if the event was handled and the caller should return
 * immediately (no further processing needed).
 */
export function handleCrossEngineEvent(
  set: StoreSet,
  _get: StoreGet,
  key: string,
  event: any,
): boolean {
  if (event.type === 'engine_command_registry') {
    const listings = Array.isArray(event.commands) ? event.commands : []
    if (listings.length === 0) {
      extensionCommandsByKey.delete(key)
    } else {
      extensionCommandsByKey.set(key, listings.map((l: { name: string; description?: string }) => ({ name: l.name, description: l.description })))
    }
    // No store mutation here — autocomplete reads via
    // getRendererExtensionCommands() during keystroke handling, not
    // through reactive subscriptions. The renderer re-renders on the
    // next keystroke and pulls a fresh list.
    return true
  }
  if (event.type === 'engine_command_result') {
    // Engine confirms a command dispatch. We use this for two things:
    //   1. The /clear divider — drawn when command='clear' and
    //      commandError is empty. The unified pipeline collapsed the
    //      legacy renderer-side divider injection into this single
    //      engine-driven trigger so desktop and iOS render the divider
    //      from the same signal.
    //   2. (Future) /export markdown banner, /compact confirmation,
    //      and any extension-emitted command result that wants a
    //      visible system bubble.
    //
    // For now we only branch on /clear because the other built-ins
    // (export, compact) had no renderer-side feedback in the legacy
    // path either.
    const cmdName = event.command || ''
    const failed = !!event.commandError
    const tabIdForCmd = tabIdFromKey(key)
    if (cmdName === 'clear' && !failed) {
      const divider = formatClearDivider(new Date())
      // STREAM DISCRIMINATOR: compound key = raw extension stream (engine-hosted instance); bare = plain conversation's /clear via the normalized path.
      if (isCompoundKey(key)) {
        // Engine tab — insert the clear divider into instance messages AND
        // clear any pending AskUserQuestion / ExitPlanMode card on this
        // instance. /clear is a checkpoint that dismisses the pending
        // question along with the conversation history. The engine already
        // stopped retaining/re-emitting the denial (command_dispatch.go
        // dispatchClear), but the renderer's engine_status handler PRESERVES
        // an existing permissionDenied on denial-free ticks (anti-flicker),
        // so a nil-denial status snapshot will NOT clear an already-displayed
        // card. We clear it here, on the explicit /clear signal. Only the
        // instance addressed by the compound key is touched, not every
        // instance on the tab.
        set((state) => {
          const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
          const pane = state.conversationPanes.get(tabIdInner)
          const inst = pane?.instances.find((i) => i.id === instanceId)
          const msgs = [...(inst?.messages || []), { id: nextMsgId(), role: 'system' as const, content: divider, timestamp: Date.now() }]
          const withMsgs = withInstanceMessages(state.conversationPanes, key, msgs)
          const conversationPanes = withInstancePatch(withMsgs, key, { permissionDenied: null })
          return { conversationPanes }
        })
      } else {
        // CLI tab — insert the clear divider into the tab's `main`
        // conversation instance AND clear any pending permissionDenied card.
        // The waiting pill is derived from permissionDenied
        // (TabStripShared.getWaitingState), so clearing it settles the pill
        // back to idle. Same rationale as the engine-tab branch above: the
        // explicit /clear signal is where we dismiss the card, since
        // denial-free status ticks preserve it.
        set((state) => {
          const conversationPanes = commitInstance(state.conversationPanes, tabIdForCmd, (inst) => ({
            ...inst,
            messages: [...inst.messages, { id: nextMsgId(), role: 'system' as const, content: divider, timestamp: Date.now() }],
            permissionDenied: null,
          }))
          return { conversationPanes }
        })
      }
    }
    return true
  }
  if (event.type === 'engine_resource_snapshot') {
    // Resource snapshot: replace the entire collection for this kind.
    //
    // Cross-cutting: global (workspace-scoped) resources arrive with key=""
    // which has no ":" and would be dropped by the engine-tab-only guard.
    // Session-scoped resources arrive with a compound key. Both are handled
    // here so neither is silently discarded.
    //
    // Scoping signal: items with conversationId are session-scoped (belong
    // to one conversation's attachments panel). Items without conversationId
    // are workspace-scoped (appear in the global notifications panel).
    // The renderer uses ResourceItem.conversationId to route them at display
    // time; the store holds all items in a flat kind-keyed map.
    const items: ResourceItem[] = event.resourceItems ?? []
    const scope = key === '' ? 'global' : `session:${key}`
    console.log(
      `[resource] snapshot kind=${event.resourceKind} subId=${event.resourceSubId} ` +
      `items=${items.length} scope=${scope}`,
    )
    set((state) =>
      applyResourceSnapshot(
        { resources: state.resources, resourceSubscriptions: state.resourceSubscriptions, readResourceIds: state.readResourceIds },
        event.resourceKind,
        event.resourceSubId,
        items,
      ),
    )
    return true
  }
  if (event.type === 'engine_resource_delta') {
    // Resource delta: incremental update for this kind.
    //
    // Cross-cutting for the same reason as engine_resource_snapshot: global
    // resources arrive with key="" and must not be dropped by the guard.
    if (event.resourceDelta) {
      const delta = event.resourceDelta
      const scope = key === '' ? 'global' : `session:${key}`
      console.log(
        `[resource] delta kind=${event.resourceKind} op=${delta.op} ` +
        `id=${delta.item?.id?.slice(-8)} ` +
        `convId=${delta.item?.conversationId ?? 'global'} scope=${scope}`,
      )
      set((state) =>
        applyResourceDelta(
          { resources: state.resources, resourceSubscriptions: state.resourceSubscriptions, readResourceIds: state.readResourceIds },
          event.resourceKind,
          delta,
        ),
      )
    }
    return true
  }
  if (event.type === 'engine_notification') {
    // Notification from extension ctx.notify(). Push delivery (APNs) is
    // handled by the relay — the desktop only logs for observability so
    // investigations can confirm the notification reached the renderer.
    const scope = key === '' ? 'global' : `session:${key}`
    console.log(
      `[resource] notification kind=${event.notifyKind ?? '?'} title=${event.notifyTitle ?? '?'} ` +
      `push=${event.push} scope=${scope}`,
    )
    return true
  }
  return false
}

/**
 * Handle message-writing engine-tab-only events (compound key required).
 * Called from inside the switch(event.type) block in handleEngineEvent,
 * after the compound-key guard has already passed.
 *
 * Returns true when the case was handled (caller should break), false
 * when the event type is not recognized here (caller falls through).
 */
export function handleMessageEvents(
  set: StoreSet,
  _get: StoreGet,
  key: string,
  tabId: string,
  event: any,
): boolean {
  switch (event.type) {
    case 'engine_tool_start': {
      set((state) => {
        const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
        const pane = state.conversationPanes.get(tabIdInner)
        const inst = pane?.instances.find((i) => i.id === instanceId)
        const msgs = [...(inst?.messages || []), {
          id: event.toolId,
          role: 'tool' as const,
          content: '',
          toolName: event.toolName,
          toolId: event.toolId,
          toolStatus: 'running' as const,
          timestamp: Date.now(),
        }]
        const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
        return { conversationPanes }
      })
      return true
    }
    case 'engine_tool_update': {
      // The engine streams tool input incrementally as the model
      // generates JSON. We accumulate the partial chunks onto the
      // tool message's `toolInput` field so the persistence layer
      // can serialize the final value (used by PermissionDeniedCard
      // to render AskUserQuestion / ExitPlanMode question text and
      // plan content on a fresh launch). Without this capture,
      // `messages[*].toolInput` was always undefined and the
      // card lost its content across restarts.
      //
      // Snapshot semantics: each engine_tool_update is incremental
      // — we concatenate partial chunks. The final value is the
      // complete JSON-string toolInput. Storing it on the message
      // (instead of a separate map) mirrors how CLI tabs do it via
      // event-slice.ts so PermissionDeniedCard's fallback scan
      // (`messages.find((m) => m.toolName === 'AskUserQuestion' &&
      // m.toolInput)`) finds it on engine tabs too.
      if (!event.toolId) return true
      set((state) => {
        const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
        const pane = state.conversationPanes.get(tabIdInner)
        const inst = pane?.instances.find((i) => i.id === instanceId)
        const msgs = (inst?.messages || []).map((m) => {
          if (m.toolId !== event.toolId) return m
          return { ...m, toolInput: (m.toolInput || '') + (event.partialInput || '') }
        })
        const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
        return { conversationPanes }
      })
      return true
    }
    case 'engine_tool_end': {
      set((state) => {
        const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
        const pane = state.conversationPanes.get(tabIdInner)
        const inst = pane?.instances.find((i) => i.id === instanceId)
        const msgs = (inst?.messages || []).map((m) => {
          if (m.toolId !== event.toolId) return m
          return { ...m, content: event.result || '', toolStatus: (event.isError ? 'error' : 'completed') as 'error' | 'completed' }
        })
        const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
        return { conversationPanes }
      })
      return true
    }
    case 'engine_dead': {
      console.warn(`[Ion] handleEngineEvent engine_dead: key=${key} tabId=${tabId} exitCode=${event.exitCode}`)
      if (event.exitCode === 0 || event.exitCode === null || event.exitCode === undefined) {
        return true
      }
      set((state) => {
        const pane = state.conversationPanes.get(tabId)
        const instanceId = instanceIdFromKey(key)
        const otherInstances = pane?.instances.filter((i) => i.id !== instanceId) || []
        // Flip any running agents to error — the engine is dead so they
        // can't complete.  Preserves done/idle/cancelled entries so the
        // AgentPanel's post-completion inspection UI remains intact.
        const conversationPanes = withRunningAgentsErrored(state.conversationPanes, key)
        if (otherInstances.length === 0) {
          const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'dead' as const } : t)
          return { tabs, conversationPanes }
        }
        return { conversationPanes }
      })
      return true
    }
    case 'engine_error': {
      // Extension errors are operational diagnostics, not conversation
      // content. Route them to ephemeral toast notifications (consistent with
      // engine_extension_died / engine_extension_respawned) instead of
      // persisting them into the message stream where they clutter restored
      // conversations.
      const extensionErrorCodes = new Set([
        'extension_died',       // subprocess died (host_io.go)
        'hook_failed',          // hook execution error (hook_errors.go)
        'extension_load_failed', // extension failed to load (start_session.go)
        'extension_respawn_failed', // respawn attempt failed (host_death.go)
      ])
      if (event.errorCode && extensionErrorCodes.has(event.errorCode)) {
        set((state) => {
          const notifications = new Map(state.engineNotifications)
          const keyNotifications = [...(notifications.get(key) || [])]
          keyNotifications.push({
            id: nextMsgId(),
            message: event.message,
            level: 'error',
            timestamp: Date.now(),
          })
          notifications.set(key, keyNotifications)
          // Still flip running agents to error — the extension is dead so
          // hooks can't complete.
          const conversationPanes = withRunningAgentsErrored(state.conversationPanes, key)
          return { engineNotifications: notifications, conversationPanes }
        })
        return true
      }
      set((state) => {
        const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
        const pane = state.conversationPanes.get(tabIdInner)
        const inst = pane?.instances.find((i) => i.id === instanceId)
        const msgs = [...(inst?.messages || []), { id: nextMsgId(), role: 'system' as const, content: `Error: ${event.message}`, timestamp: Date.now() }]
        const isActive = !pane || pane.activeInstanceId === instanceId
        const tabs = isActive
          ? state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
          : state.tabs
        // Flip any running agents to error — the engine errored so they
        // can't complete.  Preserves done/idle/cancelled entries.
        let conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
        conversationPanes = withRunningAgentsErrored(conversationPanes, key)
        return { tabs, conversationPanes }
      })
      return true
    }
    case 'engine_extension_died': {
      set((state) => {
        const notifications = new Map(state.engineNotifications)
        const keyNotifications = [...(notifications.get(key) || [])]
        keyNotifications.push({
          id: nextMsgId(),
          message: `Extension ${event.extensionName} died — restarting…`,
          level: 'warning',
          timestamp: Date.now(),
        })
        notifications.set(key, keyNotifications)
        return { engineNotifications: notifications }
      })
      return true
    }
    case 'engine_extension_respawned': {
      set((state) => {
        const notifications = new Map(state.engineNotifications)
        const keyNotifications = [...(notifications.get(key) || [])]
        keyNotifications.push({
          id: nextMsgId(),
          message: `Extension ${event.extensionName} restarted (attempt ${event.attemptNumber})`,
          level: 'info',
          timestamp: Date.now(),
        })
        notifications.set(key, keyNotifications)
        return { engineNotifications: notifications }
      })
      return true
    }
    case 'engine_extension_dead_permanent': {
      // Route to ephemeral toast notification — not the conversation stream.
      // Extension crash diagnostics are noise in restored conversations.
      // Consistent with engine_extension_died / engine_extension_respawned.
      set((state) => {
        const notifications = new Map(state.engineNotifications)
        const keyNotifications = [...(notifications.get(key) || [])]
        keyNotifications.push({
          id: nextMsgId(),
          message: `Extension ${event.extensionName} crashed ${event.attemptNumber} times in 60s and will not be restarted automatically. Close and reopen this tab to recover.`,
          level: 'error',
          timestamp: Date.now(),
        })
        notifications.set(key, keyNotifications)
        return { engineNotifications: notifications }
      })
      return true
    }
    case 'engine_events_dropped': {
      set((state) => {
        const notifications = new Map(state.engineNotifications)
        const keyNotifications = [...(notifications.get(key) || [])]
        keyNotifications.push({
          id: nextMsgId(),
          message: `Connection fell behind — ${event.count} events dropped. State may be stale.`,
          level: 'warning',
          timestamp: Date.now(),
        })
        notifications.set(key, keyNotifications)
        return { engineNotifications: notifications }
      })
      return true
    }
    case 'engine_run_stalled': {
      console.log(`[engine] run_stalled key=${key} duration=${event.runStalledDuration} lastActivity=${event.runStalledLastActivity ?? 'unknown'}`)
      return true
    }
    case 'engine_compacting': {
      if (event.active) {
        set((state) => {
          const workingMessages = new Map(state.engineWorkingMessages)
          workingMessages.set(key, 'Compacting...')
          return { engineWorkingMessages: workingMessages }
        })
      } else {
        set((state) => {
          const workingMessages = new Map(state.engineWorkingMessages)
          workingMessages.set(key, '')
          if (!event.messagesBefore && !event.summary) {
            return { engineWorkingMessages: workingMessages }
          }
          const parts = ['[Compaction]']
          if (event.strategy) parts.push(event.strategy)
          if (event.messagesBefore && event.messagesAfter != null) {
            parts.push(`${event.messagesBefore} → ${event.messagesAfter} messages`)
          }
          if (event.clearedBlocks) parts.push(`${event.clearedBlocks} blocks cleared`)
          let content = parts.join(' · ')
          if (event.summary) content += '\n\n' + event.summary
          const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
          const pane = state.conversationPanes.get(tabIdInner)
          const inst = pane?.instances.find((i) => i.id === instanceId)
          const msgs = [...(inst?.messages || []), {
            id: nextMsgId(),
            role: 'system' as const,
            content,
            timestamp: Date.now(),
          }]
          const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
          return { engineWorkingMessages: workingMessages, conversationPanes }
        })
      }
      return true
    }
    case 'engine_plan_mode_changed': {
      // Insert a "Plan created" divider into the engine conversation
      // each time plan mode is entered. This fires on every entry
      // (including re-entry after implementation), producing the
      // repeating cycle: Session started → Plan created → Implementing
      // → Plan created → Implementing → …
      if (event.planModeEnabled) {
        set((state) => {
          const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
          const pane = state.conversationPanes.get(tabIdInner)
          if (!pane) return {}
          const idx = pane.instances.findIndex((i) => i.id === instanceId)
          if (idx === -1) return {}
          const inst = pane.instances[idx]
          const msgs = [...(inst.messages || []), {
            id: nextMsgId(),
            role: 'system' as const,
            content: formatPlanCreatedDivider(new Date(), event.planSlug),
            timestamp: Date.now(),
            planFilePath: event.planFilePath,
          }]
          const updatedPanes = new Map(state.conversationPanes)
          const instances = pane.instances.slice()
          instances[idx] = {
            ...instances[idx],
            messages: msgs,
            planFilePath: event.planFilePath ?? instances[idx].planFilePath,
          }
          updatedPanes.set(tabIdInner, { ...pane, instances })
          return { conversationPanes: updatedPanes }
        })
      }
      return true
    }
    case 'engine_steer_injected': {
      // The engine drained a mid-turn steer message into the
      // conversation as a user turn. Insert a divider so the user
      // can see where their steer landed in the scrollback. The
      // engine emits this from three checkpoints (between turns,
      // before end_turn exit, after tool results) — each capture
      // gets its own divider so the user sees the count.
      set((state) => {
        const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
        const pane = state.conversationPanes.get(tabIdInner)
        const inst = pane?.instances.find((i) => i.id === instanceId)
        const msgs = [...(inst?.messages || []), {
          id: nextMsgId(),
          role: 'system' as const,
          content: formatSteerAppliedDivider(new Date(), event.steerMessageLength),
          timestamp: Date.now(),
        }]
        const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
        return { conversationPanes }
      })
      return true
    }
    case 'engine_model_fallback': {
      // The engine fell back to its configured defaultModel because
      // the requested model didn't resolve to a provider. This
      // client's policy: show a small ⚠ glyph on the affected
      // engine instance pill via EngineTabStrip. The fact is
      // stored per-instance (compound key) and cleared on the next
      // engine_status state=idle for that same instance (see the
      // `state === 'idle'` branch in engine-event-status.ts).
      //
      // Engine event semantics: ModelFallbackEvent is a workflow
      // signal, not a state snapshot — it fires once at the swap
      // site. Persisting it in renderer state is renderer policy,
      // not engine policy; another consumer (headless harness,
      // future CLI client) is free to ignore the event entirely.
      // See CLAUDE.md § "The typed-event corollary".
      set((state) => {
        const fallbacks = new Map(state.engineModelFallbacks)
        fallbacks.set(key, {
          requestedModel: event.fallbackRequestedModel,
          fallbackModel: event.fallbackModel,
          reason: event.fallbackReason,
          at: Date.now(),
        })
        return { engineModelFallbacks: fallbacks }
      })
      return true
    }
    default:
      return false
  }
}
