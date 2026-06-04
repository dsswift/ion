import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { formatClearDivider, formatPlanCreatedDivider, formatSteerAppliedDivider } from '../../../shared/clear-divider'
import { handleEngineStatusEvent } from './engine-event-status'

/**
 * Per-tab cache of extension-registered command names, populated by
 * engine_command_registry snapshots emitted from the Go engine. Used by
 * the slash-autocomplete UI in InputBar so extension commands appear in
 * the menu alongside filesystem `.md` discoveries. Keyed by engine session
 * key (tabId or `${tabId}:${instanceId}`) — autocomplete reads under the
 * active tab/instance combination.
 *
 * Snapshot semantics: every event REPLACES the prior set. An empty
 * `commands: []` is the authoritative "no extension commands" signal and
 * clears the entry. Mirrors the main-process cache in
 * `desktop/src/main/state.ts:extensionCommandRegistry`.
 */
const extensionCommandsByKey = new Map<string, Array<{ name: string; description?: string }>>()

/** Get a snapshot of the current extension commands for an engine session key.
 *  Used by autocomplete; returns an empty array when no commands are cached. */
export function getRendererExtensionCommands(key: string): Array<{ name: string; description?: string }> {
  return extensionCommandsByKey.get(key) ?? []
}

export function createEngineEventSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    handleEngineEvent: (key, event) => {
      // engine_command_registry and engine_command_result are CROSS-CUTTING
      // events that apply to both CLI tabs (bare tabId key) and engine tabs
      // (compound tabId:instanceId key). We dispatch on them BEFORE the
      // engine-tab-only guard below so they reach the correct slice.
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
        return
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
        const tabIdForCmd = key.includes(':') ? key.split(':')[0] : key
        if (cmdName === 'clear' && !failed) {
          const divider = formatClearDivider(new Date())
          if (key.includes(':')) {
            // Engine tab — insert into engineMessages keyed by the compound key.
            set((state) => {
              const messages = new Map(state.engineMessages)
              const msgs = [...(messages.get(key) || [])]
              msgs.push({ id: nextMsgId(), role: 'system' as const, content: divider, timestamp: Date.now() })
              messages.set(key, msgs)
              return { engineMessages: messages }
            })
          } else {
            // CLI tab — insert into the tab's local messages array.
            set((state) => ({
              tabs: state.tabs.map((t) => t.id === tabIdForCmd
                ? { ...t, messages: [...t.messages, { id: nextMsgId(), role: 'system' as const, content: divider, timestamp: Date.now() }] }
                : t),
            }))
          }
        }
        return
      }

      if (!key.includes(':')) return

      const tabId = key.split(':')[0]
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, lastEventAt: Date.now() } : t)),
      }))
      switch (event.type) {
        case 'engine_agent_state': {
          // Engine contract: `engine_agent_state` is a COMPLETE SNAPSHOT
          // of every agent the engine considers live. Replace local state
          // with the payload — do not merge, do not retain prior entries.
          // The engine guarantees a follow-up snapshot for every
          // terminating agent, so any agent missing from this payload is
          // genuinely no longer live. See docs/architecture/agent-state.md.
          //
          // Historically this slice retained "historical" agents (status
          // != running with a conversationId) when the engine sent an
          // empty array. That preservation rule was the bug behind the
          // iOS "stale agent" reports — the desktop renderer would hold
          // onto rows the engine had already retired, and on reconnect
          // sendCurrentEngineState would forward those stale rows to iOS.
          // Removed: the engine is authoritative.
          const agents = event.agents || []
          const statusSummary = agents.map((a: any) => `${a.name}:${a.status}`).join(',')
          console.log(`[store] agent_state: key=${key} count=${agents.length} replaced [${statusSummary}]`)
          set((state) => {
            const agentStates = new Map(state.engineAgentStates)
            agentStates.set(key, agents)
            return { engineAgentStates: agentStates }
          })
          break
        }
        case 'engine_status': {
          // Delegated to engine-event-status.ts to keep this switch
          // file under the 600-line TypeScript cap. The helper returns
          // `didCaptureNewSessionId` so we can trigger the immediate
          // persistence flush below — that signal is the only piece of
          // post-reducer behavior the slice still owns for this event.
          const { didCaptureNewSessionId } = handleEngineStatusEvent(set, key, tabId, event)
          // Durability: persist immediately whenever a new sessionId
          // arrived. The default subscriber debounces saves at 100 ms,
          // which is normally fine but creates a window where a hard
          // kill (OS terminated us, laptop lid closed mid-write) drops
          // the sessionId. The cost of an extra synchronous IPC write
          // is small (one fs.writeFileSync via atomicWriteFileSync) and
          // only happens at session-start transitions, not on every
          // status tick. `__ionForceFlushTabs` is wired in
          // session-store-persistence.ts:setupPersistence — it clears
          // the pending debounce timer and runs persistTabs() now.
          if (didCaptureNewSessionId) {
            const flush = (window as { __ionForceFlushTabs?: () => void }).__ionForceFlushTabs
            if (typeof flush === 'function') {
              console.log(`[engine_status] forcing immediate persist after sessionId capture key=${key}`)
              flush()
            }
          }
          break
        }
        case 'engine_working_message': {
          set((state) => {
            const workingMessages = new Map(state.engineWorkingMessages)
            workingMessages.set(key, event.message)
            return { engineWorkingMessages: workingMessages }
          })
          break
        }
        case 'engine_notify': {
          set((state) => {
            const notifications = new Map(state.engineNotifications)
            const keyNotifications = [...(notifications.get(key) || [])]
            keyNotifications.push({ id: nextMsgId(), message: event.message, level: event.level, timestamp: Date.now() })
            notifications.set(key, keyNotifications)
            return { engineNotifications: notifications }
          })
          break
        }
        case 'engine_harness_message': {
          // Dedup hook: if the engine carries `metadata.dedupKey` on the
          // event, suppress the push when a prior harness message in this
          // engine-instance scrollback already has the same key. The
          // engine treats `metadata` as opaque pass-through; this is the
          // renderer-honored convention (see docs/protocol/server-events.md
          // and Message.dedupKey in types-session.ts). Non-harness roles
          // ignore the field. Bare harness messages with no metadata opt
          // out — both push, no dedup applied.
          const metaUnknown = (event as { metadata?: unknown }).metadata
          const dedupKeyRaw =
            metaUnknown && typeof metaUnknown === 'object'
              ? (metaUnknown as Record<string, unknown>).dedupKey
              : undefined
          const dedupKey =
            typeof dedupKeyRaw === 'string' && dedupKeyRaw.length > 0 ? dedupKeyRaw : undefined
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            if (dedupKey) {
              const prior = msgs.find((m) => m.role === 'harness' && m.dedupKey === dedupKey)
              if (prior) {
                // Log both sides of the decision so investigations don't
                // require guessing why a "missing" welcome did not appear.
                console.log(
                  `[store] engine_harness_message dedup: key=${key} dedupKey=${dedupKey} ` +
                  `prior=${prior.id} priorTs=${prior.timestamp} dropped duplicate emission`,
                )
                return state
              }
              console.log(
                `[store] engine_harness_message dedup: key=${key} dedupKey=${dedupKey} ` +
                `no prior match — pushing as the first occurrence`,
              )
            }
            msgs.push({
              id: nextMsgId(),
              role: 'harness' as const,
              content: event.message,
              timestamp: Date.now(),
              ...(dedupKey ? { dedupKey } : {}),
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
        case 'engine_dialog': {
          set((state) => {
            const dialogs = new Map(state.engineDialogs)
            dialogs.set(key, { dialogId: event.dialogId, method: event.method, title: event.title, options: event.options, defaultValue: event.defaultValue })
            return { engineDialogs: dialogs }
          })
          break
        }
        case 'engine_text_delta': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant' && !last.sealed) {
              msgs[msgs.length - 1] = { ...last, content: last.content + event.text }
            } else {
              msgs.push({ id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() })
            }
            messages.set(key, msgs)
            const pane = state.enginePanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
            const tabs = isActive ? state.tabs.map((t) => t.id === tabId ? { ...t, status: 'running' as const } : t) : state.tabs
            return { engineMessages: messages, tabs }
          })
          break
        }
        case 'engine_message_end': {
          // IMPORTANT: `engine_message_end` fires at the end of EVERY LLM
          // message, not at run completion. A single SendPrompt commonly
          // produces several LLM messages (assistant → tool_use →
          // tool_result → assistant → …). Flipping `tab.status` to
          // 'idle' here makes the tab pill stop pulsing, hides the
          // "Thinking…" indicator, and removes the Interrupt button
          // between every turn — even though the engine is still
          // actively running. The next `engine_text_delta` flips status
          // back to 'running', producing a visible flicker and stranding
          // the user without an abort affordance during tool calls.
          //
          // The authoritative idle signal is `engine_status { state:
          // "idle" }` (engine/internal/session/event_translation.go:251-
          // 258) which the engine emits exactly once at true run-exit.
          // That handler (case 'engine_status' above) is the only place
          // that should set `tab.status = 'idle'` from engine activity.
          // `engine_error` and `engine_dead` also reset status; both are
          // terminal.
          //
          // We still update usage/cost here — those are per-message
          // accounting values and are correct between turns.
          set((state) => {
            const usage = new Map(state.engineUsage)
            if (event.usage) {
              usage.set(key, {
                percent: event.usage.contextPercent,
                tokens: event.usage.inputTokens,
                cost: event.usage.cost,
              })
            }
            const pane = state.enginePanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
            const tabs = isActive && event.usage ? state.tabs.map((t) => {
              if (t.id !== tabId) return t
              return {
                ...t,
                contextTokens: event.usage!.inputTokens,
                contextPercent: event.usage!.contextPercent,
              }
            }) : state.tabs
            return { engineUsage: usage, tabs }
          })
          // Seal the current assistant message so the next engine_text_delta
          // creates a new message instead of appending to this one.
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, sealed: true }
              messages.set(key, msgs)
              return { engineMessages: messages }
            }
            return {}
          })
          break
        }
        case 'engine_tool_start': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({
              id: event.toolId,
              role: 'tool' as const,
              content: '',
              toolName: event.toolName,
              toolId: event.toolId,
              toolStatus: 'running' as const,
              timestamp: Date.now(),
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
        case 'engine_tool_update': {
          // The engine streams tool input incrementally as the model
          // generates JSON. We accumulate the partial chunks onto the
          // tool message's `toolInput` field so the persistence layer
          // can serialize the final value (used by PermissionDeniedCard
          // to render AskUserQuestion / ExitPlanMode question text and
          // plan content on a fresh launch). Without this capture,
          // `engineMessages[*].toolInput` was always undefined and the
          // card lost its content across restarts.
          //
          // Snapshot semantics: each engine_tool_update is incremental
          // — we concatenate partial chunks. The final value is the
          // complete JSON-string toolInput. Storing it on the message
          // (instead of a separate map) mirrors how CLI tabs do it via
          // event-slice.ts so PermissionDeniedCard's fallback scan
          // (`messages.find((m) => m.toolName === 'AskUserQuestion' &&
          // m.toolInput)`) finds it on engine tabs too.
          if (!event.toolId) break
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = (messages.get(key) || []).map((m) => {
              if (m.toolId !== event.toolId) return m
              return { ...m, toolInput: (m.toolInput || '') + (event.partialInput || '') }
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
        case 'engine_tool_end': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = (messages.get(key) || []).map((m) => {
              if (m.toolId !== event.toolId) return m
              return { ...m, content: event.result || '', toolStatus: (event.isError ? 'error' : 'completed') as 'error' | 'completed' }
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
        case 'engine_dead': {
          console.warn(`[Ion] handleEngineEvent engine_dead: key=${key} tabId=${tabId} exitCode=${event.exitCode}`)
          if (event.exitCode === 0 || event.exitCode === null || event.exitCode === undefined) {
            break
          }
          set((state) => {
            const pane = state.enginePanes.get(tabId)
            const instanceId = key.split(':')[1]
            const otherInstances = pane?.instances.filter((i) => i.id !== instanceId) || []
            if (otherInstances.length === 0) {
              const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'dead' as const } : t)
              return { tabs }
            }
            return {}
          })
          break
        }
        case 'engine_error': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({ id: nextMsgId(), role: 'system' as const, content: `Error: ${event.message}`, timestamp: Date.now() })
            messages.set(key, msgs)
            const pane = state.enginePanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
            const tabs = isActive
              ? state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
              : state.tabs
            return { engineMessages: messages, tabs }
          })
          break
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
          break
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
          break
        }
        case 'engine_extension_dead_permanent': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({
              id: nextMsgId(),
              role: 'system' as const,
              content: `Extension ${event.extensionName} crashed ${event.attemptNumber} times in 60s and will not be restarted automatically. Close and reopen this tab to recover.`,
              timestamp: Date.now(),
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
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
          break
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
              const messages = new Map(state.engineMessages)
              const msgs = [...(messages.get(key) || [])]
              msgs.push({
                id: nextMsgId(),
                role: 'system' as const,
                content,
                timestamp: Date.now(),
              })
              messages.set(key, msgs)
              return { engineWorkingMessages: workingMessages, engineMessages: messages }
            })
          }
          break
        }
        case 'engine_plan_mode_changed': {
          // Insert a "Plan created" divider into the engine conversation
          // each time plan mode is entered. This fires on every entry
          // (including re-entry after implementation), producing the
          // repeating cycle: Session started → Plan created → Implementing
          // → Plan created → Implementing → …
          if (event.planModeEnabled) {
            set((state) => {
              const messages = new Map(state.engineMessages)
              const msgs = [...(messages.get(key) || [])]
              msgs.push({
                id: nextMsgId(),
                role: 'system' as const,
                content: formatPlanCreatedDivider(new Date(), event.planSlug),
                timestamp: Date.now(),
                planFilePath: event.planFilePath,
              })
              messages.set(key, msgs)
              return { engineMessages: messages }
            })
          }
          break
        }
        case 'engine_steer_injected': {
          // The engine drained a mid-turn steer message into the
          // conversation as a user turn. Insert a divider so the user
          // can see where their steer landed in the scrollback. The
          // engine emits this from three checkpoints (between turns,
          // before end_turn exit, after tool results) — each capture
          // gets its own divider so the user sees the count.
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({
              id: nextMsgId(),
              role: 'system' as const,
              content: formatSteerAppliedDivider(new Date(), event.steerMessageLength),
              timestamp: Date.now(),
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
      }
    },
  }
}
