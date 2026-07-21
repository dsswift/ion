import { existsSync, readFileSync } from 'fs'
import { engineBridge } from './state'
import { log as _log } from './logger'
import { TABS_FILE } from './settings-store'
import { listContentTabIds, deleteInstanceContent } from './tab-content-store'

function log(msg: string, fields?: Record<string, unknown>): void { _log('cleanup', msg, fields) }

// DRY_RUN semantics (D-018): the cleanup runs in dry-run mode UNLESS an
// enterprise retention policy (conversationRetentionDays from the engine's
// get_enterprise_policy blob) is in force. Unmanaged installs therefore keep
// the original always-dry-run behavior — nothing is ever deleted — while a
// managed install with a declared TTL performs real deletions against that
// TTL. The per-run resolution lives in runCleanup; there is no module-level
// flag anymore, because "dry run or not" is a property of the active policy,
// not of the build.
//
// Before the policy-driven flip existed, DRY_RUN was a hardcoded `true` with
// a manual verification procedure documented in
// docs/plans/grassy-chirping-crest.md "Layer 4". That cross-check discipline
// still applies to any enterprise enabling retention for the first time:
// verify the dry-run log output (run one cycle without the policy) against a
// manual count before deploying conversationRetentionDays.
const DEFAULT_MAX_AGE_DAYS = 14

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const MIN_STARTUP_DELAY_MS = 5 * 60 * 1000  // Boot gate: wait at least 5 min after main process start.
const MAX_STARTUP_DELAY_MS = 30 * 60 * 1000 // Hard upper bound: never delay the first run past 30 min.
const BOOT_GATE_POLL_MS = 30 * 1000         // Re-check the boot-gate condition every 30s after the min delay.

/**
 * Files the cleanup job must read to collect the protected conversationId set.
 *
 * tabsFiles — every `tabs-{backend}.json` (both api and cli). Each tab
 *   contributes up to five distinct conversation IDs: `conversationId`,
 *   `lastKnownSessionId`, `historicalSessionIds[]`, `engineSessionIds{}`
 *   values, and `engineInstances[].conversationIds[]`. Missing any source
 *   would risk deleting a conversation that backs a visible tab.
 *
 * chainsFiles — every `session-chains-{backend}.json`. Each file is a
 *   `{ chains: { rootId: [contIds...] }, reverse: { contId: rootId } }`
 *   object. Every key and value in both maps is a load-bearing ID: the
 *   chain records every conversationId a tab has ever resumed, even cold
 *   tabs and tabs not touched since the most recent engine restart.
 *
 * labelsFiles — every `session-labels-{backend}.json`. Each file is a flat
 *   `{ conversationId: "user label" }` object. Every key is a labeled
 *   conversation that the user has explicitly named and therefore values.
 */
export interface CleanupSources {
  tabsFiles: string[]
  chainsFiles: string[]
  labelsFiles: string[]
}

/**
 * Read every cleanup source file and union the contained conversation IDs.
 *
 * Logging requirements (see docs/plans/grassy-chirping-crest.md, Layer 2):
 * every run must log a structured per-source breakdown so we can diagnose
 * future regressions in the collector. The breakdown is printed regardless
 * of outcome — including when sources contribute zero IDs.
 *
 * Safety contract: if the collection produces zero IDs and the inputs are
 * non-empty (i.e. files exist on disk), the caller MUST treat the result
 * as a collection failure and abort the cleanup run. The previous version
 * silently sent `excludeIds=[]` to the engine, which under a future
 * `DRY_RUN=false` would have deleted up to 51 tab-referenced conversations.
 * See the `aborted=zero-ids-with-files-present` branch in `runCleanup`.
 */
export function collectProtectedIds(sources: CleanupSources): {
  ids: string[]
  breakdown: {
    tabs: { file: string; tabCount: number; idsContributed: number }[]
    chains: { file: string; idsContributed: number }[]
    labels: { file: string; idsContributed: number }[]
    filesPresent: number
  }
} {
  const ids = new Set<string>()
  const breakdown = {
    tabs: [] as { file: string; tabCount: number; idsContributed: number }[],
    chains: [] as { file: string; idsContributed: number }[],
    labels: [] as { file: string; idsContributed: number }[],
    filesPresent: 0,
  }

  for (const file of sources.tabsFiles) {
    if (!file || !existsSync(file)) continue
    breakdown.filesPresent++
    const before = ids.size
    let tabCount = 0
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      const tabs: any[] = Array.isArray(raw) ? raw : raw.tabs || []
      tabCount = tabs.length
      for (const tab of tabs) {
        if (typeof tab?.conversationId === 'string' && tab.conversationId) ids.add(tab.conversationId)
        if (typeof tab?.lastKnownSessionId === 'string' && tab.lastKnownSessionId) ids.add(tab.lastKnownSessionId)
        if (Array.isArray(tab?.historicalSessionIds)) {
          for (const id of tab.historicalSessionIds) {
            if (typeof id === 'string' && id) ids.add(id)
          }
        }
        if (tab?.engineSessionIds && typeof tab.engineSessionIds === 'object') {
          for (const id of Object.values(tab.engineSessionIds)) {
            if (typeof id === 'string' && id) ids.add(id)
          }
        }
        if (Array.isArray(tab?.engineInstances)) {
          for (const inst of tab.engineInstances) {
            if (Array.isArray(inst?.conversationIds)) {
              for (const id of inst.conversationIds) {
                if (typeof id === 'string' && id) ids.add(id)
              }
            }
          }
        }
      }
    } catch (err: any) {
      log('cleanup: collect failed to parse', { file, error: err.message })
    }
    breakdown.tabs.push({ file, tabCount, idsContributed: ids.size - before })
  }

  for (const file of sources.chainsFiles) {
    if (!file || !existsSync(file)) continue
    breakdown.filesPresent++
    const before = ids.size
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      if (raw && typeof raw === 'object') {
        if (raw.chains && typeof raw.chains === 'object') {
          for (const [rootId, continuations] of Object.entries(raw.chains)) {
            if (typeof rootId === 'string' && rootId) ids.add(rootId)
            if (Array.isArray(continuations)) {
              for (const id of continuations) {
                if (typeof id === 'string' && id) ids.add(id)
              }
            }
          }
        }
        if (raw.reverse && typeof raw.reverse === 'object') {
          for (const [contId, rootId] of Object.entries(raw.reverse)) {
            if (typeof contId === 'string' && contId) ids.add(contId)
            if (typeof rootId === 'string' && rootId) ids.add(rootId)
          }
        }
      }
    } catch (err: any) {
      log('cleanup: collect failed to parse', { file, error: err.message })
    }
    breakdown.chains.push({ file, idsContributed: ids.size - before })
  }

  for (const file of sources.labelsFiles) {
    if (!file || !existsSync(file)) continue
    breakdown.filesPresent++
    const before = ids.size
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const id of Object.keys(raw)) {
          if (typeof id === 'string' && id) ids.add(id)
        }
      }
    } catch (err: any) {
      log('cleanup: collect failed to parse', { file, error: err.message })
    }
    breakdown.labels.push({ file, idsContributed: ids.size - before })
  }

  return { ids: Array.from(ids), breakdown }
}

function _formatBreakdown(b: ReturnType<typeof collectProtectedIds>['breakdown']): string {
  const tabsStr = b.tabs.map((t) => `${t.file.split('/').pop()}(tabs=${t.tabCount},ids=${t.idsContributed})`).join(',')
  const chainsStr = b.chains.map((c) => `${c.file.split('/').pop()}(ids=${c.idsContributed})`).join(',')
  const labelsStr = b.labels.map((l) => `${l.file.split('/').pop()}(ids=${l.idsContributed})`).join(',')
  return `filesPresent=${b.filesPresent} tabs=[${tabsStr}] chains=[${chainsStr}] labels=[${labelsStr}]`
}

/**
 * Delete externalized tab-content files (schema v4) whose tab id no longer
 * appears in the thin manifest. Safety net behind the delete-on-close path
 * (renderer closeTab → DELETE_TAB_CONTENT) for closes that crashed mid-way.
 * Fail-safe: an unreadable manifest aborts the sweep — deleting content on a
 * guess is exactly the class of loss this file exists to prevent.
 */
export function sweepOrphanedTabContent(tabsFile: string = TABS_FILE): number {
  let liveIds: Set<string>
  try {
    if (!existsSync(tabsFile)) return 0
    const raw = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    const tabs: unknown[] = Array.isArray(raw?.tabs) ? raw.tabs : []
    liveIds = new Set(
      tabs
        .map((t) => (t as { id?: string })?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
  } catch (err: any) {
    log('cleanup: tab-content sweep aborted, manifest unreadable', { file: tabsFile, error: err.message })
    return 0
  }

  let deleted = 0
  for (const tabId of listContentTabIds()) {
    if (liveIds.has(tabId)) continue
    deleteInstanceContent(tabId)
    deleted++
  }
  if (deleted > 0) {
    log('cleanup: orphaned tab-content files deleted', { count: deleted, live_tabs: liveIds.size })
  }
  return deleted
}

/**
 * Resolve the effective cleanup mode from the enterprise retention policy.
 * Exported for tests. A undefined/invalid TTL means dry-run with the default
 * age window (the unmanaged-install behavior: log candidates, delete
 * nothing). A positive integer TTL means live deletion of conversations
 * older than that many days.
 */
export function resolveCleanupMode(retentionDays: number | undefined): { dryRun: boolean; maxAgeDays: number } {
  if (typeof retentionDays === 'number' && Number.isFinite(retentionDays) && retentionDays > 0) {
    return { dryRun: false, maxAgeDays: Math.floor(retentionDays) }
  }
  return { dryRun: true, maxAgeDays: DEFAULT_MAX_AGE_DAYS }
}

async function runCleanup(sources: CleanupSources, retentionDays: number | undefined): Promise<void> {
  try {
    // Local, cheap, and independent of the engine: sweep orphaned content
    // files on the same cadence as the conversation cleanup.
    sweepOrphanedTabContent()

    const { ids: excludeIds, breakdown } = collectProtectedIds(sources)

    // Defense-in-depth safety check (see Layer 2 in the plan):
    // if any input files exist on disk but the collector returned zero IDs,
    // something is wrong (corrupted JSON, schema drift, file emptied mid-read).
    // Aborting is strictly safer than letting the cleanup proceed with no
    // desktop-side excludes.
    //
    // Note: the engine's Layer-1 guard (LoadDesktopProtectedIDs) reads the
    // same chains/labels files independently, so even on abort here the
    // engine will still refuse to delete tab-referenced conversations.
    // This abort is the last belt on top of the suspenders.
    if (excludeIds.length === 0 && breakdown.filesPresent > 0) {
      log('cleanup: aborted, zero IDs collected', { files_present: breakdown.filesPresent })
      log('aborted: cleanup will NOT run this cycle. Investigate before next interval.')
      return
    }

    const { dryRun, maxAgeDays } = resolveCleanupMode(retentionDays)
    log('cleanup: starting', { exclude_ids: excludeIds.length, dry_run: dryRun, max_age_days: maxAgeDays, retention_policy: retentionDays ?? null })
    await engineBridge.connect()
    const result = await engineBridge._sendWithData<{ deleted: number }>({
      cmd: 'delete_stored_sessions',
      maxAgeDays,
      excludeIds,
      dryRun,
    })
    if (result.ok) {
      const count = result.data?.deleted ?? 0
      log(dryRun ? 'cleanup: dry-run would delete' : 'cleanup: deleted stale conversations', { count })
    } else {
      log('cleanup: engine error', { error: result.error })
    }
  } catch (err: any) {
    log('cleanup: failed', { error: err.message })
  }
}

/**
 * Boot gate (Layer 3 in docs/plans/grassy-chirping-crest.md): the first
 * cleanup run waits for both conditions:
 *
 *  1. At least MIN_STARTUP_DELAY_MS has elapsed since process start (5 min).
 *     Gives the renderer time to hydrate tabs from disk, the engine time
 *     to load session histories, and the persistence layer time to write
 *     the first SAVE_TABS snapshot.
 *
 *  2. The engine has at least one active session (`activeSessions.size > 0`).
 *     Indicates the user has interacted with the app at least once since
 *     startup. Avoids running cleanup on a freshly-launched app where the
 *     desktop's collector might race against initial state hydration.
 *
 * If condition 2 stays false for MAX_STARTUP_DELAY_MS (30 min) — i.e. the
 * user opened the app but never sent a prompt — the cleanup runs anyway.
 * In that case the engine's Layer-1 guard (LoadDesktopProtectedIDs) is the
 * load-bearing protection: it reads the desktop's persisted chains/labels
 * files directly and is independent of in-process session state.
 *
 * After the first run, subsequent runs use the CLEANUP_INTERVAL_MS ticker
 * with no further boot-gate checks (the boot-time race is long over by
 * then).
 */
function scheduleFirstRun(sources: CleanupSources, retentionDays: number | undefined): void {
  const startTime = Date.now()
  const minDeadline = startTime + MIN_STARTUP_DELAY_MS
  const maxDeadline = startTime + MAX_STARTUP_DELAY_MS

  const tryRun = () => {
    const now = Date.now()
    const elapsedMs = now - startTime
    const activeSessionCount = engineBridge.activeSessions.size

    if (now < minDeadline) {
      // Below the 5-minute floor: keep waiting.
      const remainingMs = minDeadline - now
      log('cleanup: boot-gate waiting for min delay', { remaining_s: Math.ceil(remainingMs / 1000) })
      setTimeout(tryRun, Math.min(remainingMs, BOOT_GATE_POLL_MS))
      return
    }

    if (activeSessionCount > 0 || now >= maxDeadline) {
      const trigger = activeSessionCount > 0 ? `sessions=${activeSessionCount}` : 'max-uptime-reached'
      log('cleanup: boot-gate triggering first run', { elapsed_s: Math.round(elapsedMs / 1000), trigger })
      void runCleanup(sources, retentionDays)
      return
    }

    // Past the min delay but still no active sessions and below max deadline:
    // poll every 30s.
    log('cleanup: boot-gate waiting for first session', { elapsed_s: Math.round(elapsedMs / 1000) })
    setTimeout(tryRun, BOOT_GATE_POLL_MS)
  }

  setTimeout(tryRun, MIN_STARTUP_DELAY_MS)
}

/**
 * Wire up the periodic conversation cleanup.
 *
 * `sources` is an explicit list of files the collector reads; passing them
 * from the caller (rather than re-deriving inside the closure) eliminates
 * the lazy `require('./settings-store')` failure mode that caused the
 * desktop to send `excludeIds=[]` on its first invocation. See
 * docs/plans/grassy-chirping-crest.md Layer 2 for the post-mortem.
 *
 * `retentionDays` is the enterprise conversationRetentionDays policy (D-018),
 * fetched by the caller from the engine's get_enterprise_policy blob.
 * Undefined = no retention policy = dry-run mode (nothing is ever deleted),
 * preserving the unmanaged-install behavior.
 */
export function startConversationCleanup(sources: CleanupSources, retentionDays?: number): void {
  const { dryRun, maxAgeDays } = resolveCleanupMode(retentionDays)
  scheduleFirstRun(sources, retentionDays)
  setInterval(() => void runCleanup(sources, retentionDays), CLEANUP_INTERVAL_MS)
  log('cleanup: scheduled', { min_delay_min: Math.round(MIN_STARTUP_DELAY_MS / 60000), max_delay_min: Math.round(MAX_STARTUP_DELAY_MS / 60000), dry_run: dryRun, max_age_days: maxAgeDays })
  log('cleanup: sources', { tabs: sources.tabsFiles.length, chains: sources.chainsFiles.length, labels: sources.labelsFiles.length })
}
