import { existsSync, readFileSync, copyFileSync } from 'fs'
import { log as _log, error as _error } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import {
  migrateTabStateToSplit,
  isSplitSchema,
  SPLIT_SCHEMA_VERSION,
} from './tab-migration-split'
import { isUnifiedSchema } from './tab-migration-unify'
import type {
  PersistedTabState,
  PersistedTab,
  PersistedConversationInstance,
} from '../shared/types-persistence'

function log(msg: string, fields?: Record<string, unknown>): void { _log('TabSplitMigrate', msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error('TabSplitMigrate', msg, fields) }

export interface SplitMigrationOutcome {
  migrated: boolean
  reason: 'already-split' | 'not-unified' | 'no-file' | 'no-multi' | 'success' | 'verify-failed' | 'error'
  backupPath?: string
  tabsBefore?: number
  tabsAfter?: number
  errorMessage?: string
}

// ─── Instance identity ───────────────────────────────────────────────────────
//
// The unify migration preserves tab count (1:1), so its verify can match tabs
// by array position. The split migration changes tab count (1:N), so
// positional matching is impossible. Instead, the verify builds an
// instance-keyed map: every (sourceTabIndex, instanceId) pair in the input
// must appear in exactly one output tab, with all per-instance data intact.
//
// Key: `${sourceTabIndex}:${instanceId}`
// ──────────────────────────────────────────────────────────────────────────────

interface InstanceRef {
  sourceTabIndex: number
  instance: PersistedConversationInstance
  parentTab: PersistedTab
}

/**
 * Build a map of every instance in the input state keyed by
 * `sourceTabIndex:instanceId`. Multi-instance tabs contribute one entry per
 * instance; single-instance tabs contribute one entry; terminal-only tabs
 * contribute none.
 */
function buildInputInstanceMap(state: PersistedTabState): Map<string, InstanceRef> {
  const map = new Map<string, InstanceRef>()
  for (let i = 0; i < (state.tabs ?? []).length; i++) {
    const tab = state.tabs[i]
    if (tab.isTerminalOnly) continue
    const instances = tab.conversationPane?.instances ?? []
    for (const inst of instances) {
      map.set(`${i}:${inst.id}`, { sourceTabIndex: i, instance: inst, parentTab: tab })
    }
  }
  return map
}

/**
 * Verify a split-migrated state preserved every instance from the input.
 *
 * Returns null on success, or a human-readable reason on the first detected
 * discrepancy. This is the gate that decides keep-backup-on-success vs
 * restore-on-failure.
 *
 * Checks:
 *   1. Schema version is stamped.
 *   2. Total instance count: input instances == output instances (no drops,
 *      no duplicates).
 *   3. Every output non-terminal tab has exactly 0 or 1 instances (the
 *      single-instance invariant).
 *   4. Every input instance maps to exactly one output tab carrying that
 *      instance, with per-instance data byte-identical:
 *        - messages (full history)
 *        - conversationIds
 *        - modelOverride
 *        - draftInput
 *        - permissionMode
 *        - permissionDenied
 *        - agentStates
 *   5. Parent metadata preserved on each output tab: workingDirectory,
 *      engineProfileId, hasEngineExtension.
 *   6. Non-split tabs (single-instance, terminal-only) pass through
 *      unchanged (tab count for non-split input tabs is stable).
 */
export function verifySplitMigration(
  input: PersistedTabState,
  output: PersistedTabState,
): string | null {
  // 1. Schema version
  if (!isSplitSchema(output)) {
    return `output missing split schemaVersion (expected >= ${SPLIT_SCHEMA_VERSION}, got ${output.schemaVersion ?? 'none'})`
  }

  const inputTabs = input.tabs ?? []
  const outputTabs = output.tabs ?? []

  // 2. Count all instances in input and output.
  let inputInstanceCount = 0
  for (const tab of inputTabs) {
    if (tab.isTerminalOnly) continue
    inputInstanceCount += (tab.conversationPane?.instances ?? []).length
  }
  let outputInstanceCount = 0
  for (const tab of outputTabs) {
    if (tab.isTerminalOnly) continue
    outputInstanceCount += (tab.conversationPane?.instances ?? []).length
  }
  if (inputInstanceCount !== outputInstanceCount) {
    return `total instance count changed: ${inputInstanceCount} -> ${outputInstanceCount}`
  }

  // 3. Single-instance invariant on every non-terminal output tab.
  for (let i = 0; i < outputTabs.length; i++) {
    const t = outputTabs[i]
    if (t.isTerminalOnly) continue
    const count = (t.conversationPane?.instances ?? []).length
    if (count > 1) {
      return `output tab[${i}] still has ${count} instances (expected 0 or 1)`
    }
  }

  // 4. Every input instance maps to exactly one output tab.
  const inputMap = buildInputInstanceMap(input)
  // Track which output tabs are claimed (to detect duplicates).
  const claimedOutputIndices = new Set<number>()

  for (const [key, ref] of inputMap) {
    // Find the output tab carrying this instance.
    let found = false
    for (let oi = 0; oi < outputTabs.length; oi++) {
      if (claimedOutputIndices.has(oi)) continue
      const outTab = outputTabs[oi]
      if (outTab.isTerminalOnly) continue
      const outInst = outTab.conversationPane?.instances?.[0]
      if (!outInst || outInst.id !== ref.instance.id) continue

      // Verify this output tab came from the same source tab (parent metadata).
      if (outTab.workingDirectory !== ref.parentTab.workingDirectory) continue
      if (outTab.engineProfileId !== ref.parentTab.engineProfileId) continue

      // 4a. Per-instance data preservation.
      const a = ref.instance
      const b = outInst

      if (JSON.stringify(a.messages ?? []) !== JSON.stringify(b.messages ?? [])) {
        return `instance ${key}: messages differ`
      }
      if (JSON.stringify(a.conversationIds ?? []) !== JSON.stringify(b.conversationIds ?? [])) {
        return `instance ${key}: conversationIds differ`
      }
      if ((a.modelOverride ?? null) !== (b.modelOverride ?? null)) {
        return `instance ${key}: modelOverride differs (${a.modelOverride} -> ${b.modelOverride})`
      }
      if ((a.draftInput ?? '') !== (b.draftInput ?? '')) {
        return `instance ${key}: draftInput differs`
      }
      if ((a.permissionMode ?? 'auto') !== (b.permissionMode ?? 'auto')) {
        return `instance ${key}: permissionMode differs (${a.permissionMode} -> ${b.permissionMode})`
      }
      if (JSON.stringify(a.permissionDenied ?? null) !== JSON.stringify(b.permissionDenied ?? null)) {
        return `instance ${key}: permissionDenied differs`
      }
      if (JSON.stringify(a.agentStates ?? []) !== JSON.stringify(b.agentStates ?? [])) {
        return `instance ${key}: agentStates differ`
      }

      // 5. Parent metadata on the output tab.
      if ((outTab.hasEngineExtension ?? false) !== (ref.parentTab.hasEngineExtension ?? false)) {
        return `instance ${key}: output tab hasEngineExtension mismatch`
      }
      // 5a. Visual/grouping metadata preserved on split output tabs.
      if ((outTab.groupId ?? null) !== (ref.parentTab.groupId ?? null)) {
        return `instance ${key}: output tab groupId mismatch (${outTab.groupId} vs ${ref.parentTab.groupId})`
      }
      if ((outTab.pillColor ?? null) !== (ref.parentTab.pillColor ?? null)) {
        return `instance ${key}: output tab pillColor mismatch (${outTab.pillColor} vs ${ref.parentTab.pillColor})`
      }
      if ((outTab.pillIcon ?? null) !== (ref.parentTab.pillIcon ?? null)) {
        return `instance ${key}: output tab pillIcon mismatch (${outTab.pillIcon} vs ${ref.parentTab.pillIcon})`
      }
      if ((outTab.groupPinned ?? false) !== (ref.parentTab.groupPinned ?? false)) {
        return `instance ${key}: output tab groupPinned mismatch (${outTab.groupPinned} vs ${ref.parentTab.groupPinned})`
      }

      claimedOutputIndices.add(oi)
      found = true
      break
    }
    if (!found) {
      return `instance ${key} (id=${ref.instance.id}) not found in any output tab`
    }
  }

  // 6. Non-split tabs preserved: count input tabs that are single-instance
  // Verify the output tab count matches what the split should produce:
  //   terminal tabs (unchanged) + single-instance tabs (unchanged) +
  //   one output tab per instance of every multi-instance input tab.
  let expectedSplitTabs = 0
  for (const tab of inputTabs) {
    if (tab.isTerminalOnly) continue
    const count = (tab.conversationPane?.instances ?? []).length
    if (count > 1) expectedSplitTabs += count
  }
  const terminalCount = inputTabs.filter((t) => t.isTerminalOnly).length
  const singleInstanceInputCount = inputTabs.length - terminalCount - inputTabs.filter(
    (t) => !t.isTerminalOnly && (t.conversationPane?.instances ?? []).length > 1
  ).length
  const expectedTotal = terminalCount + singleInstanceInputCount + expectedSplitTabs
  if (outputTabs.length !== expectedTotal) {
    return `output tab count ${outputTabs.length} != expected ${expectedTotal} (${terminalCount} terminal + ${singleInstanceInputCount} single + ${expectedSplitTabs} from splits)`
  }

  return null
}

/**
 * Run the full split migration on a single tabs file:
 *   backup -> migrate -> verify -> keep-backup-on-success / restore-on-failure.
 *
 * Preconditions:
 *   - The file must exist and be valid JSON.
 *   - The file must already be at schemaVersion >= 2 (unified). If not, the
 *     caller should run the unify migration first.
 *   - If no tabs have >1 instance, the migration stamps the version but
 *     skips the backup (there is nothing to protect).
 *
 * On verify success: writes the split file, LEAVES the `.pre-split.<ts>`
 * backup in place, returns success.
 *
 * On verify failure or any error: does NOT write the migrated content. The
 * original file remains untouched. The renderer's defensive single-instance
 * restore path handles any multi-instance tabs that survive.
 */
export function runTabSplitMigration(tabsPath: string): SplitMigrationOutcome {
  if (!existsSync(tabsPath)) {
    return { migrated: false, reason: 'no-file' }
  }

  let input: PersistedTabState
  try {
    input = JSON.parse(readFileSync(tabsPath, 'utf-8'))
  } catch (err) {
    error('split_migration: unreadable tabs file', { path: tabsPath, error: (err as Error).message })
    return { migrated: false, reason: 'error', errorMessage: (err as Error).message }
  }

  // Already split: no-op.
  if (isSplitSchema(input)) {
    log('split_migration: already at target version', { path: tabsPath, version: SPLIT_SCHEMA_VERSION })
    return { migrated: false, reason: 'already-split', tabsBefore: input.tabs?.length ?? 0 }
  }

  // Must be unified first. If it's not, we can't split safely.
  if (!isUnifiedSchema(input)) {
    log('split_migration: not yet unified, skipping', { path: tabsPath, schema_version: input.schemaVersion ?? 'none' })
    return { migrated: false, reason: 'not-unified' }
  }

  // Check if any tab actually needs splitting.
  const hasMulti = (input.tabs ?? []).some(
    (t) => !t.isTerminalOnly && (t.conversationPane?.instances ?? []).length > 1
  )
  if (!hasMulti) {
    // No multi-instance tabs, but stamp the version so we don't check again.
    // This is safe to write without a backup since no data is changing.
    try {
      const stamped: PersistedTabState = { ...input, schemaVersion: SPLIT_SCHEMA_VERSION }
      atomicWriteFileSync(tabsPath, JSON.stringify(stamped, null, 2), 0o644)
      log('split_migration: no multi-instance tabs, stamped', { path: tabsPath, version: SPLIT_SCHEMA_VERSION })
      return { migrated: true, reason: 'no-multi', tabsBefore: input.tabs?.length ?? 0, tabsAfter: input.tabs?.length ?? 0 }
    } catch (err) {
      error('split_migration: version stamp failed', { path: tabsPath, error: (err as Error).message })
      return { migrated: false, reason: 'error', errorMessage: (err as Error).message }
    }
  }

  // There are multi-instance tabs. Full backup/migrate/verify/write pipeline.
  const ts = Date.now()
  const backupPath = `${tabsPath}.pre-split.${ts}`
  try {
    copyFileSync(tabsPath, backupPath)
    log('split_migration: backed up', { path: tabsPath, backup: backupPath, tabs: input.tabs?.length ?? 0 })
  } catch (err) {
    error('split_migration: backup failed', { path: tabsPath, error: (err as Error).message })
    return { migrated: false, reason: 'error', errorMessage: `backup failed: ${(err as Error).message}` }
  }

  let migrated: PersistedTabState
  try {
    migrated = migrateTabStateToSplit(input)
  } catch (err) {
    error('split_migration: transform failed', { path: tabsPath, error: (err as Error).message })
    return { migrated: false, reason: 'error', backupPath, errorMessage: (err as Error).message }
  }

  const problem = verifySplitMigration(input, migrated)
  if (problem) {
    error('split_migration: verify failed', { path: tabsPath, problem })
    return { migrated: false, reason: 'verify-failed', backupPath, errorMessage: problem }
  }

  try {
    atomicWriteFileSync(tabsPath, JSON.stringify(migrated, null, 2), 0o644)
    log('split_migration: wrote split', { path: tabsPath, version: SPLIT_SCHEMA_VERSION, tabs_before: input.tabs?.length ?? 0, tabs_after: migrated.tabs?.length ?? 0, backup: backupPath })
    return {
      migrated: true,
      reason: 'success',
      backupPath,
      tabsBefore: input.tabs?.length ?? 0,
      tabsAfter: migrated.tabs?.length ?? 0,
    }
  } catch (err) {
    // Write failed mid-flight: restore from backup.
    error('split_migration: write failed', { path: tabsPath, error: (err as Error).message })
    try {
      copyFileSync(backupPath, tabsPath)
      log('split_migration: restored', { path: tabsPath, backup: backupPath })
    } catch (restoreErr) {
      error('split_migration: restore failed', { path: tabsPath, error: (restoreErr as Error).message, backup: backupPath })
    }
    return { migrated: false, reason: 'error', backupPath, errorMessage: (err as Error).message }
  }
}
