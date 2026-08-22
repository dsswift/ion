import type { EngineBridge } from "./engine-bridge";
import {
  performDispatchAbort,
  performUnifiedInterrupt,
} from "./engine-control-plane-interrupt";
import type { TabEntry } from "./engine-control-plane-events";
import type { AbortScope } from "../shared/types-engine";

interface ControlPlaneLog {
  (message: string, fields?: Record<string, unknown>): void;
}

/** Cancel an active request by its renderer request ID. */
export function cancelRequest(
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  requestId: string,
  log: ControlPlaneLog,
  warn: ControlPlaneLog,
): boolean {
  for (const [tabId, tab] of tabs) {
    if (tab.activeRequestId === requestId) {
      log("cancel: found tab, sending abort", {
        tab_id: tabId,
        request_id: requestId,
      });
      bridge.sendAbort(tabId);
      return true;
    }
  }
  warn("cancel: no tab found", { request_id: requestId });
  return false;
}

/** Stop a tab at the requested scope. */
export function cancelTabRun(
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  tabId: string,
  scope: AbortScope,
  log: ControlPlaneLog,
  warn: ControlPlaneLog,
): boolean {
  if (!tabs.has(tabId)) {
    warn("cancel_tab: not found", { tab_id: tabId, abort_scope: scope });
    return false;
  }
  log("cancel_tab: unified interrupt", { tab_id: tabId, abort_scope: scope });
  performUnifiedInterrupt(bridge, tabId, scope);
  return true;
}

/** Stop one background dispatch without touching its peers. */
export function abortTabDispatch(
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  tabId: string,
  dispatchId: string,
  warn: ControlPlaneLog,
): boolean {
  if (!tabs.has(tabId)) {
    warn("abort_dispatch: tab not found", {
      tab_id: tabId,
      dispatch_id: dispatchId,
    });
    return false;
  }
  performDispatchAbort(bridge, tabId, dispatchId);
  return true;
}
