/**
 * conversation-instance — the single accessor seam for "the conversation a
 * tab is currently showing."
 *
 * Background: every tab (normal OR engine) now stores its scrollback and
 * per-conversation state on a `ConversationInstance` inside `conversationPanes`.
 * Normal tabs are single-instance: they carry exactly one instance with the
 * stable sentinel id `MAIN_INSTANCE_ID` ('main'). Engine tabs carry one
 * instance per sub-conversation and track which is active via
 * `ConversationPane.activeInstanceId`.
 *
 * This module is the ONE place that resolves "which instance is the active
 * conversation for this tab" so no consumer branches on tab type. Before this
 * unification, normal tabs stored `messages`/`permissionDenied`/`draftInput`/
 * `modelOverride`/`planFilePath`/`messageCount` directly on `TabState`, while
 * engine tabs stored them on the instance — forcing a `tab.hasEngineExtension` fork at
 * every data-source site. Those `TabState` fields are gone; this accessor
 * replaces every fork.
 *
 * Strategy note (1B): the hot streaming path resolves the active instance ONCE
 * per event into a local working array, mutates it across all event cases, and
 * commits it back via `commitInstance` in a single `set`. That keeps one Map
 * clone per event instead of one per message write.
 *
 * Invariant (2A): every tab has its instance materialized EAGERLY at creation
 * (see `seedMainPane`), so `activeInstance` never has to lazily create state.
 * A missing pane is a bug, not an expected lazy-init case — callers may treat
 * a null return as "tab not found / not yet hydrated" but must never write
 * through it.
 */

import { MAIN_INSTANCE_ID } from '../../shared/session-key'
import type { ConversationRef, ConversationInstance, ConversationPane } from '../../shared/types-engine'
import type { Message } from '../../shared/types-session'

/** A fully-typed instance row as stored in `ConversationPane.instances`. */
export type Instance = ConversationRef & ConversationInstance

/**
 * Build a blank `ConversationInstance` payload (everything except the
 * `ConversationRef` id/label). Used both for a normal tab's `main` instance and
 * as the field-defaults baseline when restoring/migrating persisted tabs.
 */
export function emptyConversationInstance(
  overrides: Partial<ConversationInstance> = {},
): ConversationInstance {
  return {
    messages: [],
    messageCount: 0,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    forkedFromConversationIds: null,
    ...overrides,
  }
}

/**
 * Build the single-instance pane for a normal tab: one instance with the
 * `MAIN_INSTANCE_ID` sentinel, active. `label` is unused for normal tabs (no
 * instance switcher is shown) but kept non-empty for any generic instance UI.
 */
export function makeMainPane(
  overrides: Partial<ConversationInstance> = {},
  label = 'main',
): ConversationPane {
  const instance: Instance = {
    id: MAIN_INSTANCE_ID,
    label,
    ...emptyConversationInstance(overrides),
  }
  return { instances: [instance], activeInstanceId: MAIN_INSTANCE_ID }
}

/**
 * Resolve the active `ConversationInstance` for a tab from the `conversationPanes`
 * map. Returns null only when the pane or active instance is missing (a bug
 * under the 2A invariant, but tolerated as "not yet hydrated" by read-only
 * callers). For a normal tab this is always the `main` instance.
 */
export function activeInstance(
  conversationPanes: Map<string, ConversationPane>,
  tabId: string,
): Instance | null {
  const pane = conversationPanes.get(tabId)
  if (!pane) return null
  const activeId = pane.activeInstanceId ?? pane.instances[0]?.id
  if (!activeId) return null
  return (pane.instances.find((i) => i.id === activeId) as Instance | undefined) ?? null
}

/**
 * Effective message count for a tab, preserving the old
 * `messages?.length ?? messageCount ?? 0` semantics now that storage is
 * instance-scoped. A skeleton (lazily-loaded) tab has `messages: []` but a
 * persisted `messageCount` > 0; this returns the count so blank-tab detection
 * and the iOS `RemoteTabState.messageCount` wire field stay correct.
 */
export function instanceMessageCount(inst: ConversationInstance | null | undefined): number {
  if (!inst) return 0
  return inst.messages.length > 0 ? inst.messages.length : (inst.messageCount ?? 0)
}

/**
 * Return a NEW `conversationPanes` map with `mutate` applied to the active instance
 * of `tabId`. Returns the original map unchanged when the pane/instance is
 * missing, so callers can `set({ conversationPanes })` unconditionally without
 * allocating on a miss. This is the single-commit seam the streaming hub uses
 * (1B): build the next instance once, commit once.
 */
export function commitInstance(
  conversationPanes: Map<string, ConversationPane>,
  tabId: string,
  mutate: (inst: Instance) => Instance,
): Map<string, ConversationPane> {
  const pane = conversationPanes.get(tabId)
  if (!pane) return conversationPanes
  const activeId = pane.activeInstanceId ?? pane.instances[0]?.id
  if (!activeId) return conversationPanes
  const idx = pane.instances.findIndex((i) => i.id === activeId)
  if (idx === -1) return conversationPanes
  const next = new Map(conversationPanes)
  const instances = pane.instances.slice()
  const current = instances[idx] as Instance
  const updated = mutate(current)
  // Keep messageCount in lockstep with loaded messages so the persisted proxy
  // is always accurate when messages are present.
  instances[idx] = updated.messages.length > 0
    ? { ...updated, messageCount: updated.messages.length }
    : updated
  next.set(tabId, { ...pane, instances })
  return next
}
