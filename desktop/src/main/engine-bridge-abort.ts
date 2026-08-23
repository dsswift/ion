import type { EngineBridge } from "./engine-bridge";
import type { AbortScope } from "../shared/types-engine";
import { log as _log, warn as _warn } from "./logger";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("EngineBridge", msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn("EngineBridge", msg, fields);
}

export function nextSessionGeneration(bridge: EngineBridge): number {
  return ++bridge.sessionGeneration;
}

export function retirePendingAbort(bridge: EngineBridge, key: string): void {
  bridge.pendingAborts.delete(key);
  bridge.pendingAbortScopes.delete(key);
}

export function sendAbort(
  bridge: EngineBridge,
  key: string,
  scope: AbortScope = "all",
): void {
  const alive = !!(bridge.conn && !bridge.conn.destroyed);
  log("send_abort", {
    key,
    abort_scope: scope,
    connected: bridge.connected,
    alive,
  });
  if (!alive) {
    const sessionGeneration =
      bridge.activeSessions.get(key)?.generation ??
      bridge._reRegisterGeneration;
    bridge.pendingAborts.set(key, sessionGeneration);
    bridge.pendingAbortScopes.set(key, scope);
    warn("send_abort: socket dead, deferring abort to reconnect", {
      key,
      pending: bridge.pendingAborts.size,
      session_generation: sessionGeneration,
      abort_scope: scope,
    });
    bridge._scheduleReconnect();
    return;
  }
  const message =
    scope === "all"
      ? { cmd: "abort", key }
      : { cmd: "abort", key, abortScope: scope };
  if (bridge._send(message)) {
    retirePendingAbort(bridge, key);
    return;
  }
  const sessionGeneration =
    bridge.activeSessions.get(key)?.generation ?? bridge._reRegisterGeneration;
  bridge.pendingAborts.set(key, sessionGeneration);
  bridge.pendingAbortScopes.set(key, scope);
  warn("send_abort: write failed, deferring abort to reconnect", {
    key,
    pending: bridge.pendingAborts.size,
    session_generation: sessionGeneration,
    abort_scope: scope,
  });
  bridge.conn?.destroy();
  bridge._scheduleReconnect();
}

export function flushPendingAborts(bridge: EngineBridge): void {
  if (bridge.pendingAborts.size === 0) return;
  const generation = bridge._reRegisterGeneration;
  log("flush_pending_aborts", { count: bridge.pendingAborts.size, generation });
  for (const [key, requestedGeneration] of bridge.pendingAborts) {
    const activeGeneration = bridge.activeSessions.get(key)?.generation;
    if (
      activeGeneration !== undefined &&
      activeGeneration !== requestedGeneration
    ) {
      retirePendingAbort(bridge, key);
      continue;
    }
    if (activeGeneration === undefined && requestedGeneration >= generation)
      continue;
    const scope = bridge.pendingAbortScopes.get(key) ?? "all";
    const abortSent = bridge._send(
      scope === "all"
        ? { cmd: "abort", key }
        : { cmd: "abort", key, abortScope: scope },
    );
    if (!abortSent) {
      warn("flush_pending_aborts: retaining undelivered abort", {
        key,
        requested_generation: requestedGeneration,
        generation,
        abort_scope: scope,
      });
      continue;
    }
    retirePendingAbort(bridge, key);
    bridge.activeSessions.delete(key);
    bridge.emit("abort-delivered", key);
  }
}

export function sendAbortDispatch(
  bridge: EngineBridge,
  key: string,
  dispatchId: string,
): void {
  log("send_abort_dispatch", {
    key,
    dispatch_id: dispatchId,
    connected: bridge.connected,
  });
  bridge._send({ cmd: "abort_dispatch", key, dispatchId });
}
