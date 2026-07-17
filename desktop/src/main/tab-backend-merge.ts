import { existsSync, readFileSync } from 'fs'
import { log as _log } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { isUnifiedSchema, migrateTabStateToUnified } from './tab-migration-unify'
import { isSplitSchema, migrateTabStateToSplit, SPLIT_SCHEMA_VERSION } from './tab-migration-split'
import {
  TABS_FILE,
  SESSION_LABELS_FILE,
  SESSION_CHAINS_FILE,
  legacyTabsFileForBackend,
  legacySessionLabelsFileForBackend,
  legacySessionChainsFileForBackend,
} from './settings-store'
import type { PersistedTabState } from '../shared/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * One-time merge of the legacy per-backend tab storage
 * (tabs-{api,cli}.json + session-labels/chains twins) into the unified
 * tabs.json / session-labels.json / session-chains.json.
 *
 * Why this exists: tab storage used to be segregated per global backend mode,
 * so flipping the mode pointed the loader at a different (often empty) file
 * and every open tab "vanished". With credential-based routing there is no
 * mode, so there is one tab file; this migration recovers whatever the user
 * had in BOTH legacy files into it.
 *
 * Safety properties:
 *  - Idempotent: a unified file already on disk short-circuits (the merge ran
 *    before, or the install is new enough to never have had legacy files).
 *  - Non-destructive: legacy source files are retained, never deleted or
 *    rewritten — they stay readable for the cleanup guards and as backups.
 *  - Normalizing: each source is run through the pure unify (v1→v2) and split
 *    (v2→v3) transforms before merging, so two files at different schema
 *    versions merge into one coherent v3 state.
 */

export interface BackendMergeOutcome {
  applied: boolean
  reason: 'success' | 'skipped-existing' | 'skipped-no-sources' | 'error'
  tabCounts?: { api: number; cli: number; merged: number }
  errorMessage?: string
}

/** Normalize a raw persisted state to the split (v3) schema, purely. */
function normalizeToSplit(state: PersistedTabState): PersistedTabState {
  let s = state
  if (!isUnifiedSchema(s)) s = migrateTabStateToUnified(s)
  if (!isSplitSchema(s)) s = migrateTabStateToSplit(s)
  return s
}

/** Dedupe key for a tab: durable id first, conversation id second, else a
 *  per-call unique key (never deduped — two id-less, conversation-less tabs
 *  are indistinguishable and both survive). */
function tabKey(tab: { id?: string; conversationId: string | null }, index: number, side: string): string {
  if (tab.id) return `id:${tab.id}`
  if (tab.conversationId) return `conv:${tab.conversationId}`
  return `anon:${side}:${index}`
}

/**
 * Pure merge of two normalized (v3) tab states. The api state is the primary:
 * its tabs come first, its active-tab fields and window geometries win, and on
 * a duplicate tab key its copy is kept. Exported for tests.
 */
export function mergeTabStates(
  api: PersistedTabState | null,
  cli: PersistedTabState | null,
): PersistedTabState {
  if (api && !cli) return api
  if (cli && !api) return cli
  if (!api || !cli) return { schemaVersion: SPLIT_SCHEMA_VERSION, activeSessionId: null, tabs: [] }

  const seen = new Set<string>()
  const tabs: PersistedTabState['tabs'] = []
  let dropped = 0
  for (const [side, state] of [['api', api], ['cli', cli]] as const) {
    state.tabs.forEach((tab, i) => {
      const key = tabKey(tab, i, side)
      if (seen.has(key)) {
        dropped++
        log('tab_backend_merge: dropped duplicate tab', { key, side })
        return
      }
      seen.add(key)
      tabs.push(tab)
    })
  }

  const merged: PersistedTabState = {
    ...cli,
    ...api,
    schemaVersion: SPLIT_SCHEMA_VERSION,
    tabs,
    // api tabs are first, so api's activeTabIndex stays valid; fall back to
    // cli's active conversation when api had none.
    activeSessionId: api.activeSessionId ?? cli.activeSessionId,
    activeTabIndex:
      api.activeTabIndex != null
        ? api.activeTabIndex
        : cli.activeTabIndex != null
          ? api.tabs.length + cli.activeTabIndex
          : null,
    editorStates: { ...(cli.editorStates ?? {}), ...(api.editorStates ?? {}) },
    editorOpenDirs: Array.from(new Set([...(api.editorOpenDirs ?? []), ...(cli.editorOpenDirs ?? [])])),
  }
  if (dropped > 0) log('tab_backend_merge: duplicates dropped', { count: dropped })
  return merged
}

function readStateFile(path: string): PersistedTabState | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || !Array.isArray(raw.tabs)) {
      log('tab_backend_merge: source file has no tabs array, skipping', { path })
      return null
    }
    return raw as PersistedTabState
  } catch (err) {
    log('tab_backend_merge: failed to parse source file, skipping', { path, error: String(err) })
    return null
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch (err) {
    log('tab_backend_merge: failed to parse source file, skipping', { path, error: String(err) })
    return null
  }
}

/** Merge the labels twins (flat conversationId → title). api wins per key. */
function mergeLabels(): void {
  if (existsSync(SESSION_LABELS_FILE)) return
  const api = readJsonObject(legacySessionLabelsFileForBackend('api'))
  const cli = readJsonObject(legacySessionLabelsFileForBackend('cli'))
  if (!api && !cli) return
  const merged = { ...(cli ?? {}), ...(api ?? {}) }
  atomicWriteFileSync(SESSION_LABELS_FILE, JSON.stringify(merged, null, 2), 0o644)
  log('tab_backend_merge: labels merged', {
    api: Object.keys(api ?? {}).length,
    cli: Object.keys(cli ?? {}).length,
    merged: Object.keys(merged).length,
  })
}

/** Merge the chains twins ({chains, reverse}). api wins per key. */
function mergeChains(): void {
  if (existsSync(SESSION_CHAINS_FILE)) return
  const api = readJsonObject(legacySessionChainsFileForBackend('api'))
  const cli = readJsonObject(legacySessionChainsFileForBackend('cli'))
  if (!api && !cli) return
  const merged = {
    chains: { ...((cli?.chains as object) ?? {}), ...((api?.chains as object) ?? {}) },
    reverse: { ...((cli?.reverse as object) ?? {}), ...((api?.reverse as object) ?? {}) },
  }
  atomicWriteFileSync(SESSION_CHAINS_FILE, JSON.stringify(merged, null, 2), 0o644)
  log('tab_backend_merge: chains merged', {
    merged_chains: Object.keys(merged.chains).length,
    merged_reverse: Object.keys(merged.reverse).length,
  })
}

/**
 * Run the one-time backend merge. Called at the LOAD_TABS chokepoint BEFORE
 * the unify/split migrations, so those (and everything downstream) operate on
 * the unified file. Labels and chains merge alongside on the same trigger.
 */
export function runTabBackendMerge(): BackendMergeOutcome {
  try {
    // Labels/chains have their own existence guards so a partially-applied
    // earlier run (e.g. crash between writes) completes on the next launch.
    mergeLabels()
    mergeChains()

    if (existsSync(TABS_FILE)) {
      return { applied: false, reason: 'skipped-existing' }
    }

    const apiRaw = readStateFile(legacyTabsFileForBackend('api'))
    const cliRaw = readStateFile(legacyTabsFileForBackend('cli'))
    if (!apiRaw && !cliRaw) {
      return { applied: false, reason: 'skipped-no-sources' }
    }

    const api = apiRaw ? normalizeToSplit(apiRaw) : null
    const cli = cliRaw ? normalizeToSplit(cliRaw) : null
    const merged = mergeTabStates(api, cli)

    // Invariant: the union may drop only exact duplicates — a merge that
    // loses tabs relative to its largest source is a bug, not a merge.
    const apiCount = api?.tabs.length ?? 0
    const cliCount = cli?.tabs.length ?? 0
    if (merged.tabs.length < Math.max(apiCount, cliCount)) {
      log('tab_backend_merge: verify failed, merged smaller than largest source', {
        api: apiCount,
        cli: cliCount,
        merged: merged.tabs.length,
      })
      return { applied: false, reason: 'error', errorMessage: 'merged tab count below largest source' }
    }

    atomicWriteFileSync(TABS_FILE, JSON.stringify(merged, null, 2), 0o644)
    log('tab_backend_merge: tabs merged', { api: apiCount, cli: cliCount, merged: merged.tabs.length, path: TABS_FILE })
    return {
      applied: true,
      reason: 'success',
      tabCounts: { api: apiCount, cli: cliCount, merged: merged.tabs.length },
    }
  } catch (err) {
    log('tab_backend_merge: error', { error: String(err) })
    return { applied: false, reason: 'error', errorMessage: String(err) }
  }
}
