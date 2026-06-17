import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { parseSessionKey, tabIdFromKey, instanceIdFromKey, isCompoundKey } from '../../../shared/session-key'
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

// ---------------------------------------------------------------------------
// Delta accumulator for batched text delta updates.
// Instead of updating the Zustand store on every engine_text_delta (50-200/sec),
// we accumulate deltas here and flush to the store at ~60fps via requestAnimationFrame.
// This reduces store updates from 200/sec to ~60/sec, cutting GC pressure by ~70%.
// ---------------------------------------------------------------------------
const pendingDeltas = new Map<string, string>()
let deltaFlushScheduled = false
let deltaFlushSet: StoreSet | null = null
// Track which tabIds received text deltas since the last RAF flush.
// lastEventAt is updated for these tabs inside flushPendingDeltas()
// instead of on every raw delta — coalescing 200 set() calls/sec into 1.
const tabsWithEvents = new Set<string>()

function flushPendingDeltas(): void {
  deltaFlushScheduled = false
  if (!deltaFlushSet) return

  // Flush accumulated text deltas into the store.
  if (pendingDeltas.size > 0) {
    const batch = new Map(pendingDeltas)
    pendingDeltas.clear()
    deltaFlushSet((state) => {
      let conversationPanes = state.conversationPanes
      for (const [batchKey, text] of batch) {
        const { tabId: tabIdInner, instanceId } = parseSessionKey(batchKey)
        const pane = conversationPanes.get(tabIdInner)
        const inst = pane?.instances.find((i) => i.id === instanceId)
        const msgs = [...(inst?.messages || [])]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant' && !last.sealed) {
          msgs[msgs.length - 1] = { ...last, content: last.content + text }
        } else {
          msgs.push({ id: nextMsgId(), role: 'assistant', content: text, timestamp: Date.now() })
        }
        conversationPanes = withInstanceMessages(conversationPanes, batchKey, msgs)
      }
      return { conversationPanes }
    })
  }

  // Flush batched lastEventAt for tabs that received text deltas.
  // This coalesces 50-200 tabs.map() calls/sec into 1 per animation frame,
  // preventing the persistence subscriber from re-serializing the entire
  // tabs file on every raw delta.
  if (tabsWithEvents.size > 0) {
    const touchedTabs = new Set(tabsWithEvents)
    tabsWithEvents.clear()
    deltaFlushSet((s) => ({
      tabs: s.tabs.map((t) => touchedTabs.has(t.id) ? { ...t, lastEventAt: Date.now() } : t),
    }))
  }
}

/** Flush any buffered text deltas synchronously. Useful for cleanup / testing. */
export function flushEngineTextDeltas(): void {
  flushPendingDeltas()
}

/** Remove pending delta state for a closed tab to prevent memory leaks. */
export function cleanupTabDeltas(tabId: string): void {
  for (const key of pendingDeltas.keys()) {
    if (key.startsWith(`${tabId}:`)) pendingDeltas.delete(key)
  }
  tabsWithEvents.delete(tabId)
}

export function createEngineEventSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    handleEngineEvent: (key, event) => {
      // engine_command_registry and engine_command_result are CROSS-CUTTING
      // events that apply to BOTH streams (the normalized stream that drives a
      // plain conversation, keyed bare `tabId`, and the raw extension stream
      // that drives an extension-hosted instance, keyed `${tabId}:${instanceId}`).
      // We dispatch on them BEFORE the stream discriminator below so they reach
      // the correct slice regardless of which stream/key shape they arrive on.
      if (handleCrossEngineEvent(set, _get, key, event)) return

      // STREAM DISCRIMINATOR — not a key-shape branch. This `handleEngineEvent`
      // path is the RAW EXTENSION STREAM (onEngineEvent → raw `engine_*` events)
      // that drives extension-hosted conversation instances, which the engine
      // keys `${tabId}:${instanceId}`. A bare key here is a plain conversation's
      // raw event; those are ALREADY applied via the NORMALIZED STREAM
      // (handleNormalizedEvent, from the control plane) — re-applying them in the
      // per-instance switch below would double-apply status/agent-state. So we
      // drop bare-keyed events here by design. (Per the key-spine DECISION: the
      // engine wire/event-routing key is frozen; a plain conversation's raw
      // events keep arriving bare, and this discriminator stays load-bearing.)
      if (!isCompoundKey(key)) return

      const tabId = tabIdFromKey(key)
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
            const conversationPanes = withInstanceAgentStates(state.conversationPanes, key, agents)
            return { conversationPanes }
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
            const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
            const pane = state.conversationPanes.get(tabIdInner)
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
            const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
            return { conversationPanes }
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
          // Batch text deltas at ~60fps to reduce GC pressure.
          // Instead of a full store update per delta (6+ object allocations each),
          // we accumulate the text and flush once per animation frame.
          //
          // Phase 4 note: we no longer infer tab.status from text-delta
          // arrival — engine_status is the authoritative signal (see
          // engine-event-status.ts). This case is purely message content.
          pendingDeltas.set(key, (pendingDeltas.get(key) || '') + event.text)
          tabsWithEvents.add(tabId)
          deltaFlushSet = set
          if (!deltaFlushScheduled) {
            deltaFlushScheduled = true
            requestAnimationFrame(flushPendingDeltas)
          }
          break
        }
        case 'engine_thinking_block_start': {
          // Extended thinking (issue #158). The model began a reasoning
          // block. Open a fresh `role: 'thinking'` message on this instance
          // so the turn view can render the collapsed thinking affordance
          // above the tool row. `thinkingActive: true` drives the live
          // pulse/"thinking…" indicator until block_end arrives.
          //
          // A thinking block is OPTIONAL per turn; this case only fires
          // when the model actually reasoned. Boundaries (start/end) always
          // arrive when reasoning happened — deltas may be suppressed by
          // engine config — so the block must be openable from the boundary
          // alone (summary-only path). We open with empty content; if no
          // deltas come, block_end leaves content empty and the renderer
          // falls back to the summary state.
          console.log(`[store] thinking_block_start: key=${key} opening thinking row`)
          set((state) => {
            const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
            const pane = state.conversationPanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            const msgs = [...(inst?.messages || []), {
              id: nextMsgId(),
              role: 'thinking' as const,
              content: '',
              thinkingActive: true,
              timestamp: Date.now(),
            }]
            const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
            return { conversationPanes }
          })
          break
        }
        case 'engine_thinking_delta': {
          // Incremental reasoning text. Append to the open (active) thinking
          // message on this instance. Deltas are gated engine-side by a
          // default-on config, so this case may never fire for a given block
          // even though block_start/block_end did — that is the summary-only
          // path and is handled by leaving content empty.
          //
          // Unlike engine_text_delta we do NOT route thinking through the
          // 60fps batching accumulator: reasoning deltas are lower-volume
          // than assistant text, the thinking row is collapsed-by-default
          // (only the last 2-3 lines are visible while streaming), and
          // keeping the write synchronous avoids a second cross-cutting
          // buffer that would also need flushing on block_end / stream_reset.
          const text = event.thinkingText || ''
          if (!text) break
          set((state) => {
            const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
            const pane = state.conversationPanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            const msgs = [...(inst?.messages || [])]
            // Find the most recent active thinking row to append into. If
            // none exists (a delta arrived before we saw block_start — e.g.
            // a dropped/reordered start), open one defensively so the text
            // is not lost.
            let idx = -1
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'thinking' && msgs[i].thinkingActive) { idx = i; break }
            }
            if (idx === -1) {
              console.log(`[store] thinking_delta: key=${key} no active thinking row — opening one defensively`)
              msgs.push({
                id: nextMsgId(),
                role: 'thinking' as const,
                content: text,
                thinkingActive: true,
                timestamp: Date.now(),
              })
            } else {
              msgs[idx] = { ...msgs[idx], content: msgs[idx].content + text }
            }
            const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
            return { conversationPanes }
          })
          break
        }
        case 'engine_thinking_block_end': {
          // The reasoning block finished. Seal the active thinking row:
          // clear thinkingActive (stops the pulse) and stamp the summary
          // fields (elapsed seconds, token estimate, redacted flag). The
          // renderer uses these for the historical/summary render states.
          //
          // thinkingRedacted=true means encrypted reasoning with no readable
          // text — no deltas arrived, content stays empty, and the renderer
          // shows the "🔒 redacted reasoning" affordance instead of an empty
          // block. We honor it by stamping the flag on the row.
          const redacted = !!event.thinkingRedacted
          console.log(
            `[store] thinking_block_end: key=${key} elapsed=${event.thinkingElapsedSeconds ?? '?'}s ` +
            `tokens=${event.thinkingTotalTokens ?? '?'} redacted=${redacted}`,
          )
          set((state) => {
            const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
            const pane = state.conversationPanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            const msgs = [...(inst?.messages || [])]
            let idx = -1
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'thinking' && msgs[i].thinkingActive) { idx = i; break }
            }
            if (idx === -1) {
              // block_end with no active row (start was dropped, or block_end
              // arrived twice). Synthesize a summary-only row so the user
              // still sees that the model reasoned this turn.
              console.log(`[store] thinking_block_end: key=${key} no active thinking row — synthesizing summary-only row`)
              msgs.push({
                id: nextMsgId(),
                role: 'thinking' as const,
                content: '',
                thinkingActive: false,
                thinkingElapsedSeconds: event.thinkingElapsedSeconds,
                thinkingTotalTokens: event.thinkingTotalTokens,
                thinkingRedacted: redacted,
                timestamp: Date.now(),
              })
            } else {
              msgs[idx] = {
                ...msgs[idx],
                thinkingActive: false,
                thinkingElapsedSeconds: event.thinkingElapsedSeconds,
                thinkingTotalTokens: event.thinkingTotalTokens,
                thinkingRedacted: redacted,
              }
            }
            const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
            return { conversationPanes }
          })
          break
        }
        case 'engine_stream_reset': {
          // The engine is retrying mid-turn. Discard the in-progress thinking
          // accumulator for this instance, exactly as partial assistant text
          // is discarded today (event-slice.ts handles the normalized-stream
          // assistant-text discard; this is the raw-stream thinking analogue).
          //
          // We drop ONLY a still-active thinking row (thinkingActive=true) —
          // a completed (sealed) thinking row from an earlier message in the
          // same turn is real history and must survive the retry, mirroring
          // how only the trailing un-sealed assistant message is discarded.
          set((state) => {
            const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
            const pane = state.conversationPanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            if (!inst) return {}
            const hadActive = (inst.messages || []).some(
              (m) => m.role === 'thinking' && m.thinkingActive,
            )
            if (!hadActive) {
              console.log(`[store] stream_reset: key=${key} no active thinking row to discard`)
              return {}
            }
            console.log(`[store] stream_reset: key=${key} discarding in-progress thinking accumulator`)
            const msgs = (inst.messages || []).filter(
              (m) => !(m.role === 'thinking' && m.thinkingActive),
            )
            const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
            return { conversationPanes }
          })
          break
        }
        case 'engine_message_end': {
          // Flush any pending text deltas before processing message_end
          // to ensure the final message content is complete before sealing.
          if (pendingDeltas.has(key)) {
            const pendingText = pendingDeltas.get(key)!
            pendingDeltas.delete(key)
            set((state) => {
              const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
              const pane = state.conversationPanes.get(tabIdInner)
              const inst = pane?.instances.find((i) => i.id === instanceId)
              const msgs = [...(inst?.messages || [])]
              const last = msgs[msgs.length - 1]
              if (last && last.role === 'assistant' && !last.sealed) {
                msgs[msgs.length - 1] = { ...last, content: last.content + pendingText }
              } else {
                msgs.push({ id: nextMsgId(), role: 'assistant', content: pendingText, timestamp: Date.now() })
              }
              const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
              return { conversationPanes }
            })
          }
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
            const pane = state.conversationPanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === instanceIdFromKey(key)
            const tabs = isActive && event.usage ? state.tabs.map((t) => {
              if (t.id !== tabId) return t
              // engine_message_end carries contextPercent and tokens but
              // NOT contextWindow — the window comes through engine_status
              // (see engine-event-status.ts). Renderer reads tab.contextWindow
              // as the denominator; this slice just carries the tokens/percent.
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
            const { tabId: tabIdInner, instanceId } = parseSessionKey(key)
            const pane = state.conversationPanes.get(tabIdInner)
            const inst = pane?.instances.find((i) => i.id === instanceId)
            const msgs = [...(inst?.messages || [])]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, sealed: true }
              const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
              return { conversationPanes }
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

      // Update lastEventAt for the tab that received this event.
      // Placed AFTER the switch so it doesn't create a wasted tabs rewrite
      // that gets immediately superseded (e.g. engine_message_end already
      // maps tabs for contextTokens). Skipped for engine_text_delta — those
      // are batched at ~60fps via tabsWithEvents + flushPendingDeltas().
      if (event.type !== 'engine_text_delta') {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, lastEventAt: Date.now() } : t)),
        }))
      }
    },
  }
}
