/**
 * engine-event-slice-helpers — shared instance-write primitives
 *
 * Extracted from engine-event-slice.ts to keep that file under the
 * 600-line TypeScript cap. Contains:
 *
 *   - The renderer-side extension command registry (module-level Map +
 *     getRendererExtensionCommands export). Autocomplete reads this
 *     synchronously on keystroke; no reactive subscription needed.
 *
 *   - withInstanceMessages / withInstanceAgentStates — pure Map
 *     transformers that return a new conversationPanes Map with the specified
 *     ConversationInstance field updated. Returning the original Map
 *     unchanged on a miss avoids spurious re-renders on the hot event
 *     path.
 */

import type { ConversationPane, AgentStateUpdate } from '../../../shared/types-engine'
import type { Message } from '../../../shared/types-session'
import { parseSessionKey } from '../../../shared/session-key'

/**
 * Per-tab cache of extension-registered command names, populated by
 * engine_command_registry snapshots emitted from the Go engine. Used by
 * the slash-autocomplete UI in InputBar so extension commands appear in
 * the menu alongside filesystem `.md` discoveries. Keyed by engine session
 * key — the bare tabId after session-key unification (#256); parseSessionKey
 * tolerates the legacy `${tabId}:${instanceId}` form. Autocomplete reads under
 * the active tab.
 *
 * Snapshot semantics: every event REPLACES the prior set. An empty
 * `commands: []` is the authoritative "no extension commands" signal and
 * clears the entry. Mirrors the main-process cache in
 * `desktop/src/main/state.ts:extensionCommandRegistry`.
 */
export const extensionCommandsByKey = new Map<string, Array<{ name: string; description?: string }>>()

/** Get a snapshot of the current extension commands for an engine session key.
 *  Used by autocomplete; returns an empty array when no commands are cached. */
export function getRendererExtensionCommands(key: string): Array<{ name: string; description?: string }> {
  return extensionCommandsByKey.get(key) ?? []
}

/**
 * Per-dispatch live-transcript fold state, keyed by dispatchAgentId (NOT
 * conversationId). Holds the in-flight push entries (deduped by toolId / seq)
 * so each incoming `dispatch_activity` delta folds onto the prior state. The
 * materialized Message[] is mirrored into the store (`dispatchActivity`) for
 * the popup to read; this map is the authoritative fold accumulator.
 *
 * Why dispatchAgentId, not conversationId: when an agent is re-dispatched the
 * engine reuses the same child conversationId but issues a new dispatchAgentId
 * and resets seq to 0. Keying by convId causes the two dispatches' push buffers
 * to collide — entries from dispatch 1 survive into dispatch 2's fold state.
 * dispatchAgentId is unique per dispatch invocation and is already present on
 * every wire event, so it is the correct routing key.
 */
export const dispatchActivityFoldByDispatchId = new Map<
  string,
  import('../../components/agent-dispatch-activity').DispatchActivityState
>()

// ─── Instance-write helpers ───────────────────────────────────────────────────
//
// Each helper returns a new conversationPanes Map with the specified ConversationInstance
// field updated on the instance identified by `key` (the bare tabId after
// session-key unification (#256); parseSessionKey tolerates the legacy
// `${tabId}:${instanceId}` form).
// Returns the original Map unchanged when the pane or instance is not found,
// so callers can do `if (updated !== original) returnPatch.conversationPanes = updated`
// without allocating on the hot path.

export function withInstanceMessages(
  conversationPanes: Map<string, ConversationPane>,
  key: string,
  messages: Message[],
): Map<string, ConversationPane> {
  const { tabId, instanceId } = parseSessionKey(key)
  const pane = conversationPanes.get(tabId)
  if (!pane) return conversationPanes
  const idx = pane.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return conversationPanes
  const updated = new Map(conversationPanes)
  const instances = pane.instances.slice()
  instances[idx] = { ...instances[idx], messages }
  updated.set(tabId, { ...pane, instances })
  return updated
}

export function withInstanceAgentStates(
  conversationPanes: Map<string, ConversationPane>,
  key: string,
  agentStates: AgentStateUpdate[],
): Map<string, ConversationPane> {
  const { tabId, instanceId } = parseSessionKey(key)
  const pane = conversationPanes.get(tabId)
  if (!pane) return conversationPanes
  const idx = pane.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return conversationPanes
  const updated = new Map(conversationPanes)
  const instances = pane.instances.slice()
  instances[idx] = { ...instances[idx], agentStates }
  updated.set(tabId, { ...pane, instances })
  return updated
}

/**
 * Flip any `running` agent entries to `error` for the instance identified
 * by `key`. Entries in other statuses (done, idle, error, cancelled) are
 * preserved unchanged.
 *
 * Used on `engine_dead` and `engine_error` to prevent stranded running-agent
 * entries that block tab close, show false "awaiting children" indicators,
 * and keep the interrupt button visible when no agent is actually running.
 */
export function withRunningAgentsErrored(
  conversationPanes: Map<string, ConversationPane>,
  key: string,
): Map<string, ConversationPane> {
  const { tabId, instanceId } = parseSessionKey(key)
  const pane = conversationPanes.get(tabId)
  if (!pane) return conversationPanes
  const idx = pane.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return conversationPanes
  const inst = pane.instances[idx]
  if (!inst.agentStates?.some((a) => a.status === 'running')) return conversationPanes
  const agentStates = inst.agentStates.map((a) =>
    a.status === 'running' ? { ...a, status: 'error' as const } : a,
  )
  const updated = new Map(conversationPanes)
  const instances = pane.instances.slice()
  instances[idx] = { ...instances[idx], agentStates }
  updated.set(tabId, { ...pane, instances })
  return updated
}

// ─── Dispatch telemetry helpers ───
// Used by event-slice.ts to record engine_dispatch_start/end into instance
// state without bloating the main slice file.

import type { DispatchTelemetryEntry } from '../../../shared/types-engine'
import type { NormalizedEvent } from '../../../shared/types-events'

/** Build a DispatchTelemetryEntry from a dispatch_start NormalizedEvent. */
export function buildDispatchStartEntry(event: NormalizedEvent & { type: 'dispatch_start' }): DispatchTelemetryEntry {
  return {
    dispatchAgent: event.dispatchAgent || '',
    dispatchSessionId: event.dispatchSessionId || '',
    dispatchModel: event.dispatchModel || '',
    dispatchTask: event.dispatchTask || '',
    dispatchDepth: event.dispatchDepth || 0,
    dispatchParentId: event.dispatchParentId || '',
    dispatchId: event.dispatchId || '',
  }
}

/**
 * Apply dispatch_end fields to the matching entry in the telemetry array.
 * Matches by exact dispatchId — avoids false positives when two agents at
 * the same depth fire concurrently. Returns the updated array if a match
 * was found, or null if no match.
 */
export function applyDispatchEnd(
  existing: DispatchTelemetryEntry[],
  event: NormalizedEvent & { type: 'dispatch_end' },
): DispatchTelemetryEntry[] | null {
  const id = event.dispatchId || ''
  const idx = existing.findIndex((e) => e.dispatchId === id)
  if (idx < 0) return null
  const copy = existing.slice()
  copy[idx] = {
    ...copy[idx],
    exitCode: event.dispatchExitCode ?? 0,
    elapsed: event.dispatchElapsed ?? 0,
    cost: event.dispatchCost ?? 0,
    conversationId: event.dispatchConversationId,
  }
  return copy
}
