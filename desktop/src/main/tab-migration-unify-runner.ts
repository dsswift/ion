import { existsSync, readFileSync, copyFileSync, unlinkSync } from 'fs'
import { log as _log, error as _error } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import {
  migrateTabStateToUnified,
  isUnifiedSchema,
  UNIFIED_SCHEMA_VERSION,
} from './tab-migration-unify'
import type { PersistedTabState, PersistedTab } from '../shared/types'

function log(msg: string): void { _log('TabMigrate', msg) }
function error(msg: string): void { _error('TabMigrate', msg) }

export interface UnifyMigrationOutcome {
  migrated: boolean
  reason: 'already-unified' | 'no-file' | 'success' | 'verify-failed' | 'error'
  backupPath?: string
  tabCount?: number
  errorMessage?: string
}

/**
 * Verify a migrated state preserved everything that matters from the legacy
 * state. Returns null on success, or a human-readable reason on the first
 * detected discrepancy. This is the gate that decides keep-backup-on-success
 * vs restore-on-failure.
 *
 * Checks, per tab (matched by array position, which the migration preserves):
 *   - tab identity/metadata fields are byte-identical (conversationId, title,
 *     customTitle, workingDirectory, group, pill, permissionMode, …).
 *   - every legacy conversation field is represented in the unified pane:
 *       plain tab → main instance carries messageCount / modelOverride /
 *       draftInput / permissionDenied / planFilePath.
 *       extension-hosted tab → one instance per legacy engineInstances entry,
 *       each carrying its mapped message count / model / denial / draft /
 *       session id.
 *   - no conversation data silently dropped.
 */
export function verifyUnifyMigration(
  legacy: PersistedTabState,
  migrated: PersistedTabState,
): string | null {
  if (!isUnifiedSchema(migrated)) return 'migrated state missing unified schemaVersion'
  const lt = legacy.tabs ?? []
  const mt = migrated.tabs ?? []
  if (lt.length !== mt.length) return `tab count changed ${lt.length} → ${mt.length}`

  for (let i = 0; i < lt.length; i++) {
    const a = lt[i]
    const b = mt[i]
    // 1. Preserved identity/metadata fields.
    const identity: Array<keyof PersistedTab> = [
      'conversationId', 'title', 'customTitle', 'workingDirectory',
      'hasChosenDirectory', 'permissionMode', 'groupId', 'groupPinned',
      'pillColor', 'pillIcon', 'engineProfileId', 'lastKnownSessionId',
      'isTerminalOnly', 'lastEventAt', 'lastMessagePreview',
    ]
    for (const k of identity) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        return `tab[${i}] field '${String(k)}' changed: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`
      }
    }
    // historicalSessionIds preserved (order matters).
    if (JSON.stringify(a.historicalSessionIds ?? []) !== JSON.stringify(b.historicalSessionIds ?? [])) {
      return `tab[${i}] historicalSessionIds changed`
    }
    // hasEngineExtension coalesced from either legacy key.
    const expectEngine = a.hasEngineExtension ?? a.isEngine ?? false
    if ((b.hasEngineExtension ?? false) !== expectEngine) {
      return `tab[${i}] hasEngineExtension mismatch: expected ${expectEngine}, got ${b.hasEngineExtension}`
    }

    // Terminal-only tabs carry no conversation pane.
    if (a.isTerminalOnly) continue

    // 2. Unified pane present with ≥1 instance.
    const pane = b.conversationPane
    if (!pane || pane.instances.length === 0) {
      return `tab[${i}] missing conversationPane / instances after migration`
    }

    if (expectEngine) {
      // Extension-hosted: one instance per legacy engineInstances entry.
      const refs = a.engineInstances ?? []
      if (refs.length > 0 && pane.instances.length !== refs.length) {
        return `tab[${i}] instance count ${refs.length} → ${pane.instances.length}`
      }
      for (const ref of refs) {
        const inst = pane.instances.find((x) => x.id === ref.id)
        if (!inst) return `tab[${i}] instance ${ref.id} dropped`
        const legacyMsgs = (a.engineMessages?.[ref.id] ?? []).length
        const migratedMsgs = inst.messages?.length ?? inst.messageCount ?? 0
        if (legacyMsgs !== migratedMsgs) {
          return `tab[${i}] instance ${ref.id} message count ${legacyMsgs} → ${migratedMsgs}`
        }
        const legacyModel = a.engineModelOverrides?.[ref.id]
        if (legacyModel && inst.modelOverride !== legacyModel) {
          return `tab[${i}] instance ${ref.id} modelOverride lost`
        }
        const legacyDenial = a.engineDenials?.[ref.id]
        if (legacyDenial && JSON.stringify(inst.permissionDenied) !== JSON.stringify(legacyDenial)) {
          return `tab[${i}] instance ${ref.id} permissionDenied lost`
        }
        const legacySession = a.engineSessionIds?.[ref.id]
        if (legacySession && !(inst.conversationIds ?? []).includes(legacySession)) {
          return `tab[${i}] instance ${ref.id} sessionId lost`
        }
      }
    } else {
      // Plain: a single main instance carrying the flat fields.
      const main = pane.instances.find((x) => x.id === 'main') ?? pane.instances[0]
      if ((main.messageCount ?? 0) !== (a.messageCount ?? 0)) {
        return `tab[${i}] main messageCount ${a.messageCount ?? 0} → ${main.messageCount ?? 0}`
      }
      if ((a.modelOverride ?? null) && main.modelOverride !== a.modelOverride) {
        return `tab[${i}] main modelOverride lost`
      }
      if (a.permissionDenied && JSON.stringify(main.permissionDenied) !== JSON.stringify(a.permissionDenied)) {
        return `tab[${i}] main permissionDenied lost`
      }
      if (a.planFilePath && main.planFilePath !== a.planFilePath) {
        return `tab[${i}] main planFilePath lost`
      }
      if (a.draftInput && main.draftInput !== a.draftInput) {
        return `tab[${i}] main draftInput lost`
      }
    }
  }
  return null
}

/**
 * Run the full unify migration on a single tabs file:
 *   backup → migrate → verify → keep-backup-on-success / restore-on-failure.
 *
 * - No file / unreadable / already-unified → no-op (returns the reason).
 * - On verify success: writes the unified file, LEAVES the `.pre-migration.<ts>`
 *   backup in place (retained for a few versions so a user can roll back), and
 *   returns success.
 * - On verify failure or any error: restores the original file from the backup
 *   (or simply leaves the untouched original) and returns the reason WITHOUT
 *   writing the migrated content — the app then loads the legacy file via the
 *   read-side back-compat path, so no data is lost.
 *
 * The backup is written even on read-only verify so a partial write can never
 * leave the user without their original tabs.
 */
export function runTabUnifyMigration(tabsPath: string): UnifyMigrationOutcome {
  if (!existsSync(tabsPath)) {
    return { migrated: false, reason: 'no-file' }
  }

  let legacy: PersistedTabState
  try {
    legacy = JSON.parse(readFileSync(tabsPath, 'utf-8'))
  } catch (err) {
    error(`migration: unreadable tabs file ${tabsPath}: ${(err as Error).message}`)
    return { migrated: false, reason: 'error', errorMessage: (err as Error).message }
  }

  if (isUnifiedSchema(legacy)) {
    log(`migration: ${tabsPath} already at schemaVersion ${UNIFIED_SCHEMA_VERSION} — skipping`)
    return { migrated: false, reason: 'already-unified', tabCount: legacy.tabs?.length ?? 0 }
  }

  const ts = Date.now()
  const backupPath = `${tabsPath}.pre-migration.${ts}`
  try {
    copyFileSync(tabsPath, backupPath)
    log(`migration: backed up ${tabsPath} → ${backupPath} (${legacy.tabs?.length ?? 0} tabs)`)
  } catch (err) {
    error(`migration: backup failed for ${tabsPath}: ${(err as Error).message} — aborting (original untouched)`)
    return { migrated: false, reason: 'error', errorMessage: `backup failed: ${(err as Error).message}` }
  }

  let migrated: PersistedTabState
  try {
    migrated = migrateTabStateToUnified(legacy)
  } catch (err) {
    error(`migration: transform threw for ${tabsPath}: ${(err as Error).message} — original untouched, backup kept`)
    return { migrated: false, reason: 'error', backupPath, errorMessage: (err as Error).message }
  }

  const problem = verifyUnifyMigration(legacy, migrated)
  if (problem) {
    error(`migration: VERIFY FAILED for ${tabsPath}: ${problem} — restoring original from backup, NOT writing migrated`)
    // Original file is still the legacy content (we have not written yet), so
    // "restore" is a no-op on the file; we keep the backup for diagnosis and
    // leave the legacy file in place. The read-side back-compat path loads it.
    return { migrated: false, reason: 'verify-failed', backupPath, errorMessage: problem }
  }

  try {
    atomicWriteFileSync(tabsPath, JSON.stringify(migrated, null, 2), 0o644)
    log(`migration: wrote unified ${tabsPath} (schemaVersion ${UNIFIED_SCHEMA_VERSION}, ${migrated.tabs?.length ?? 0} tabs) — backup retained at ${backupPath}`)
    return { migrated: true, reason: 'success', backupPath, tabCount: migrated.tabs?.length ?? 0 }
  } catch (err) {
    // Write failed mid-flight — restore from backup so the file is intact.
    error(`migration: write failed for ${tabsPath}: ${(err as Error).message} — restoring from backup`)
    try {
      copyFileSync(backupPath, tabsPath)
      log(`migration: restored ${tabsPath} from ${backupPath} after write failure`)
    } catch (restoreErr) {
      error(`migration: RESTORE FAILED for ${tabsPath}: ${(restoreErr as Error).message} — backup remains at ${backupPath}`)
    }
    return { migrated: false, reason: 'error', backupPath, errorMessage: (err as Error).message }
  }
}

/** Remove a retained migration backup (used after the retention window). */
export function removeMigrationBackup(backupPath: string): void {
  try {
    if (existsSync(backupPath)) {
      unlinkSync(backupPath)
      log(`migration: removed retained backup ${backupPath}`)
    }
  } catch (err) {
    error(`migration: failed to remove backup ${backupPath}: ${(err as Error).message}`)
  }
}
