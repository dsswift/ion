import { existsSync, readFileSync, copyFileSync } from 'fs'
import { log as _log, error as _error } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import {
  migrateTabStateToExternalized,
  isExternalizedSchema,
  EXTERNALIZE_SCHEMA_VERSION,
} from './tab-migration-externalize'
import { isSplitSchema } from './tab-migration-split'
import {
  mergeExternalContent,
  saveInstanceContent,
  deleteInstanceContent,
} from './tab-content-store'
import type { PersistedTabState } from '../shared/types-persistence'

function log(msg: string, fields?: Record<string, unknown>): void { _log('TabExternalizeMigrate', msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error('TabExternalizeMigrate', msg, fields) }

export interface ExternalizeMigrationOutcome {
  migrated: boolean
  reason: 'already-externalized' | 'not-split' | 'no-file' | 'success' | 'verify-failed' | 'error'
  backupPath?: string
  contentFiles?: number
  errorMessage?: string
}

/**
 * Verify the externalize migration preserved everything, by merging the
 * in-memory content map back onto the thin state THROUGH THE SAME
 * mergeExternalContent the runtime load path uses, then comparing against the
 * input. Returns null on success or a human-readable reason.
 *
 * Checks:
 *  1. Schema version stamped; tab count invariant (guards the `.rejected`
 *     save-guard scenario — a shrunken migration output must never ship).
 *  2. No thin instance carries inline messages; every instance that had
 *     messages carries the hasExternalContent marker and a durable tab id.
 *  3. Round-trip: merged messages byte-identical to the input's (count +
 *     first/last boundary + full JSON equality), messageCount preserved.
 *  4. Non-message instance fields byte-identical (nothing else was touched).
 *  5. Editor: non-dirty entries with a filePath have empty buffers; dirty or
 *     path-less entries byte-identical.
 */
export function verifyExternalizeMigration(
  input: PersistedTabState,
  thin: PersistedTabState,
  contentByTabId: Map<string, import('../shared/types-persistence').ExternalInstanceContent>,
): string | null {
  if (!isExternalizedSchema(thin)) {
    return `output missing schemaVersion >= ${EXTERNALIZE_SCHEMA_VERSION} (got ${thin.schemaVersion ?? 'none'})`
  }
  const inputTabs = input.tabs ?? []
  const thinTabs = thin.tabs ?? []
  if (inputTabs.length !== thinTabs.length) {
    return `tab count changed: ${inputTabs.length} -> ${thinTabs.length}`
  }

  // Merge back through the REAL load-path merge and compare per tab.
  const merged = mergeExternalContent(
    thin,
    (tabId) => (contentByTabId.get(tabId) as never) ?? null,
  )

  for (let i = 0; i < inputTabs.length; i++) {
    const inTab = inputTabs[i]
    const thinTab = thinTabs[i]
    const mergedTab = (merged.tabs ?? [])[i]
    const inInst = inTab.conversationPane?.instances?.[0]
    const thinInst = thinTab.conversationPane?.instances?.[0]
    const mergedInst = mergedTab.conversationPane?.instances?.[0]

    const hadMessages = (inInst?.messages?.length ?? 0) > 0
    if (thinInst?.messages !== undefined) {
      return `tab[${i}]: thin instance still carries inline messages`
    }
    if (hadMessages) {
      if (!thinInst?.hasExternalContent) {
        return `tab[${i}]: instance had messages but thin lacks hasExternalContent`
      }
      if (!thinTab.id) {
        return `tab[${i}]: externalized instance has no durable tab id`
      }
      if (JSON.stringify(mergedInst?.messages ?? []) !== JSON.stringify(inInst!.messages)) {
        return `tab[${i}]: merged messages differ from input`
      }
      const expectedCount = inInst!.messageCount ?? inInst!.messages!.length
      if (thinInst.messageCount !== expectedCount) {
        return `tab[${i}]: messageCount changed (${expectedCount} -> ${thinInst.messageCount})`
      }
    }

    // Non-message instance fields byte-identical.
    if (inInst && thinInst) {
      const stripped = (obj: object) => {
        const clone: Record<string, unknown> = { ...(obj as Record<string, unknown>) }
        delete clone.messages
        delete clone.messageCount
        delete clone.hasExternalContent
        return clone
      }
      if (JSON.stringify(stripped(inInst)) !== JSON.stringify(stripped(thinInst))) {
        return `tab[${i}]: non-message instance fields changed`
      }
    }
  }

  // Editor round-trip rules.
  for (const [dir, inState] of Object.entries(input.editorStates ?? {})) {
    const outState = thin.editorStates?.[dir]
    if (!outState || outState.files.length !== inState.files.length) {
      return `editorStates[${dir}]: file list changed`
    }
    for (let fi = 0; fi < inState.files.length; fi++) {
      const inF = inState.files[fi]
      const outF = outState.files[fi]
      const reloadable = !inF.isDirty && !!inF.filePath
      if (reloadable) {
        if (outF.content !== '' || outF.savedContent !== '') {
          return `editorStates[${dir}][${fi}]: reloadable entry kept content`
        }
      } else if (JSON.stringify(inF) !== JSON.stringify(outF)) {
        return `editorStates[${dir}][${fi}]: dirty/scratch entry changed`
      }
    }
  }

  return null
}

/**
 * Run the full externalize migration on a tabs file:
 *   backup -> migrate -> verify (in memory, via the real merge) ->
 *   write content files -> write thin file / rollback content on failure.
 *
 * Idempotent at v4. Requires split (v3) input — the LOAD_TABS pipeline runs
 * unify and split first. The `.pre-v4.<ts>` backup is retained on success.
 * On any failure the original tabs file is untouched (valid v3, which every
 * downstream reader still handles) and content files written this run are
 * deleted, so a partial run leaves no orphans.
 */
export function runTabExternalizeMigration(tabsPath: string): ExternalizeMigrationOutcome {
  if (!existsSync(tabsPath)) {
    return { migrated: false, reason: 'no-file' }
  }

  let input: PersistedTabState
  try {
    input = JSON.parse(readFileSync(tabsPath, 'utf-8'))
  } catch (err) {
    error('externalize_migration: unreadable tabs file', { path: tabsPath, error: (err as Error).message })
    return { migrated: false, reason: 'error', errorMessage: (err as Error).message }
  }

  if (isExternalizedSchema(input)) {
    return { migrated: false, reason: 'already-externalized' }
  }
  if (!isSplitSchema(input)) {
    log('externalize_migration: not yet split, skipping', { path: tabsPath, schema_version: input.schemaVersion ?? 'none' })
    return { migrated: false, reason: 'not-split' }
  }

  const backupPath = `${tabsPath}.pre-v4.${Date.now()}`
  try {
    copyFileSync(tabsPath, backupPath)
    log('externalize_migration: backed up', { path: tabsPath, backup: backupPath, tabs: input.tabs?.length ?? 0 })
  } catch (err) {
    error('externalize_migration: backup failed', { path: tabsPath, error: (err as Error).message })
    return { migrated: false, reason: 'error', errorMessage: `backup failed: ${(err as Error).message}` }
  }

  let thin: PersistedTabState
  let contentByTabId: ReturnType<typeof migrateTabStateToExternalized>['contentByTabId']
  try {
    ;({ thin, contentByTabId } = migrateTabStateToExternalized(input))
  } catch (err) {
    error('externalize_migration: transform failed', { path: tabsPath, error: (err as Error).message })
    return { migrated: false, reason: 'error', backupPath, errorMessage: (err as Error).message }
  }

  const problem = verifyExternalizeMigration(input, thin, contentByTabId)
  if (problem) {
    error('externalize_migration: verify failed', { path: tabsPath, problem })
    return { migrated: false, reason: 'verify-failed', backupPath, errorMessage: problem }
  }

  // Write content files first, thin file last: a crash between the two leaves
  // a valid v3 tabs file (inline messages) plus harmless extra content files
  // that the next successful run overwrites.
  const written: string[] = []
  try {
    for (const [tabId, content] of contentByTabId) {
      saveInstanceContent(tabId, content.instanceId, content.messages)
      written.push(tabId)
    }
    atomicWriteFileSync(tabsPath, JSON.stringify(thin, null, 2), 0o644)
    log('externalize_migration: wrote v4', { path: tabsPath, version: EXTERNALIZE_SCHEMA_VERSION, content_files: written.length, backup: backupPath })
    return { migrated: true, reason: 'success', backupPath, contentFiles: written.length }
  } catch (err) {
    error('externalize_migration: write failed, rolling back content files', { path: tabsPath, error: (err as Error).message, written: written.length })
    for (const tabId of written) {
      deleteInstanceContent(tabId)
    }
    return { migrated: false, reason: 'error', backupPath, errorMessage: (err as Error).message }
  }
}
