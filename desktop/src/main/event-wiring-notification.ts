import type { NormalizedEvent } from "../shared/types";
import { tabIdFromKey } from "../shared/session-key";
import { state } from "./state";
import { log as _log } from "./logger";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

export function handleNotificationOrDispatchEvent(
  key: string,
  event: any,
  broadcastNormalized: (tabId: string, event: NormalizedEvent) => void,
): boolean {
  if (event.type === "engine_notification") {
    log("engine_notification", {
      title: event.notifyTitle,
      kind: event.notifyKind,
    });
    broadcastNormalized(tabIdFromKey(key), {
      type: "engine_notification",
      notificationTitle: event.notifyTitle,
      notificationBody: event.notifyBody,
      notificationLevel: event.notifyKind,
    });
    if (event.push && state.remoteTransport) {
      const tabId = tabIdFromKey(key);
      const instanceId = key.split(":")[1] || null;
      state.remoteTransport.send(
        {
          type: "desktop_notification",
          tabId,
          instanceId,
          notifyTitle: event.notifyTitle,
          notifyBody: event.notifyBody,
          notifyKind: event.notifyKind,
          notifyResourceId: event.notifyResourceId,
          push: true,
          pushTitle: event.pushTitle,
          pushBody: event.pushBody,
        },
        true,
        {
          title: event.pushTitle || event.notifyTitle,
          body: event.pushBody || event.notifyBody,
          tabId,
        },
      );
      log("engine_notification: forwarded push to remote", {
        tab_id: tabId,
        title: event.pushTitle || event.notifyTitle,
      });
    }
    return true;
  }
  if (event.type !== "engine_dispatch_activity") return false;
  const tabId = tabIdFromKey(key);
  log("dispatch_activity", {
    key,
    agent_id: event.dispatchAgentId,
    conv_id: event.dispatchConversationId,
    kind: event.dispatchActivityKind,
    seq: event.dispatchSeq,
    tool_id: event.toolId ?? "",
  });
  broadcastNormalized(tabId, {
    type: "dispatch_activity",
    dispatchAgentId: event.dispatchAgentId,
    dispatchConversationId: event.dispatchConversationId,
    dispatchActivityKind: event.dispatchActivityKind,
    dispatchSeq: event.dispatchSeq,
    toolName: event.toolName,
    toolId: event.toolId,
    dispatchTextDelta: event.dispatchTextDelta,
    dispatchToolIsError: event.dispatchToolIsError,
    dispatchActivityTs: event.dispatchActivityTs,
  });
  return true;
}
