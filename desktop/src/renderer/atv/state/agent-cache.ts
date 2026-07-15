/**
 * The ATV renderer's live per-tab agent-state cache.
 *
 * Backfill comes from `atv:get-state` (main-process cache) on open and with
 * every `atv:active-tab` push; live `ion:normalized-event` deliveries land on
 * top. Replace-on-snapshot for `agent_state`, append for dispatch/permission
 * events — mirroring the engine's snapshot contract.
 *
 * A plain observable module, not Zustand: the canvas engine reads it
 * imperatively at 30Hz; only the toolbar needs a React subscription.
 */
import type { AgentStateUpdate, NormalizedEvent } from '../../../shared/types'
import type { AtvTabState } from '../../../shared/types-atv'
import { AtvStats } from './stats'
import { AtvRecorder } from './recorder'
import { tabIdFromKey } from '../../../shared/session-key'
import { rInfo, rTrace } from '../../rendererLogger'

export interface AtvActiveState {
  tabId: string
  profileId: string | null
  agents: AgentStateUpdate[]
  events: NormalizedEvent[]
  statusFields: AtvTabState['statusFields']
}

export interface AgentCacheListener {
  /** Active tab changed (or first hydration): rebuild the scene. */
  onRetarget(state: AtvActiveState): void
  /** New agent-state snapshot for the active tab. */
  onSnapshot(agents: AgentStateUpdate[]): void
  /** New dispatch/permission/status events for the active tab. */
  onEvents(events: NormalizedEvent[]): void
}

const EVENT_RING_CAP = 200

interface TabEntry {
  agents: AgentStateUpdate[]
  events: NormalizedEvent[]
  statusFields: AtvTabState['statusFields']
}

export class AgentCache {
  private tabs = new Map<string, TabEntry>()
  private activeTabId: string | null = null
  private activeProfileId: string | null = null
  private listener: AgentCacheListener | null = null
  private disposers: Array<() => void> = []
  /** Last logged status signature per tab (INFO-level status-change trace). */
  private lastStatusSig = new Map<string, string>()

  start(listener: AgentCacheListener): void {
    this.listener = listener
    this.disposers.push(
      window.ion.onAtvActiveTab((tabId, snapshot, profileId) => {
        this.adopt(tabId, snapshot, profileId)
      }),
    )
    this.disposers.push(
      window.ion.onEvent((rawTabId, event) => {
        this.ingest(rawTabId, event)
      }),
    )
    // Initial hydration: whatever tab is active right now (view readiness —
    // the office must be correct on first paint, not after the first switch).
    window.ion
      .atvGetState()
      .then((result) => {
        if (result?.activeTabId && result.state) {
          this.adopt(result.activeTabId, result.state, result.activeProfileId)
        }
      })
      .catch(() => {
        // No active tab yet — the first atv:active-tab push hydrates us.
      })
  }

  stop(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.listener = null
  }

  getActive(): AtvActiveState | null {
    if (!this.activeTabId) return null
    const entry = this.tabs.get(this.activeTabId)
    if (!entry) return null
    return {
      tabId: this.activeTabId,
      profileId: this.activeProfileId,
      agents: entry.agents,
      events: entry.events,
      statusFields: entry.statusFields,
    }
  }

  private adopt(tabId: string, snapshot: AtvTabState, profileId: string | null): void {
    const changed = tabId !== this.activeTabId
    this.activeTabId = tabId
    this.activeProfileId = profileId
    // The main-process snapshot is authoritative backfill: replace.
    this.tabs.set(tabId, {
      agents: snapshot.agents,
      events: [...snapshot.events],
      statusFields: snapshot.statusFields,
    })
    // Replay the ring through the stats accumulator (dispatchId-deduped).
    const stats = this.statsFor(tabId)
    for (const e of snapshot.events) stats.ingest(e, Date.now())
    if (changed) {
      // Retarget invalidates the replay ring (documented limitation: replay
      // covers the current tab's watch session).
      this.recorder.clear()
      rInfo('atv', 'retarget', { tab_id: tabId, agent_count: snapshot.agents.length })
      const active = this.getActive()
      if (active) this.listener?.onRetarget(active)
    } else {
      // Same tab re-pushed (fresh backfill): treat as a snapshot update.
      this.listener?.onSnapshot(snapshot.agents)
    }
  }

  /** Per-tab telemetry accumulators (odometers, dashboards, export). */
  private stats = new Map<string, AtvStats>()

  /** Session-replay ring for the ACTIVE tab only (cleared on retarget). */
  readonly recorder = new AtvRecorder()

  statsFor(tabId: string): AtvStats {
    let s = this.stats.get(tabId)
    if (!s) {
      s = new AtvStats()
      this.stats.set(tabId, s)
    }
    return s
  }

  private ingest(rawTabId: string, event: NormalizedEvent): void {
    const tabId = tabIdFromKey(rawTabId)
    let entry = this.tabs.get(tabId)
    if (!entry) {
      entry = { agents: [], events: [], statusFields: null }
      this.tabs.set(tabId, entry)
    }
    // Telemetry accumulation (deduped by dispatchId inside AtvStats, so the
    // adopt() backfill replay below never double-counts).
    this.statsFor(tabId).ingest(event, Date.now())
    const isActive = tabId === this.activeTabId
    // Replay recording: active tab only (per-tab recorders would multiply
    // memory), snapshots sig-deduped inside the recorder.
    if (isActive) {
      if (event.type === 'agent_state') this.recorder.recordSnapshot(event.agents, Date.now())
      else if (event.type !== 'dispatch_activity') this.recorder.recordEvent(event, Date.now())
    }
    switch (event.type) {
      case 'agent_state': {
        entry.agents = event.agents
        // Log when the STATUS SET changes (not every heartbeat re-emission)
        // so agent activity is reconstructable from desktop.jsonl.
        const sig = event.agents.map((a) => `${a.name}:${a.status}`).sort().join(',')
        if (this.lastStatusSig.get(tabId) !== sig) {
          this.lastStatusSig.set(tabId, sig)
          rInfo('atv', 'agent statuses changed', { tab_id: tabId, statuses: sig })
        } else {
          rTrace('atv', 'agent snapshot heartbeat', { tab_id: tabId, count: event.agents.length })
        }
        if (isActive) this.listener?.onSnapshot(event.agents)
        return
      }
      case 'status':
        entry.statusFields = event.fields
        if (isActive) this.listener?.onEvents([event])
        return
      case 'dispatch_activity':
        // Transient flavor: forwarded live, never ring-cached.
        if (isActive) this.listener?.onEvents([event])
        return
      case 'dispatch_start':
      case 'dispatch_end':
      case 'permission_request':
        entry.events.push(event)
        if (entry.events.length > EVENT_RING_CAP) {
          entry.events.splice(0, entry.events.length - EVENT_RING_CAP)
        }
        if (isActive) this.listener?.onEvents([event])
        return
      default:
        return
    }
  }
}
