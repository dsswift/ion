import { createHash } from 'crypto'
import { state, modelCache, engineBridge } from '../state'
import { readSettings } from '../settings-store'
import { getRemoteTabStates } from './snapshot'
import { reconcileGitWatchedDirectories } from './git-watcher-bridge'
import { log as _log } from '../logger'

function log(msg: string): void { _log('snapshot-polling', msg) }

let lastSnapshotHash: string | null = null

/**
 * Pure helper: compute a SHA-256 hex digest of the JSON-serialized
 * snapshot event object.  Exported for unit testability.
 */
export function hashSnapshot(event: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex')
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
      if (hash === lastSnapshotHash) {
        log('snapshot unchanged, skipping send')
      } else {
        lastSnapshotHash = hash
        state.remoteTransport?.send(snapshotEvent as any)
        log(`snapshot hash changed: ${hash.slice(0, 12)}…`)
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
    } catch {}
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
    log(`sweepStaleEngineStatuses: queried ${queried.length} stale key(s): ${queried.slice(0, 5).join(',')}${queried.length > 5 ? `,…(+${queried.length - 5} more)` : ''}`)
  }
}
