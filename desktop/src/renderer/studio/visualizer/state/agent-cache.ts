/**
 * The Studio renderer's live per-tab agent-state cache.
 *
 * Backfill comes from `studio:get-state` (main-process cache) on open and with
 * every `studio:active-tab` push; live `ion:normalized-event` deliveries land on
 * top. Replace-on-snapshot for `agent_state`, append for dispatch/permission
 * events — mirroring the engine's snapshot contract.
 *
 * A plain observable module, not Zustand: the canvas engine reads it
 * imperatively at 30Hz; only the toolbar needs a React subscription.
 */
import type {
  AgentStateUpdate,
  NormalizedEvent,
} from "../../../../shared/types";
import type { StudioTabState } from "../../../../shared/types-studio";
import type { BackgroundWorkItem } from "../../../../shared/types-events";
import { StudioStats } from "./stats";
import { StudioRecorder } from "./recorder";
import { tabIdFromKey } from "../../../../shared/session-key";
import { rInfo, rTrace } from "../../../rendererLogger";

export interface StudioActiveState {
  tabId: string;
  profileId: string | null;
  agents: AgentStateUpdate[];
  events: NormalizedEvent[];
  statusFields: StudioTabState["statusFields"];
  backgroundWork: BackgroundWorkItem[];
}

export interface AgentCacheListener {
  /** Active tab changed (or first hydration): rebuild the scene. */
  onRetarget(state: StudioActiveState): void;
  /** New agent-state snapshot for the active tab. */
  onSnapshot(agents: AgentStateUpdate[]): void;
  /** New dispatch/permission/status events for the active tab. */
  onEvents(events: NormalizedEvent[]): void;
}

const EVENT_RING_CAP = 200;

interface TabEntry {
  agents: AgentStateUpdate[];
  events: NormalizedEvent[];
  statusFields: StudioTabState["statusFields"];
  backgroundWork: BackgroundWorkItem[];
}

export class AgentCache {
  private tabs = new Map<string, TabEntry>();
  private activeTabId: string | null = null;
  private activeProfileId: string | null = null;
  private listener: AgentCacheListener | null = null;
  private disposers: Array<() => void> = [];
  /** Last logged status signature per tab (INFO-level status-change trace). */
  private lastStatusSig = new Map<string, string>();

  start(listener: AgentCacheListener): void {
    this.listener = listener;
    this.disposers.push(
      window.ion.onStudioActiveTab((tabId, snapshot, profileId) => {
        this.adopt(tabId, snapshot, profileId);
      }),
    );
    this.disposers.push(
      window.ion.onEvent((rawTabId, event) => {
        this.ingest(rawTabId, event);
      }),
    );
    // Initial hydration: whatever tab is active right now (view readiness —
    // the office must be correct on first paint, not after the first switch).
    window.ion
      .studioGetState()
      .then((result) => {
        if (result?.activeTabId && result.state) {
          this.adopt(result.activeTabId, result.state, result.activeProfileId);
        }
      })
      .catch(() => {
        // No active tab yet — the first studio:active-tab push hydrates us.
      });
  }

  stop(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.listener = null;
  }

  getActive(): StudioActiveState | null {
    if (!this.activeTabId) return null;
    const entry = this.tabs.get(this.activeTabId);
    if (!entry) return null;
    return {
      tabId: this.activeTabId,
      profileId: this.activeProfileId,
      agents: entry.agents,
      events: entry.events,
      statusFields: entry.statusFields,
      backgroundWork: entry.backgroundWork,
    };
  }

  private adopt(
    tabId: string,
    snapshot: StudioTabState,
    profileId: string | null,
  ): void {
    const changed = tabId !== this.activeTabId;
    this.activeTabId = tabId;
    this.activeProfileId = profileId;
    // The main-process snapshot is authoritative backfill: replace.
    this.tabs.set(tabId, {
      agents: snapshot.agents,
      events: [...snapshot.events],
      statusFields: snapshot.statusFields,
      backgroundWork: [
        ...((
          snapshot as StudioTabState & { backgroundWork?: BackgroundWorkItem[] }
        ).backgroundWork ?? []),
      ],
    });
    // Replay the ring through the stats accumulator (dispatchId-deduped).
    const stats = this.statsFor(tabId);
    for (const e of snapshot.events) stats.ingest(e, Date.now());
    if (changed) {
      // Retarget invalidates the replay ring (documented limitation: replay
      // covers the current tab's watch session).
      this.recorder.clear();
      rInfo("studio", "retarget", {
        tab_id: tabId,
        agent_count: snapshot.agents.length,
      });
      const active = this.getActive();
      if (active) this.listener?.onRetarget(active);
    } else {
      // Same tab re-pushed (fresh backfill): treat as a snapshot update.
      this.listener?.onSnapshot(snapshot.agents);
    }
  }

  /** Per-tab telemetry accumulators (odometers, dashboards, export). */
  private stats = new Map<string, StudioStats>();

  /** Session-replay ring for the ACTIVE tab only (cleared on retarget). */
  readonly recorder = new StudioRecorder();

  statsFor(tabId: string): StudioStats {
    let s = this.stats.get(tabId);
    if (!s) {
      s = new StudioStats();
      this.stats.set(tabId, s);
    }
    return s;
  }

  private ingest(rawTabId: string, event: NormalizedEvent): void {
    const tabId = tabIdFromKey(rawTabId);
    let entry = this.tabs.get(tabId);
    if (!entry) {
      entry = {
        agents: [],
        events: [],
        statusFields: null,
        backgroundWork: [],
      };
      this.tabs.set(tabId, entry);
    }
    // Telemetry accumulation (deduped by dispatchId inside StudioStats, so the
    // adopt() backfill replay below never double-counts).
    this.statsFor(tabId).ingest(event, Date.now());
    const isActive = tabId === this.activeTabId;
    // Replay recording: active tab only (per-tab recorders would multiply
    // memory), snapshots sig-deduped inside the recorder.
    if (isActive) {
      if (event.type === "agent_state")
        this.recorder.recordSnapshot(event.agents, Date.now());
      else if (event.type !== "dispatch_activity")
        this.recorder.recordEvent(event, Date.now());
    }
    switch (event.type) {
      case "agent_state": {
        entry.agents = event.agents;
        // Log when the STATUS SET changes (not every heartbeat re-emission)
        // so agent activity is reconstructable from desktop.jsonl.
        const sig = event.agents
          .map((a) => `${a.name}:${a.status}`)
          .sort()
          .join(",");
        if (this.lastStatusSig.get(tabId) !== sig) {
          this.lastStatusSig.set(tabId, sig);
          rInfo("studio", "agent statuses changed", {
            tab_id: tabId,
            statuses: sig,
          });
        } else {
          rTrace("studio", "agent snapshot heartbeat", {
            tab_id: tabId,
            count: event.agents.length,
          });
        }
        if (isActive) this.listener?.onSnapshot(event.agents);
        return;
      }
      case "status":
        entry.statusFields = event.fields;
        if (isActive) this.listener?.onEvents([event]);
        return;
      case "dispatch_activity":
        // Transient flavor: forwarded live, never ring-cached.
        if (isActive) this.listener?.onEvents([event]);
        return;
      case "dispatch_start":
      case "dispatch_end":
      case "permission_request":
        entry.events.push(event);
        if (entry.events.length > EVENT_RING_CAP) {
          entry.events.splice(0, entry.events.length - EVENT_RING_CAP);
        }
        if (isActive) this.listener?.onEvents([event]);
        return;
      case "background_task_complete": {
        const item: BackgroundWorkItem = {
          id: event.taskId,
          taskId: event.taskId,
          status:
            event.status === "error" || event.exitCode !== 0
              ? "failed"
              : "completed",
          command: event.command,
          exitCode: event.exitCode,
          elapsedMs: event.elapsedMs,
          tail: event.tail,
          ts: Date.now(),
        };
        const index = entry.backgroundWork.findIndex(
          (work) => work.taskId === item.taskId,
        );
        if (index >= 0) entry.backgroundWork[index] = item;
        else entry.backgroundWork.push(item);
        if (isActive) this.listener?.onEvents([event]);
        return;
      }
    }
  }
}
