import type {
  PersistedTab,
  PersistedTabState,
  PersistedConversationInstance,
  PersistedConversationPane,
} from '../shared/types-persistence'
import { SPLIT_SCHEMA_VERSION } from '../shared/types-persistence'

/**
 * tab-migration-split — on-disk migration that splits multiplexed engine tabs
 * (carrying >1 conversation instance in a single conversationPane) into N
 * standalone single-instance tabs, one per instance.
 *
 * Background: the conversation-unification migration (schemaVersion 2) moved
 * all conversation state into a unified `conversationPane` per tab, but it
 * preserved multi-instance panes as-is. The phase 1 single-instance model
 * requires every tab to carry exactly 0 or 1 instances. This migration
 * performs that flattening on disk before the renderer ever loads the file.
 *
 * Ordering: runs AFTER the unify migration (which produces schemaVersion 2).
 * This migration requires schemaVersion >= 2 as input and stamps
 * schemaVersion 3 on output.
 *
 * Pipeline (see runTabSplitMigration in tab-migration-split-runner.ts):
 *   backup -> migrate -> verify -> keep-backup-on-success / restore-on-failure.
 *
 * Idempotency: files at schemaVersion >= 3 are already split; the migration
 * is a no-op.
 *
 * SPLIT_SCHEMA_VERSION is the canonical definition; it lives in
 * `shared/types-persistence.ts` and is imported + re-exported here so
 * existing `main/` callers keep working without import changes.
 */
export { SPLIT_SCHEMA_VERSION }

/** True when `state` is already split (no migration needed). */
export function isSplitSchema(state: PersistedTabState): boolean {
  return (state.schemaVersion ?? 0) >= SPLIT_SCHEMA_VERSION
}

/**
 * True when the tab needs splitting: it has a conversationPane with >1
 * instance. Terminal-only tabs and single-instance tabs pass through.
 */
function needsSplit(tab: PersistedTab): boolean {
  const instances = tab.conversationPane?.instances ?? []
  return instances.length > 1
}

/**
 * Split ONE multi-instance tab into N single-instance tabs.
 *
 * Each output tab inherits ALL parent tab metadata (workingDirectory,
 * engineProfileId, hasEngineExtension, pillColor, groupId, etc.) and
 * carries exactly one instance in its conversationPane.
 *
 * Per-instance fields preserved:
 *   - messages (full conversation history)
 *   - messageCount
 *   - conversationIds (session continuity chain)
 *   - modelOverride, sessionModel
 *   - draftInput
 *   - permissionMode, permissionDenied
 *   - agentStates
 *   - forkedFromConversationIds
 *   - planFilePath
 *
 * Tab-level fields derived from the instance:
 *   - customTitle: instance label (or parent customTitle if label is empty)
 *   - conversationId: last entry in the instance's conversationIds chain
 *     (falls back to parent conversationId)
 *
 * Pure and deterministic: same input -> same output, no I/O.
 */
function splitTab(tab: PersistedTab): PersistedTab[] {
  const instances = tab.conversationPane?.instances ?? []
  // Nothing to split: return the tab as-is in a one-element array.
  if (instances.length <= 1) return [tab]

  return instances.map((inst) => {
    // Deep-clone the instance so the output does not share references with
    // the input. The verify gate (verifySplitMigration) compares input vs
    // output by value; shared references would make tampering undetectable.
    const clonedInst: PersistedConversationInstance = JSON.parse(JSON.stringify(inst))
    const singlePane: PersistedConversationPane = {
      instances: [clonedInst],
      activeInstanceId: clonedInst.id,
    }
    return {
      ...tab,
      customTitle: clonedInst.label || tab.customTitle,
      conversationId:
        clonedInst.conversationIds?.[clonedInst.conversationIds.length - 1]
        ?? tab.conversationId,
      conversationPane: singlePane,
    }
  })
}

/**
 * Migrate a whole `PersistedTabState`: split every multi-instance tab and
 * stamp schemaVersion 3.
 *
 * No-op (returns the input) when already at schemaVersion >= 3.
 *
 * The output tab array will be LONGER than the input when any tab had >1
 * instance. The verify gate (in the runner) checks instance-level
 * preservation rather than positional tab matching.
 */
export function migrateTabStateToSplit(state: PersistedTabState): PersistedTabState {
  if (isSplitSchema(state)) return state

  const outputTabs: PersistedTab[] = []
  for (const tab of state.tabs ?? []) {
    if (needsSplit(tab)) {
      outputTabs.push(...splitTab(tab))
    } else {
      outputTabs.push(tab)
    }
  }

  return {
    ...state,
    schemaVersion: SPLIT_SCHEMA_VERSION,
    tabs: outputTabs,
  }
}
