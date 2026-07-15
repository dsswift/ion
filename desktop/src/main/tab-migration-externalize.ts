import type {
  ExternalInstanceContent,
  PersistedTab,
  PersistedTabState,
} from '../shared/types-persistence'

/**
 * tab-migration-externalize — on-disk migration (v3 → v4) that fixes content
 * LOCALITY: the tab file persists references and unsaved-only state; anything
 * reconstructable from an authoritative on-disk source is not duplicated in.
 *
 * Two applications of that one rule:
 *
 *  1. Conversation messages. Instances that persisted inline `messages[]`
 *     (renderer-only harness/system rows that cannot be reloaded from the
 *     engine conversation store) move to a per-tab content file
 *     (`~/.ion/tab-content/<tabId>.json`). The thin manifest keeps
 *     `messageCount` and gains the explicit `hasExternalContent` marker.
 *     Instances that were already count-only are untouched.
 *
 *  2. Editor file content. A non-dirty file with a real `filePath` reloads
 *     byte-identically from disk (the editor already re-reads on open), so
 *     its `content`/`savedContent` are dropped. Dirty edits and scratch
 *     buffers (no path) are the only copy and stay inline.
 *
 * Content-file key: the DURABLE TAB ID. Runtime instance ids all normalize to
 * 'main' (single-instance-per-tab model), so the tab id is the one stable,
 * collision-free key for "this tab's conversation thread". Legacy tabs that
 * predate the durable id are stamped one during migration (the restore path
 * already mints-and-persists ids for id-less tabs; stamping here just does it
 * one launch earlier, and the verify gate checks it).
 *
 * Pure: no I/O. The runner (tab-migration-externalize-runner.ts) owns
 * backup → verify → write-or-rollback.
 */

/** Schema version after the externalize migration. */
export const EXTERNALIZE_SCHEMA_VERSION = 4

/** True when `state` is already externalized (no migration needed). */
export function isExternalizedSchema(state: PersistedTabState): boolean {
  return (state.schemaVersion ?? 0) >= EXTERNALIZE_SCHEMA_VERSION
}

export interface ExternalizeResult {
  thin: PersistedTabState
  /** Content files to write, keyed by tab id. */
  contentByTabId: Map<string, ExternalInstanceContent>
}

/** Externalize one tab's instance messages. Returns the thin tab + content. */
function externalizeTab(
  tab: PersistedTab,
  mintId: () => string,
): { tab: PersistedTab; content: ExternalInstanceContent | null } {
  const inst = tab.conversationPane?.instances?.[0]
  if (!inst?.messages || inst.messages.length === 0) {
    return { tab, content: null }
  }

  // Deep-clone so thin output shares no references with the input — the
  // verify gate compares input vs merged-output by value.
  const tabId = tab.id ?? mintId()
  const messages: NonNullable<PersistedTab['conversationPane']>['instances'][number]['messages'] =
    JSON.parse(JSON.stringify(inst.messages))
  const thinInst = { ...inst, hasExternalContent: true }
  delete thinInst.messages
  thinInst.messageCount = inst.messageCount ?? inst.messages.length

  return {
    tab: {
      ...tab,
      id: tabId,
      conversationPane: {
        ...tab.conversationPane!,
        instances: [thinInst],
      },
    },
    content: {
      tabId,
      instanceId: inst.id,
      schemaVersion: EXTERNALIZE_SCHEMA_VERSION,
      messages: messages!,
    },
  }
}

/**
 * Strip reloadable editor content: non-dirty entries with a real filePath
 * reload from disk, so their buffers are emptied. Dirty or path-less entries
 * keep content inline (they are the only copy — never a failure, by design).
 */
function externalizeEditorStates(
  editorStates: PersistedTabState['editorStates'],
): PersistedTabState['editorStates'] {
  if (!editorStates) return editorStates
  const out: NonNullable<PersistedTabState['editorStates']> = {}
  for (const [dir, dirState] of Object.entries(editorStates)) {
    out[dir] = {
      ...dirState,
      files: dirState.files.map((f) =>
        !f.isDirty && f.filePath ? { ...f, content: '', savedContent: '' } : f,
      ),
    }
  }
  return out
}

/**
 * Migrate a whole `PersistedTabState` from v3 to v4. No-op (returns the input
 * with an empty content map) when already at schemaVersion >= 4.
 *
 * `mintId` is injectable for deterministic tests; production uses
 * crypto.randomUUID (matching how the restore path mints durable tab ids).
 */
export function migrateTabStateToExternalized(
  state: PersistedTabState,
  mintId: () => string = () => crypto.randomUUID(),
): ExternalizeResult {
  if (isExternalizedSchema(state)) {
    return { thin: state, contentByTabId: new Map() }
  }

  const contentByTabId = new Map<string, ExternalInstanceContent>()
  const tabs: PersistedTab[] = []
  for (const tab of state.tabs ?? []) {
    const { tab: thinTab, content } = externalizeTab(tab, mintId)
    tabs.push(thinTab)
    if (content) contentByTabId.set(content.tabId, content)
  }

  return {
    thin: {
      ...state,
      schemaVersion: EXTERNALIZE_SCHEMA_VERSION,
      tabs,
      editorStates: externalizeEditorStates(state.editorStates),
    },
    contentByTabId,
  }
}
