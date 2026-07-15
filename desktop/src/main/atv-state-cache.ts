/**
 * atv-state-cache — main-process per-tab cache backing the Agent Team
 * Visualizer window.
 *
 * The ATV window can open at any time, including long after a tab's agent
 * team started working. Events flow through broadcast() whether or not the
 * ATV window exists, so this cache taps that stream and keeps, per tab:
 *
 *   - the latest agent-state snapshot (replace-on-snapshot, mirroring the
 *     renderer's `agent_state` semantics in event-slice-extension-surface.ts)
 *   - a capped ring of raw dispatch/permission events (the ATV renderer
 *     replays these through its own telemetry logic; main never derives
 *     telemetry shapes, so there is exactly one derivation implementation)
 *   - the latest status-fields snapshot (replace-on-snapshot)
 *
 * The ATV renderer pulls this via `atv:get-state` on window open and on every
 * active-tab change, then applies live events on top. Cache updates run even
 * while the ATV window is closed — that IS the backfill.
 */
import type { NormalizedEvent } from '../shared/types'
import type { AgentStateUpdate, StatusFields } from '../shared/types-engine'
import { tabIdFromKey } from '../shared/session-key'
import { permissionClearingState } from '../shared/permission-clear'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('atv', msg, fields)
}

/**
 * Normalized-event types the ATV window consumes. Everything else on the
 * stream (text deltas, tool calls) is high-frequency noise for a second
 * webContents: each forwarded event pays structured-clone serialization, so
 * the fan-out in broadcast.ts filters to this set.
 */
export const ATV_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent_state',
  'status',
  'dispatch_start',
  'dispatch_end',
  'dispatch_activity',
  'permission_request',
])

/**
 * dispatch_activity text deltas are a firehose (per-token). Only tool
 * lifecycle events cross into the ATV path; text deltas are dropped here.
 */
export function atvWantsEvent(event: NormalizedEvent): boolean {
  if (!ATV_EVENT_TYPES.has(event.type)) return false
  if (event.type === 'dispatch_activity') {
    return event.dispatchActivityKind === 'tool_start' || event.dispatchActivityKind === 'tool_end'
  }
  return true
}

/** Raw events kept per tab. Old entries fall off the front. */
export const ATV_EVENT_RING_CAP = 200

export interface AtvTabState {
  agents: AgentStateUpdate[]
  /** Ring buffer of dispatch_start / dispatch_end / permission_request events. */
  events: NormalizedEvent[]
  statusFields: StatusFields | null
  /**
   * Outstanding permission requests, arrival-ordered — the authoritative
   * pending queue for closed-window backfill and marquee boot truth. Added
   * on permission_request; removed on answer (resolveAtvPermission, fired
   * from the respondToPermission choke point regardless of which surface
   * answered) or on any clearing status (shared predicate).
   */
  pendingPermissions: NormalizedEvent[]
}

const cache = new Map<string, AtvTabState>()

function entryFor(tabId: string): AtvTabState {
  let entry = cache.get(tabId)
  if (!entry) {
    entry = { agents: [], events: [], statusFields: null, pendingPermissions: [] }
    cache.set(tabId, entry)
  }
  return entry
}

/**
 * Feed one broadcast event into the cache. `rawTabId` is whatever key the
 * broadcast carried (bare tabId from the control plane, `tabId:instanceId`
 * from extension-hosted paths) — normalized here to the bare tabId so cached
 * state never splits between key shapes.
 */
export function updateAtvCache(rawTabId: string, event: NormalizedEvent): void {
  if (!atvWantsEvent(event)) return
  const tabId = tabIdFromKey(rawTabId)
  const entry = entryFor(tabId)

  switch (event.type) {
    case 'agent_state':
      // Complete snapshot: replace, never merge.
      entry.agents = event.agents
      break
    case 'status':
      entry.statusFields = event.fields
      // A clearing status means nothing can still be blocked on an answer.
      if (entry.pendingPermissions.length > 0 && permissionClearingState(String(event.fields?.state ?? ''))) {
        log('atv_cache: pending permissions cleared by status', {
          tab_id: tabId,
          state: String(event.fields?.state ?? ''),
          cleared: entry.pendingPermissions.length,
        })
        entry.pendingPermissions = []
      }
      break
    case 'permission_request':
      entry.pendingPermissions.push(event)
      entry.events.push(event)
      if (entry.events.length > ATV_EVENT_RING_CAP) {
        entry.events.splice(0, entry.events.length - ATV_EVENT_RING_CAP)
      }
      break
    case 'dispatch_activity':
      // Transient flavor — forwarded live but never ring-cached (replaying
      // stale tool activity on backfill would be noise).
      break
    default:
      entry.events.push(event)
      if (entry.events.length > ATV_EVENT_RING_CAP) {
        entry.events.splice(0, entry.events.length - ATV_EVENT_RING_CAP)
      }
      break
  }
}

/** Current cached state for a tab (empty state when nothing cached yet). */
export function getAtvState(rawTabId: string): AtvTabState {
  const tabId = tabIdFromKey(rawTabId)
  const entry = cache.get(tabId)
  if (!entry) {
    log('atv_cache: miss', { tab_id: tabId })
    return { agents: [], events: [], statusFields: null, pendingPermissions: [] }
  }
  log('atv_cache: hit', {
    tab_id: tabId,
    agent_count: entry.agents.length,
    event_count: entry.events.length,
  })
  return entry
}

/**
 * Remove an answered permission from the pending queue. Returns whether it
 * was present. Called from the respondToPermission choke point — the single
 * spot every surface's answer (overlay, iOS, ATV) funnels through.
 */
export function resolveAtvPermission(rawTabId: string, questionId: string): boolean {
  const tabId = tabIdFromKey(rawTabId)
  const entry = cache.get(tabId)
  if (!entry) return false
  const before = entry.pendingPermissions.length
  entry.pendingPermissions = entry.pendingPermissions.filter(
    (e) => (e as { questionId?: string }).questionId !== questionId,
  )
  const removed = entry.pendingPermissions.length < before
  if (removed) log('atv_cache: permission resolved', { tab_id: tabId, question_id: questionId })
  return removed
}

/** Per-tab live summary for the campus view (all cached tabs). */
export interface AtvTabSummary {
  tabId: string
  state: string
  working: number
  error: number
  total: number
  pendingPermissions: number
}

export function allAtvSummaries(): AtvTabSummary[] {
  const out: AtvTabSummary[] = []
  for (const [tabId, entry] of cache) {
    out.push({
      tabId,
      state: String(entry.statusFields?.state ?? ''),
      working: entry.agents.filter((a) => a.status === 'running').length,
      error: entry.agents.filter((a) => a.status === 'error').length,
      total: entry.agents.length,
      pendingPermissions: entry.pendingPermissions.length,
    })
  }
  return out
}

/** Drop a tab's cached state (tab closed). */
export function evictAtvTab(rawTabId: string): void {
  const tabId = tabIdFromKey(rawTabId)
  if (cache.delete(tabId)) {
    log('atv_cache: evicted', { tab_id: tabId })
  }
}

/** Test hook: reset the cache between test cases. */
export function clearAtvCache(): void {
  cache.clear()
}
