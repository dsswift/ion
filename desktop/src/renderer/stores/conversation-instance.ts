/**
 * conversation-instance — the single accessor seam for "the conversation a
 * tab is currently showing."
 *
 * Background: every tab stores its scrollback and per-conversation state on a
 * `ConversationInstance` inside `conversationPanes`. Plain conversations are
 * single-instance: they carry exactly one instance with the stable sentinel id
 * `MAIN_INSTANCE_ID` ('main'). Extension-hosted tabs carry one instance per
 * sub-conversation and track which is active via
 * `ConversationPane.activeInstanceId`.
 *
 * This module is the ONE place that resolves "which instance is the active
 * conversation for this tab" so no consumer branches on tab type. Before this
 * unification, plain conversations stored `messages`/`permissionDenied`/
 * `draftInput`/`modelOverride`/`planFilePath`/`messageCount`/`permissionMode`/
 * `thinkingEffort` directly on `TabState`, while extension-hosted tabs stored
 * them on the instance — forcing a tab-type fork at every data-source site.
 * Those `TabState` fields are gone; this accessor replaces every fork.
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
import type { ConversationRef, ConversationInstance, ConversationPane, StatusFields } from '../../shared/types-engine'
import type { Message as _Message, ThinkingEffort } from '../../shared/types-session'

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
    modelOverrideSource: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    elicitationQueue: [],
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    dispatchTelemetry: [],
    contextBreakdown: null,
    ...overrides,
  }
}

/**
 * The neutral `StatusFields` an instance carries before its first
 * `engine_status` event.
 *
 * `statusFields` starts as `null` (see `emptyConversationInstance` above) and
 * `resetEngineInstance` puts it back, so there is a real window — every event
 * from session start until the first status arrives — where a writer that
 * wants to stamp one field has no object to stamp it onto. Skipping the write
 * in that window is what left the context indicator blank on a cold start
 * while the correct figure sat on the tab mirror; the indicator reads only
 * `inst.statusFields.contextTokens`.
 *
 * Callers that need to write a single field spread this as the base. Shared
 * rather than inlined so the reducer arms and the restoration seed cannot
 * drift on what a synthesized base looks like.
 */
export function baseStatusFields(): StatusFields {
  return {
    label: '',
    state: 'idle',
    model: '',
    contextPercent: 0,
    contextWindow: 0,
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
  return activeInstanceOfPane(conversationPanes.get(tabId))
}

/**
 * Pane-scoped form of {@link activeInstance}. A component that only cares
 * about one tab subscribes to that tab's pane rather than to the whole
 * `conversationPanes` map, so a streaming conversation does not re-render
 * every other tab's UI; this resolves the instance from the pane it already
 * holds.
 */
export function activeInstanceOfPane(pane: ConversationPane | undefined): Instance | null {
  if (!pane) return null
  const activeId = pane.activeInstanceId ?? pane.instances[0]?.id
  if (!activeId) return null
  return (pane.instances.find((i) => i.id === activeId) as Instance | undefined) ?? null
}

/**
 * Resolve the AUTHORITATIVE permission mode for a tab.
 *
 * The permission mode lives on the active `ConversationInstance` for every tab
 * type — plain and extension-hosted alike. `TabState.permissionMode` is gone
 * (WI-002); this function is the single seam every behavior that gates on the
 * mode (auto-group-movement, snapshot projection, etc.) must read.
 *
 * Falls back to 'auto' when the pane/instance is missing (a bug under the 2A
 * invariant, but tolerated as a safe default rather than crashing).
 */
export function effectivePermissionMode(
  tab: { id: string },
  conversationPanes: Map<string, ConversationPane>,
): 'auto' | 'plan' {
  return activeInstance(conversationPanes, tab.id)?.permissionMode ?? 'auto'
}

/**
 * Resolve the AUTHORITATIVE thinking effort for a tab.
 *
 * The effort lives on the active `ConversationInstance` for every tab type —
 * plain and extension-hosted alike. `TabState.thinkingEffort` is gone (WI-002);
 * this function is the single seam every behavior that reads effort (send-slice,
 * snapshot projection) must use.
 *
 * Falls back to 'off' when the pane/instance is missing (safe default: no
 * thinking rather than crashing).
 */
export function effectiveThinkingEffort(
  tab: { id: string },
  conversationPanes: Map<string, ConversationPane>,
): ThinkingEffort {
  return activeInstance(conversationPanes, tab.id)?.thinkingEffort ?? 'off'
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
 * Does this instance still need its on-disk scrollback loaded?
 *
 * The precise signal is `historyHydrated` (set `false` by skeleton-creation
 * sites, `true` by `loadSkeletonMessages` on completion). `false` is an
 * authoritative "not loaded" marker set by restore paths. It always requests
 * one hydration attempt, even when persisted messageCount is zero:
 * messageCount is a derived cache and can be stale while conversationId still
 * points at real durable history.
 *
 * `undefined` means the pane came from a path that predates the marker; those
 * keep the legacy empty-messages+positive-messageCount heuristic so their
 * behavior is unchanged.
 */
export function needsHistoryHydration(inst: ConversationInstance | null | undefined): boolean {
  if (!inst) return false
  if (inst.historyHydrated === true) return false
  if (inst.historyHydrated === false) return true
  return inst.messages.length === 0 && (inst.messageCount ?? 0) > 0
}

/**
 * Return a NEW `conversationPanes` map with `mutate` applied to the active instance
 * of `tabId`. Returns the original map unchanged when the pane/instance is
 * missing, so callers can `set({ conversationPanes })` unconditionally without
 * allocating on a miss. This is the single-commit seam the streaming hub uses
 * (1B): build the next instance once, commit once.
 *
 * The map is also returned unchanged when `mutate` hands back the instance it
 * was given. Reference identity is the signal every subscriber reads: the tab
 * strip and each tab pill subscribe to `conversationPanes` directly, so
 * cloning the map for an event that changed nothing re-renders all of them for
 * nothing — the dominant cost when many tabs are open and agents are streaming.
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
  const current = pane.instances[idx] as Instance
  const updated = mutate(current)

  // Keep messageCount in lockstep with loaded messages so the persisted proxy
  // is always accurate when messages are present.
  const committed = updated.messages.length > 0 && updated.messageCount !== updated.messages.length
    ? { ...updated, messageCount: updated.messages.length }
    : updated
  if (committed === current) return conversationPanes

  const next = new Map(conversationPanes)
  const instances = pane.instances.slice()
  instances[idx] = committed
  next.set(tabId, { ...pane, instances })
  return next
}
