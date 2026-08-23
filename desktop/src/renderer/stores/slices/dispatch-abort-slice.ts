import type { StoreSet, StoreGet, State } from "../session-store-types";
import { rInfo, rWarn } from "../../rendererLogger";

/**
 * dispatch-abort-slice — stopping ONE background dispatch.
 *
 * Separate from the tab-wide `interrupt` in send-slice.ts because it addresses
 * a different thing: `interrupt` stops a tab's run (and, at the 'all' scope,
 * everything hanging off it), while this stops a single dispatch and leaves the
 * orchestrator and every sibling dispatch running. It is the escape hatch for a
 * rogue agent that does not require abandoning the whole conversation tree.
 *
 * Its own file rather than an addition to send-slice.ts, which is already over
 * the size cap under an exception.
 */
export function createDispatchAbortSlice(
  _set: StoreSet,
  get: StoreGet,
): Partial<State> {
  return {
    /**
     * Stop one background dispatch by its dispatch ID.
     *
     * `dispatchId` is the collision-safe ID the engine mints per dispatch
     * instance and surfaces as `dispatchId` on each `engine_agent_state`
     * dispatch member — NOT the agent name, which several concurrent
     * dispatches can share.
     *
     * Fire-and-forget by design: the engine answers through the agent-state
     * snapshot (the dispatch flips to `cancelled`) and the updated
     * background-agent count, so there is no result to await here. A dispatch
     * that finished a moment before the click is a no-op on the engine side.
     */
    abortDispatch: (tabId, dispatchId) => {
      if (!dispatchId) {
        // Nothing addressable — a caller bug worth seeing rather than a silent
        // no-op that looks like a dead button.
        rWarn("dispatch.abort", "abortDispatch called with empty dispatchId", {
          tab_id: tabId.slice(0, 8),
        });
        return;
      }
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) {
        rWarn("dispatch.abort", "abortDispatch: unknown tab", {
          tab_id: tabId.slice(0, 8),
          dispatch_id: dispatchId,
        });
        return;
      }
      rInfo("dispatch.abort", "stopping dispatch", {
        tab_id: tabId.slice(0, 8),
        dispatch_id: dispatchId,
      });
      window.ion.engineAbortDispatch(tabId, dispatchId).catch((err) => {
        // A failed IPC means the Stop button silently did nothing.
        rWarn("dispatch.abort", "engineAbortDispatch IPC failed", {
          tab_id: tabId.slice(0, 8),
          dispatch_id: dispatchId,
          error: String(err),
        });
      });
    },

    /**
     * Stop every running dispatch instance represented by ONE agent row.
     * IDs are de-duplicated and addressed independently: agent names are not
     * identities, and name-based recall would stop an arbitrary instance when
     * several same-name dispatches run concurrently. Each ID recall cascades
     * through that dispatch's descendant chain; other rows and the
     * orchestrator remain alive.
     */
    abortDispatches: (tabId, dispatchIds) => {
      const uniqueIds = Array.from(new Set(dispatchIds.filter(Boolean)));
      if (uniqueIds.length === 0) {
        rWarn("dispatch.abort", "abortDispatches called with no dispatch ids", {
          tab_id: tabId.slice(0, 8),
        });
        return;
      }
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) {
        rWarn("dispatch.abort", "abortDispatches: unknown tab", {
          tab_id: tabId.slice(0, 8),
          count: uniqueIds.length,
        });
        return;
      }
      rInfo("dispatch.abort", "stopping all dispatches in agent row", {
        tab_id: tabId.slice(0, 8),
        count: uniqueIds.length,
        dispatch_ids: uniqueIds,
      });
      for (const dispatchId of uniqueIds) {
        window.ion.engineAbortDispatch(tabId, dispatchId).catch((err) => {
          rWarn(
            "dispatch.abort",
            "engineAbortDispatch IPC failed during row stop-all",
            {
              tab_id: tabId.slice(0, 8),
              dispatch_id: dispatchId,
              error: String(err),
            },
          );
        });
      }
    },
  };
}
