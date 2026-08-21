import type { PersistedTab } from '../../shared/types-persistence'
import type { TabState } from '../../shared/types'
import { makeLocalTab } from '../stores/session-store-helpers'

/** Restored inbox fields retain old-file compatibility through null defaults. */
export function restoredInboxTabFields(tab: PersistedTab): {
  createdAt: number
  lastFailureAt: number | null
  pinnedAt: number | null
  pinOrderKey: string | null
} {
  return {
    createdAt: tab.createdAt ?? 0,
    lastFailureAt: tab.lastFailureAt ?? null,
    pinnedAt: tab.pinnedAt ?? null,
    pinOrderKey: tab.pinOrderKey ?? null,
  }
}

/** Cold settled history never bootstraps an engine session during restore. */
export function restoreSettledHistoryRecord(record: PersistedTab): TabState {
  return {
    ...makeLocalTab(),
    id: record.id ?? crypto.randomUUID(),
    conversationId: record.conversationId,
    historicalSessionIds: record.historicalSessionIds ?? [],
    lastKnownSessionId: record.lastKnownSessionId ?? record.conversationId,
    title: record.title,
    customTitle: record.customTitle,
    workingDirectory: record.workingDirectory,
    hasChosenDirectory: record.hasChosenDirectory,
    additionalDirs: record.additionalDirs,
    worktree: record.worktree ?? null,
    executionHost: record.executionHost ?? null,
    executionMachineId: record.executionMachineId ?? null,
    engineProfileId: record.engineProfileId ?? null,
    lastMessagePreview: record.lastMessagePreview ?? null,
    lastMessageAt: record.lastMessageAt ?? null,
    settledOverride: record.settledOverride === 'auto' ? 'auto' : 'settled',
    settledAt: record.settledAt ?? null,
    inputLocked: true,
    inputLockReason: 'settled',
  }
}
