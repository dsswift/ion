import { createHash } from 'crypto'
import { state, modelCache, engineBridge } from '../state'
import { readSettings } from '../settings-store'
import { getRemoteTabStates } from './snapshot'
import { reconcileGitWatchedDirectories } from './git-watcher-bridge'
import { log as _log, debug as _debug, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('snapshot-polling', msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug('snapshot-polling', msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error('snapshot-polling', msg, fields) }

let lastSnapshotHash: string | null = null

/**
 * Per-tab fields excluded from the change-detection hash. These tick
 * continuously during an active run (live cost/token accrual), so including
 * them made the snapshot hash change on EVERY 5s poll while any tab ran, forcing
 * a full multi-tab snapshot to re-serialize / compress / encrypt / ship each
 * tick. The snapshot does not need to carry live cost for freshness — the
 * per-instance cost delta already rides desktop_tab_meta (event-wiring.ts). We
 * still PROJECT these fields in the payload (iOS reads them from the snapshot on
 * a structural change); we just do not let them alone trigger a full resend.
 * The full snapshot re-ships on any STRUCTURAL change (a new/closed tab, status,
 * fingerprint, queue, etc.), which is what the hash should track. (RC-7)
 */
const HASH_EXCLUDED_TAB_FIELDS = new Set([
  'runCostUsd',
  'totalCostUsd',
  'conversationCostUsd',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'contextTokens',
])

/**
 * Build the value hashed for change detection: the snapshot event with the
 * high-frequency per-tab cost/token fields stripped from every tab. Structural
 * fields (id, status, fingerprint, queues, instances, …) are preserved, so a
 * real change still re-ships; a cost-only tick does not. Pure — returns a new
 * object and never mutates the event that will actually be sent.
 */
export function hashInputForSnapshot(event: Record<string, unknown>): Record<string, unknown> {
  const tabs = Array.isArray(event.tabs) ? event.tabs : []
  const strippedTabs = tabs.map((t: any) => {
    if (!t || typeof t !== 'object') return t
    const copy: Record<string, unknown> = {}
    for (const k of Object.keys(t)) {
      if (!HASH_EXCLUDED_TAB_FIELDS.has(k)) copy[k] = t[k]
    }
    return copy
  })
  return { ...event, tabs: strippedTabs }
}

/**
 * Pure helper: compute a SHA-256 hex digest of the JSON-serialized
 * snapshot event object.  Exported for unit testability.
 *
 * Hashes the cost-stripped projection (hashInputForSnapshot) so a live cost tick
 * does not force a full-snapshot resend every poll; structural changes still do.
 */
export function hashSnapshot(event: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(hashInputForSnapshot(event))).digest('hex')
}

/**
 * Reset the cached snapshot hash.  Exported for testability.
 */
export function resetSnapshotHash(): void {
  lastSnapshotHash = null
}

/**
 * Threshold (in milliseconds) for the stale-key detection. Exported
 * so the test in `__tests__/snapshot-polling-stale-sweep.test.ts` can
 * assert the value without re-declaring it.
 */
export const STALE_STATUS_THRESHOLD_MS = 60_000

export function startTabSnapshotPolling(): void {
  stopTabSnapshotPolling()
  state.tabSnapshotInterval = setInterval(async () => {
    if (!state.remoteTransport || state.remoteTransport.state === 'disconnected') return
    try {
      await pollSnapshotOnce(false)
    } catch (err) {
      // A failed tick is unexpected and must be visible in the logs — the
      // previous silent catch here masked a fully broken tick.
      error('snapshot_polling: poll tick failed', { error: (err as Error).message })
    }
  }, 5_000)
}

export function stopTabSnapshotPolling(): void {
  if (state.tabSnapshotInterval) {
    clearInterval(state.tabSnapshotInterval)
    state.tabSnapshotInterval = null
  }
  lastSnapshotHash = null
}

/**
 * Force an immediate snapshot send to a single device, bypassing the SHA-256
 * hash gate and the 60 s stale sweep. Called by `handleSync` when iOS sends an
 * explicit sync/resync request so a missed-delta freeze self-heals on demand
 * regardless of whether the state has changed since the last poll tick.
 *
 * The module-level `lastSnapshotHash` is updated so the next regular poll tick
 * does not re-send an unchanged snapshot, avoiding a double send.
 *
 * @param send  Delivery function (broadcast or per-device send).
 */
export async function forceSyncSnapshot(send: (event: Record<string, unknown>) => void): Promise<void> {
  log('forceSyncSnapshot: bypassing hash gate for explicit sync request')
  try {
    const { tabs, resourceManifest } = await getRemoteTabStates()
    const settings = readSettings()
    const recentDirectories: string[] = Array.isArray(settings.recentBaseDirectories) ? settings.recentBaseDirectories : []
    const tabGroupMode = settings.tabGroupMode || 'off'
    const tabGroups = Array.isArray(settings.tabGroups) ? settings.tabGroups.map((g: any) => ({ id: g.id, label: g.label, isDefault: g.isDefault, order: g.order })) : []
    const snapshotEvent: Record<string, unknown> = {
      type: 'desktop_snapshot',
      tabs,
      recentDirectories,
      tabGroupMode,
      tabGroups,
      preferredModel: settings.preferredModel || undefined,
      engineDefaultModel: settings.engineDefaultModel || undefined,
      availableModels: modelCache.models.length > 0 ? modelCache.models : undefined,
      resources: Object.keys(resourceManifest).length > 0 ? resourceManifest : undefined,
    }
    // Update the hash so the next poll does not re-send the same snapshot.
    lastSnapshotHash = hashSnapshot(snapshotEvent)
    send(snapshotEvent)
    log('snapshot_polling: force sync sent', { hash: lastSnapshotHash.slice(0, 12), tab_count: tabs.length })
  } catch (err) {
    log('snapshot_polling: error building snapshot', { error: (err as Error).message })
    throw err
  }
}

/**
 * Internal poll tick: build the snapshot event and send if the hash changed
 * (or `force` is true). Extracted so both the interval and forceSyncSnapshot
 * share identical snapshot assembly logic.
 */
async function pollSnapshotOnce(force: boolean): Promise<void> {
  const { tabs, resourceManifest } = await getRemoteTabStates()
  const settings = readSettings()
  const recentDirectories: string[] = Array.isArray(settings.recentBaseDirectories) ? settings.recentBaseDirectories : []
  const tabGroupMode = settings.tabGroupMode || 'off'
  const tabGroups = Array.isArray(settings.tabGroups) ? settings.tabGroups.map((g: any) => ({ id: g.id, label: g.label, isDefault: g.isDefault, order: g.order })) : []
  const snapshotEvent: Record<string, unknown> = {
    type: 'desktop_snapshot',
    tabs,
    recentDirectories,
    tabGroupMode,
    tabGroups,
    preferredModel: settings.preferredModel || undefined,
    engineDefaultModel: settings.engineDefaultModel || undefined,
    availableModels: modelCache.models.length > 0 ? modelCache.models : undefined,
    resources: Object.keys(resourceManifest).length > 0 ? resourceManifest : undefined,
  }
  const hash = hashSnapshot(snapshotEvent)
  if (!force && hash === lastSnapshotHash) {
    debug('snapshot unchanged, skipping send')
  } else {
    lastSnapshotHash = hash
    state.remoteTransport?.send(snapshotEvent as any)
    log('snapshot_polling: hash changed', { hash: hash.slice(0, 12) })
  }
  // Reconcile git-watcher bridge with current tab directories
  // (independent of whether the snapshot was sent)
  const directories = new Set(tabs.map(t => t.workingDirectory).filter(Boolean))
  reconcileGitWatchedDirectories(directories)
  // Stale-status convergence sweep (independent of whether the
  // snapshot was sent). Iterates every engine session key the
  // bridge knows about (via activeSessions) and asks the engine to
  // re-emit engine_status for any key whose last-known emission is
  // older than STALE_STATUS_THRESHOLD_MS.
  sweepStaleEngineStatuses()
}

/**
 * Pure helper extracted for unit testability. Given the set of
 * engine-known keys and a per-key map of last-engine_status arrival
 * times, returns the keys that should be queried because they are
 * stale (no status seen for at least STALE_STATUS_THRESHOLD_MS) or
 * because no status has ever been seen (the value is undefined).
 *
 * Pure function: no side effects, no module imports. The caller
 * iterates the result and dispatches `query_session_status` for each.
 */
export function pickStaleKeysForQuery(
  knownKeys: Iterable<string>,
  lastEngineStatusAt: Map<string, number>,
  now: number,
  thresholdMs: number = STALE_STATUS_THRESHOLD_MS,
): string[] {
  const stale: string[] = []
  for (const key of knownKeys) {
    const last = lastEngineStatusAt.get(key)
    if (last === undefined || now - last >= thresholdMs) {
      stale.push(key)
    }
  }
  return stale
}

/**
 * For every engine session key the bridge knows about, issue a
 * `query_session_status` if no `engine_status` has been received within
 * STALE_STATUS_THRESHOLD_MS. Logs which keys were queried so investigations
 * can confirm convergence is firing.
 *
 * Exported (non-default) for the unit test in
 * `__tests__/snapshot-polling-stale-sweep.test.ts`.
 */
export function sweepStaleEngineStatuses(now: number = Date.now()): void {
  if (!engineBridge) return
  const queried = pickStaleKeysForQuery(
    engineBridge.activeSessions.keys(),
    engineBridge.lastEngineStatusAt,
    now,
  )
  for (const key of queried) {
    engineBridge.sendQuerySessionStatus(key)
  }
  if (queried.length > 0) {
    log('snapshot_polling: sweep stale engine statuses', { count: queried.length, keys: queried.slice(0, 5).join(',') })
  }
}
