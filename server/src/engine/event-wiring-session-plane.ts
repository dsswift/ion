/**
 * Session-plane → owner store → mirrors.
 *
 * Split from event-wiring.ts at the file-size cap. Every signal the control
 * plane emits for a tab is applied to THIS process's session store first and
 * fanned out to the Studio mirrors second.
 */
import type { NormalizedEvent, EnrichedError } from "@ion/shared/types";
import { log as _log } from "../logger";
import { sessionPlane } from "../state";
import { broadcast } from "../broadcast";
import { useSessionStore } from "../store/sessionStore";
import { notifyStudioPermissionResolved } from "./studio-window-manager";
import { handleInterceptEvent } from "./event-wiring-intercept";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

/**
 * The server OWNS the session store (ADR-033), so every engine signal is
 * applied to that store here, before it is fanned out to the mirrors. When
 * the store lived in the owner renderer, `useEngineEvents` did this apply on
 * receipt and this file only broadcast; the extraction moved the store but
 * not the apply, and the owner's copy of every tab sat where the last
 * store action left it. The visible consequence: `submit()` set a tab to
 * 'connecting', the session plane went running→idle, the store never heard,
 * and the second prompt was refused as "connecting" for the rest of the
 * conversation. Applied first so a client that asks for a body right after
 * an event sees the state the event produced.
 */
export function applyToOwnerStore(fn: (store: ReturnType<typeof useSessionStore.getState>) => void, what: string, tabId: string): void {
  try {
    fn(useSessionStore.getState());
  } catch (err) {
    log("owner store apply failed", { what, tab_id: tabId, error: String(err) });
  }
}

export function wireSessionPlaneEvents(): void {
  sessionPlane.on("event", (tabId: string, event: NormalizedEvent) => {
    applyToOwnerStore((s) => s.handleNormalizedEvent(tabId, event), `event:${event.type}`, tabId);
    broadcast("ion:normalized-event", tabId, event);
  });

  sessionPlane.on(
    "tab-status-change",
    (tabId: string, newStatus: string, oldStatus: string) => {
      applyToOwnerStore((s) => s.handleStatusChange(tabId, newStatus, oldStatus), `status:${oldStatus}->${newStatus}`, tabId);
      broadcast("ion:tab-status-change", tabId, newStatus, oldStatus);
    },
  );

  sessionPlane.on("error", (tabId: string, error: EnrichedError) => {
    applyToOwnerStore((s) => s.handleError(tabId, error), "error", tabId);
    broadcast("ion:enriched-error", tabId, error);
  });

  // Cross-surface permission reconcile: the control plane emits this from
  // its respondToPermission choke point (any surface's answer). Routed to
  // the Studio window here rather than called from the control plane directly,
  // which would re-create the engine-control-plane → studio-window-manager →
  // state module cycle.
  sessionPlane.on(
    "permission-resolved",
    (tabId: string, questionId: string) => {
      notifyStudioPermissionResolved(tabId, questionId);
    },
  );

  // engine_intercept from CLI-tab sessions. EngineControlPlane bubbles
  // engine_intercept up via ctx.emit('engine_intercept', tabId, event)
  // rather than emitting it as a NormalizedEvent (it's not one). The
  // intercept handler does device-focus routing, optional abort/re-prompt,
  // and renderer broadcast.
  sessionPlane.on("engine_intercept", (tabId: string, event: any) => {
    handleInterceptEvent(tabId, event).catch((err: unknown) => {
      log("wire_intercept_handler_error", {
        tab_id: tabId,
        error: (err as Error).message,
      });
    });
  });
}

