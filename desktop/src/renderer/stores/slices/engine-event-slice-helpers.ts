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
 * key (tabId or `${tabId}:${instanceId}`) — autocomplete reads under the
 * active tab/instance combination.
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

// ─── Instance-write helpers ───────────────────────────────────────────────────
//
// Each helper returns a new conversationPanes Map with the specified ConversationInstance
// field updated on the instance identified by `key` (`${tabId}:${instanceId}`).
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
