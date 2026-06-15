import type {
  PersistedTab,
  PersistedTabState,
  PersistedConversationInstance,
  PersistedConversationPane,
} from '../shared/types'

/**
 * tab-migration-unify — one-time migration of `tabs.json` from the legacy split
 * persisted shape to the unified `conversationPane` shape.
 *
 * Background: before the conversation-container unification, the on-disk tab
 * shape was split by tab type:
 *   - plain conversations stored flat fields directly on the tab
 *     (`messageCount`, `permissionDenied`, `draftInput`, `modelOverride`,
 *     `planFilePath`).
 *   - extension-hosted conversations stored parallel `engine*` maps keyed by
 *     instanceId (`engineInstances`, `engineMessages`, `engineAgentStates`,
 *     `engineSessionIds`, `engineDenials`, `engineModelOverrides`,
 *     `enginePermissionModes`, `engineForkedFromConversationIds`,
 *     `engineDrafts`).
 *
 * The unified shape collapses both into one `PersistedConversationPane` per tab
 * (a plain conversation = one `main` instance; an extension-hosted conversation
 * = one instance per sub-conversation). This module reads BOTH legacy shapes
 * and writes the unified one.
 *
 * Pipeline (see runTabUnifyMigration in tab-migration-unify-runner.ts):
 *   backup → migrate → verify → keep-backup-on-success / restore-on-failure.
 *
 * Retention: this migration ships for a few versions to convert in-the-wild
 * files, then is removed once the installed base has migrated. The
 * `schemaVersion` marker (2 = unified) makes the migration a no-op on
 * already-migrated files.
 */

/** Current unified schema version. */
export const UNIFIED_SCHEMA_VERSION = 2

/** The stable sentinel instance id for a plain conversation's single instance. */
const MAIN_INSTANCE_ID = 'main'

/** True when `state` is already in the unified shape (no migration needed). */
export function isUnifiedSchema(state: PersistedTabState): boolean {
  return (state.schemaVersion ?? 0) >= UNIFIED_SCHEMA_VERSION
}

/**
 * Coalesce the legacy `isEngine` key onto `hasEngineExtension`. The field was
 * renamed before this migration; a file may carry either.
 */
function resolveHasEngineExtension(tab: PersistedTab): boolean {
  if (tab.hasEngineExtension !== undefined) return tab.hasEngineExtension
  if (tab.isEngine !== undefined) return tab.isEngine
  return false
}

/**
 * Build the unified `main` instance for a PLAIN conversation from its legacy
 * flat fields. Plain tabs never persisted message *content* in the legacy shape
 * (only a count — content is reloaded from the engine conversation file on
 * open), so `messages` is omitted and `messageCount` carries the proxy.
 */
function plainMainInstance(tab: PersistedTab): PersistedConversationInstance {
  const inst: PersistedConversationInstance = {
    id: MAIN_INSTANCE_ID,
    label: MAIN_INSTANCE_ID,
    messageCount: tab.messageCount ?? 0,
    permissionMode: tab.permissionMode ?? 'auto',
  }
  if (tab.modelOverride) inst.modelOverride = tab.modelOverride
  if (tab.draftInput) inst.draftInput = tab.draftInput
  if (tab.permissionDenied) inst.permissionDenied = tab.permissionDenied
  if (tab.planFilePath) inst.planFilePath = tab.planFilePath
  if (tab.conversationId) inst.conversationIds = [tab.conversationId]
  return inst
}

/**
 * Build the unified instances for an EXTENSION-HOSTED conversation from its
 * legacy `engine*` maps (all keyed by instanceId). `engineInstances` is the
 * authoritative instance list; the other maps are looked up per-instance.
 */
function extensionInstances(tab: PersistedTab): PersistedConversationInstance[] {
  const refs = tab.engineInstances ?? []
  return refs.map((ref) => {
    const id = ref.id
    const inst: PersistedConversationInstance = {
      id,
      label: ref.label,
      permissionMode: tab.enginePermissionModes?.[id] ?? 'auto',
    }
    const msgs = tab.engineMessages?.[id]
    if (msgs && msgs.length > 0) {
      inst.messages = msgs
      inst.messageCount = msgs.length
    } else {
      inst.messageCount = 0
    }
    const agents = tab.engineAgentStates?.[id]
    if (agents && agents.length > 0) inst.agentStates = agents
    const denial = tab.engineDenials?.[id]
    if (denial) inst.permissionDenied = denial
    const model = tab.engineModelOverrides?.[id]
    if (model) inst.modelOverride = model
    const draft = tab.engineDrafts?.[id]
    if (draft) inst.draftInput = draft
    const sessionId = tab.engineSessionIds?.[id]
    if (sessionId) inst.conversationIds = [sessionId]
    const forked = tab.engineForkedFromConversationIds?.[id]
    if (forked && forked.length > 0) inst.forkedFromConversationIds = forked
    return inst
  })
}

/** Keys removed from a tab once its conversation state moves into the pane. */
const LEGACY_TAB_KEYS: Array<keyof PersistedTab> = [
  'messageCount', 'modelOverride', 'draftInput', 'permissionDenied', 'planFilePath',
  'isEngine', 'engineInstances', 'engineMessages', 'engineAgentStates',
  'engineSessionIds', 'engineDenials', 'engineModelOverrides',
  'enginePermissionModes', 'engineForkedFromConversationIds', 'engineDrafts',
]

/**
 * Migrate ONE legacy tab to the unified shape. Terminal-only tabs (no
 * conversation) pass through unchanged except for the `isEngine` →
 * `hasEngineExtension` coalesce. Already-unified tabs (carrying
 * `conversationPane`) pass through untouched.
 *
 * Pure and deterministic: same input → same output, no I/O.
 */
export function migrateTabToUnified(tab: PersistedTab): PersistedTab {
  if (tab.conversationPane) return tab // already unified
  const hasEngineExtension = resolveHasEngineExtension(tab)

  // Terminal-only tabs carry no conversation; just normalize the rename.
  if (tab.isTerminalOnly) {
    const out = { ...tab, hasEngineExtension }
    delete out.isEngine
    return out
  }

  const instances = hasEngineExtension
    ? extensionInstances(tab)
    : [plainMainInstance(tab)]
  // An extension-hosted tab with no persisted instances (corrupt/partial) still
  // gets a main instance so the invariant "every tab has ≥1 instance" holds.
  const safeInstances = instances.length > 0 ? instances : [plainMainInstance(tab)]
  const pane: PersistedConversationPane = {
    instances: safeInstances,
    activeInstanceId: safeInstances[0].id,
  }

  const out: PersistedTab = { ...tab, hasEngineExtension, conversationPane: pane }
  for (const k of LEGACY_TAB_KEYS) delete out[k]
  return out
}

/**
 * Migrate a whole `PersistedTabState`. No-op (returns the input) when already
 * unified. Otherwise returns a new state with every tab migrated and
 * `schemaVersion` stamped.
 */
export function migrateTabStateToUnified(state: PersistedTabState): PersistedTabState {
  if (isUnifiedSchema(state)) return state
  return {
    ...state,
    schemaVersion: UNIFIED_SCHEMA_VERSION,
    tabs: (state.tabs ?? []).map(migrateTabToUnified),
  }
}
