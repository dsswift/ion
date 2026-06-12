import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { handleEngineStatusEvent } from './engine-event-status'
import { handleEngineInterceptEvent } from './engine-event-slice-intercept'
import {
  withInstanceMessages,
  withInstanceAgentStates,
} from './engine-event-slice-helpers'
import {
  handleCrossEngineEvent,
  handleMessageEvents,
} from './engine-event-slice-messages'

export { getRendererExtensionCommands } from './engine-event-slice-helpers'

export function createEngineEventSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    handleEngineEvent: (key, event) => {
      // engine_command_registry and engine_command_result are CROSS-CUTTING
      // events that apply to both CLI tabs (bare tabId key) and engine tabs
      // (compound tabId:instanceId key). We dispatch on them BEFORE the
      // engine-tab-only guard below so they reach the correct slice.
      if (handleCrossEngineEvent(set, _get, key, event)) return

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
            const enginePanes = withInstanceAgentStates(state.enginePanes, key, agents)
            return { enginePanes }
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
            const [tabIdInner, instanceId] = key.split(':')
            const pane = state.enginePanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            const msgs = [...(inst?.messages || [])]
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
            const enginePanes = withInstanceMessages(state.enginePanes, key, msgs)
            return { enginePanes }
          })
          break
        }
        case 'engine_intercept': {
          // Extracted to engine-event-slice-intercept.ts to keep this file
          // under the 600-line TypeScript cap. See that file for full comments.
          handleEngineInterceptEvent(set, key, event)
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
            const [tabIdInner, instanceId] = key.split(':')
            const pane = state.enginePanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            const msgs = [...(inst?.messages || [])]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant' && !last.sealed) {
              msgs[msgs.length - 1] = { ...last, content: last.content + event.text }
            } else {
              msgs.push({ id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() })
            }
            // Phase 4 of the state-management overhaul. We previously
            // inferred `tab.status = 'running'` from text-delta arrival
            // (gated on the active sub-instance). That inference was
            // wrong on two counts:
            //
            //   1. CLAUDE.md "The typed-event corollary" — engine_status
            //      is the engine's typed signal for state. Text deltas
            //      are message content, not state. Inferring state from
            //      content forces every consumer to keep parallel
            //      bookkeeping and creates the gaps Phase 1 + 2 had to
            //      paper over.
            //
            //   2. The engine already emits engine_status state=running
            //      on prompt dispatch (engine/internal/session/
            //      prompt_dispatch.go) and the new engine_session_status
            //      mirror reaches the renderer through the same
            //      channel. There is no surface where the running state
            //      arrives via text-delta and not via engine_status —
            //      so the inference was always redundant. Deleting it
            //      removes a stranding pathway (Bug 1 in the original
            //      plan) without losing any user-visible signal.
            const enginePanes = withInstanceMessages(state.enginePanes, key, msgs)
            return { enginePanes }
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
            const [tabIdInner, instanceId] = key.split(':')
            const pane = state.enginePanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            const msgs = [...(inst?.messages || [])]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, sealed: true }
              const enginePanes = withInstanceMessages(state.enginePanes, key, msgs)
              return { enginePanes }
            }
            return {}
          })
          break
        }
        default: {
          // Delegate remaining message-writing events to engine-event-slice-messages.ts.
          // handleMessageEvents returns true when it consumed the event, false
          // when the type is unknown (no-op default).
          handleMessageEvents(set, _get, key, tabId, event)
          break
        }
      }
    },
  }
}
