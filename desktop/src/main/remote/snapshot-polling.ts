import { createHash } from 'crypto'
import { state, modelCache, engineBridge } from '../state'
import { readSettings } from '../settings-store'
import { getRemoteTabStates } from './snapshot'
import { reconcileGitWatchedDirectories } from './git-watcher-bridge'
import { log as _log, debug as _debug, error as _error } from '../logger'
import type { RemoteTabState } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void { _log('snapshot-polling', msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug('snapshot-polling', msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error('snapshot-polling', msg, fields) }

/**
 * Per-DEVICE snapshot hash (B7). The former module-level single hash was one
 * value shared by every paired device: a forced sync to device A updated it,
 * and the next broadcast poll tick then suppressed the send to device B even
 * though B had never received that snapshot. Keyed by deviceId so each device's
 * "last snapshot it received" is tracked independently. Entries for devices no
 * longer in the connected set are swept each poll tick (a stale entry is
 * harmless — the poll only iterates currently connected devices — but the
 * sweep bounds growth across long-lived desktop sessions).
 */
const lastSnapshotHashByDevice = new Map<string, string>()

/**
 * Per-tab cache of the last volatile-field values announced to clients via
 * the poll tick's desktop_tab_meta delta (B6-1). Seeded on first sight of a
 * tab (the initial values ride the full snapshot); a subsequent tick emits a
 * tab_meta delta only for tabs whose volatile values changed. Cleared in
 * stopTabSnapshotPolling / resetSnapshotHash, and swept for closed tabs each
 * tick.
 */
interface VolatileTabFields {
  convFingerprint?: string
  lastActivityAt?: number
  lastMessage?: string | null
  messageCount?: number
}
const lastEmittedVolatileByTab = new Map<string, VolatileTabFields>()

/**
 * Per-tab fields excluded from the change-detection hash. Two classes (RC-7):
 *
 *   1. Live cost/token accrual (runCostUsd, tokens, …) — ticks continuously
 *      during an active run. The per-instance cost delta already rides
 *      desktop_tab_meta (event-wiring.ts), so the hash must not track it.
 *   2. Per-delta conversation churn (convFingerprint, lastActivityAt,
 *      lastMessage, messageCount) — mutates on EVERY streamed delta. Hashing
 *      these forced the full multi-tab snapshot to re-serialize / compress /
 *      encrypt / ship every 5 s poll tick for the whole duration of any
 *      active run — redundant with the live delta stream the client is
 *      already receiving. Fresh values for this class ride the poll tick's
 *      own desktop_tab_meta delta (computeVolatileTabMetaDeltas below) so
 *      iOS heal logic still sees the current convFingerprint without a full
 *      snapshot reship.
 *
 * All excluded fields still PROJECT into the payload — whenever a structural
 * change (new/closed tab, status, queue, instances, …) ships the snapshot,
 * the current values ride along. The hash tracks structure only.
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
  'convFingerprint',
  'lastActivityAt',
  'lastMessage',
  'messageCount',
])

/**
 * Top-level snapshot fields excluded from the change-detection hash. The
 * remote-display override (customName / customIcon / remoteDisplayUpdatedAt)
 * is added by sendSync (tabs-sync.ts) on top of the shared buildSnapshotEvent
 * base but is NOT built by the poll tick (reading it every 5 s would spam the
 * display_read log for a value that only changes on an explicit set, which
 * already broadcasts desktop_remote_display). Excluding it keeps the hash of
 * a sendSync-built event identical to the hash of the next poll-built event,
 * so a forced sync correctly suppresses the immediately following poll send.
 */
const HASH_EXCLUDED_TOP_FIELDS = new Set([
  'customName',
  'customIcon',
  'remoteDisplayUpdatedAt',
])

/**
 * Build the value hashed for change detection: the snapshot event with the
 * high-frequency per-tab fields (cost/token accrual + per-delta conversation
 * churn) stripped from every tab, and the sendSync-only remote-display fields
 * stripped from the top level. Structural fields (id, status, queues,
 * instances, …) are preserved, so a real change still re-ships; a volatile
 * tick does not. Pure — returns a new object and never mutates the event
 * that will actually be sent.
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
  const top: Record<string, unknown> = {}
  for (const k of Object.keys(event)) {
    if (!HASH_EXCLUDED_TOP_FIELDS.has(k)) top[k] = event[k]
  }
  return { ...top, tabs: strippedTabs }
}

/**
 * Pure helper: compute a SHA-256 hex digest of the JSON-serialized
 * snapshot event object.  Exported for unit testability.
 *
 * Hashes the volatile-stripped projection (hashInputForSnapshot) so a live
 * cost/fingerprint tick does not force a full-snapshot resend every poll;
 * structural changes still do.
 */
export function hashSnapshot(event: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(hashInputForSnapshot(event))).digest('hex')
}

/**
 * Reset all cached snapshot-polling state: the per-device hash map and the
 * per-tab volatile tab_meta cache. Exported for testability and for the
 * transport teardown path.
 */
export function resetSnapshotHash(): void {
  lastSnapshotHashByDevice.clear()
  lastEmittedVolatileByTab.clear()
}

/**
 * Record that `event` (a full desktop_snapshot) was just sent to `deviceIds`,
 * updating each device's hash entry so the next poll tick does not re-send an
 * unchanged snapshot to a device that already received it. Called by sendSync
 * (tabs-sync.ts) after a forced sync — the force-semantics replacement for the
 * retired forceSyncSnapshot. Only the listed devices are updated (B7): a
 * forced sync to device A must not suppress the next poll send to device B.
 */
export function noteSnapshotSentToDevices(event: Record<string, unknown>, deviceIds: string[]): void {
  if (deviceIds.length === 0) return
  const hash = hashSnapshot(event)
  for (const id of deviceIds) {
    lastSnapshotHashByDevice.set(id, hash)
  }
  log('snapshot_polling: hash noted for devices', { hash: hash.slice(0, 12), device_count: deviceIds.length })
}

/**
 * Build the canonical desktop_snapshot event from the current renderer state
 * and settings. Shared by the poll tick (pollSnapshotOnce) and the explicit
 * sync path (sendSync in tabs-sync.ts) so both build the IDENTICAL base shape
 * — a prerequisite for the per-device hash update after a forced sync to
 * actually match the next poll tick's hash. sendSync layers its extra
 * remote-display fields on top; those are hash-excluded (see
 * HASH_EXCLUDED_TOP_FIELDS) so the layering cannot desynchronize the gate.
 */
export async function buildSnapshotEvent(): Promise<{ event: Record<string, unknown>; tabs: RemoteTabState[] }> {
  const { tabs, resourceManifest } = await getRemoteTabStates()
  const settings = readSettings()
  const recentDirectories: string[] = Array.isArray(settings.recentBaseDirectories) ? settings.recentBaseDirectories : []
  const tabGroupMode = settings.tabGroupMode || 'off'
  const tabGroups = Array.isArray(settings.tabGroups) ? settings.tabGroups.map((g: any) => ({ id: g.id, label: g.label, isDefault: g.isDefault, order: g.order })) : []
  const event: Record<string, unknown> = {
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
  return { event, tabs }
}

/**
 * Threshold (in milliseconds) for the stale-key detection. Exported
 * so the test in `__tests__/snapshot-polling-stale-sweep.test.ts` can
 * assert the value without re-declaring it.
 */
export const STALE_STATUS_THRESHOLD_MS = 60_000

export function startTabSnapshotPolling(): void {
  stopTabSnapshotPolling()
  // The tick body is a named async function so it stays awaitable (tests drive
  // it directly) while the interval callback stays synchronous — setInterval
  // must not be handed an async function (no-misused-promises).
  const tick = async (): Promise<void> => {
    if (!state.remoteTransport || state.remoteTransport.state === 'disconnected') return
    try {
      await pollSnapshotOnce()
    } catch (err) {
      // A failed tick is unexpected and must be visible in the logs — the
      // previous silent catch here masked a fully broken tick.
      error('snapshot_polling: poll tick failed', { error: (err as Error).message })
    }
  }
  state.tabSnapshotInterval = setInterval(() => { void tick() }, 5_000)
}

export function stopTabSnapshotPolling(): void {
  if (state.tabSnapshotInterval) {
    clearInterval(state.tabSnapshotInterval)
    state.tabSnapshotInterval = null
  }
  resetSnapshotHash()
}

/**
 * Pure helper (exported for unit tests): given the current tabs and the
 * per-tab cache of last-emitted volatile values, return the desktop_tab_meta
 * delta events to emit this tick — one per tab whose hash-excluded volatile
 * fields (convFingerprint / lastActivityAt / lastMessage / messageCount)
 * changed since the last tick — and mutate the cache to the current values.
 *
 * Semantics:
 *   - A tab seen for the FIRST time seeds the cache without emitting: its
 *     current values are riding the full snapshot that the new-tab structural
 *     change ships on this same tick (or already shipped on tab_created).
 *   - No changes → no emission (pinned by test).
 *   - Cost fields are NOT included: the engine_status cost delta path in
 *     event-wiring.ts already emits tab_meta for cost, deduped by
 *     lastForwardedTabMeta (state.ts). Emitting cost here too would
 *     double-send.
 *   - Cache entries for tabs no longer present are swept (closed tabs).
 */
export function computeVolatileTabMetaDeltas(
  tabs: RemoteTabState[],
  cache: Map<string, VolatileTabFields> = lastEmittedVolatileByTab,
): Array<Record<string, unknown>> {
  const deltas: Array<Record<string, unknown>> = []
  const liveIds = new Set<string>()
  for (const t of tabs) {
    liveIds.add(t.id)
    const current: VolatileTabFields = {
      convFingerprint: t.convFingerprint,
      lastActivityAt: t.lastActivityAt,
      lastMessage: t.lastMessage,
      messageCount: t.messageCount,
    }
    const prev = cache.get(t.id)
    if (!prev) {
      // First sight: the full snapshot (new-tab structural change) carries
      // the initial values; seed silently.
      cache.set(t.id, current)
      continue
    }
    const delta: Record<string, unknown> = { type: 'desktop_tab_meta', tabId: t.id }
    let changed = false
    if (current.convFingerprint !== prev.convFingerprint) {
      delta.convFingerprint = current.convFingerprint
      changed = true
    }
    if (current.lastActivityAt !== prev.lastActivityAt) {
      delta.lastActivityAt = current.lastActivityAt
      changed = true
    }
    if (current.lastMessage !== prev.lastMessage) {
      delta.lastMessage = current.lastMessage
      changed = true
    }
    if (current.messageCount !== prev.messageCount) {
      delta.messageCount = current.messageCount
      changed = true
    }
    if (changed) {
      cache.set(t.id, current)
      deltas.push(delta)
    }
  }
  // Sweep closed tabs so the cache cannot grow unbounded.
  for (const id of cache.keys()) {
    if (!liveIds.has(id)) cache.delete(id)
  }
  return deltas
}

/**
 * Internal poll tick: build the snapshot event once, hash it once, then
 * compare per connected paired device (B7) and send individually to each
 * device whose entry differs. Devices share one build/compress candidate;
 * only delivery is per-device. Exported for the change-detection tests,
 * which drive the tick directly.
 *
 * After the hash comparison, emit a lightweight desktop_tab_meta delta for
 * every tab whose hash-excluded volatile fields changed since the last tick
 * (B6-1) — broadcast, since every device needs the fresh convFingerprint for
 * its heal logic regardless of its snapshot hash state.
 */
export async function pollSnapshotOnce(): Promise<void> {
  const { event: snapshotEvent, tabs } = await buildSnapshotEvent()
  const hash = hashSnapshot(snapshotEvent)
  const transport = state.remoteTransport
  if (transport) {
    const deviceIds = transport.getConnectedDeviceIds()
    // Sweep hash entries for devices no longer connected/paired so the map
    // cannot grow unbounded across pair/unpair cycles. A re-connecting device
    // simply gets a fresh full snapshot on its first tick — correct behavior.
    const liveDevices = new Set(deviceIds)
    for (const id of lastSnapshotHashByDevice.keys()) {
      if (!liveDevices.has(id)) lastSnapshotHashByDevice.delete(id)
    }
    const staleDevices = deviceIds.filter((id) => lastSnapshotHashByDevice.get(id) !== hash)
    if (staleDevices.length === 0) {
      debug('snapshot unchanged for all devices, skipping send')
    } else {
      for (const deviceId of staleDevices) {
        lastSnapshotHashByDevice.set(deviceId, hash)
        transport.sendToDevice(deviceId, snapshotEvent as any)
      }
      log('snapshot_polling: hash changed', { hash: hash.slice(0, 12), device_count: staleDevices.length, tab_count: tabs.length })
    }
    // Volatile tab_meta deltas (B6-1): fresh convFingerprint / activity /
    // preview / count for tabs that changed since last tick, without a full
    // snapshot reship. Broadcast — all devices need the heal signal.
    const deltas = computeVolatileTabMetaDeltas(tabs)
    for (const delta of deltas) {
      transport.send(delta as any)
    }
    if (deltas.length > 0) {
      debug('snapshot_polling: volatile tab_meta deltas emitted', { count: deltas.length })
    }
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
