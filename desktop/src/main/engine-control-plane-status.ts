/**
 * The tab-status seam of `EngineControlPlane`: read projections over the tab
 * map, plus the two writers that publish status to consumers.
 *
 * Extracted from `engine-control-plane.ts` to keep it under the 600-line
 * TypeScript cap. The reads are pure over the tab map with no bridge I/O, and
 * the writers touch nothing but `tab.status` and the emit callback — so the
 * whole "what is this tab's status and who gets told" question lives in one
 * file, and the control plane's remaining bulk is lifecycle and dispatch. A
 * reader asking "how is health computed" or "why did no transition fire" should
 * not have to scroll past the prompt path to find out.
 */
import { log as _log } from "./logger";
import type { HealthReport, TabStatus } from "../shared/types";
import type { TabEntry } from "./engine-control-plane-events";

const TAG = "SessionPlane";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}

/**
 * Publishes a `tab-status-change` to the plane's consumers. Supplied by the
 * control plane so these writers stay free of EventEmitter coupling.
 */
export type StatusEmit = (
  tabId: string,
  newStatus: TabStatus,
  oldStatus: TabStatus,
) => void;

/**
 * Project every tracked tab into the health report shape.
 *
 * `alive` is derived rather than stored: a tab is alive unless it reached a
 * terminal status. `queueDepth` is always 0 because the engine owns queueing —
 * the desktop dispatches straight through and has no queue of its own to
 * report.
 */
export function buildHealthReport(tabs: Map<string, TabEntry>): HealthReport {
  const projected: HealthReport["tabs"] = [];
  for (const tab of tabs.values()) {
    projected.push({
      tabId: tab.tabId,
      status: tab.status,
      activeRequestId: tab.activeRequestId,
      conversationId: tab.conversationId,
      alive: tab.status !== "dead" && tab.status !== "failed",
      lastActivityAt: tab.lastActivityAt,
    });
  }
  return { tabs: projected, queueDepth: 0 };
}

/**
 * True when any tab is mid-flight. `connecting` and `starting` count for drain
 * safety even though only `running` renders as work: stopping an attaching
 * session would race the first status snapshot and its configured resources.
 */
export function anyTabRunning(tabs: Map<string, TabEntry>): boolean {
  for (const tab of tabs.values()) {
    if (tab.status === "running" || tab.status === "connecting" || tab.status === "starting") {
      return true;
    }
  }
  return false;
}

/**
 * Re-assert a tab's CURRENT status to consumers without a transition.
 *
 * `applyStatus` deliberately returns early when the status is unchanged: a
 * transition log line and a `tab-status-change` for `idle -> idle` would be
 * noise, and the plane is a state machine, not a ticker. But that early return
 * is also why a consumer can strand itself.
 *
 * Every client of the plane keeps its own optimistic copy of tab status and
 * writes 'connecting' locally before asking for a session (the renderer does it
 * in `send-slice`, `addEngineInstance`, and `createConversationTab`). That
 * optimistic value is cleared ONLY by an inbound `tab-status-change`. When the
 * plane's entry is already at the value it would transition to — a restored or
 * eager-started tab whose entry has rested at 'idle' since `createTab` — no
 * transition fires, no event is emitted, and the client's 'connecting' is never
 * answered. The tab renders an indefinite connecting indicator with a blocked
 * composer while the plane believes it is idle and available.
 *
 * A resync is not a transition, so it does not (and must not) mutate
 * `tab.status`. It only re-states the authoritative answer at the seam where a
 * client is known to be waiting for one: session establishment. Consumers
 * recognise it by `oldStatus === newStatus` and must treat it as convergence
 * with no run-lifecycle meaning.
 */
export function resyncStatus(
  tabs: Map<string, TabEntry>,
  tabId: string,
  reason: string,
  emit: StatusEmit,
): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  log("status_resync", { tab_id: tabId, status: tab.status, reason });
  emit(tabId, tab.status, tab.status);
}

/**
 * Transition a tab's status and tell consumers. A no-op when the status is
 * already the target — see `resyncStatus` above for why that early return
 * needs a companion rather than removal.
 */
export function applyStatus(
  tabs: Map<string, TabEntry>,
  tabId: string,
  newStatus: TabStatus,
  emit: StatusEmit,
): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const oldStatus = tab.status;
  if (oldStatus === newStatus) return;
  log("status_transition", { tab_id: tabId, from: oldStatus, to: newStatus });
  tab.status = newStatus;
  emit(tabId, newStatus, oldStatus);
}
