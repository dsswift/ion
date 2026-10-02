import type { EngineEvent } from "@ion/shared/types";
import type { EngineBridge } from "./engine-bridge";
import { applyToolDisplayNames } from "./event-wiring-tool-names";
import {
  buildSendCommandMessage,
  buildSendPromptLogLine,
  buildSendPromptMessage,
} from "./engine-bridge-prompts";
import type { SendPromptArgs } from "./engine-bridge-prompts";
import { startEngineCallSpan, traceFields } from "../tracing/prompt-span";
import {
  debug as _debug,
  error as _error,
  log as _log,
  trace as _trace,
  warn as _warn,
} from "../logger";

const TAG = "EngineBridge";

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug(TAG, msg, fields);
}
function trace(msg: string, fields?: Record<string, unknown>): void {
  _trace(TAG, msg, fields);
}
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error(TAG, msg, fields);
}

export async function sendPrompt(
  bridge: EngineBridge,
  key: string,
  text: string,
  opts: Omit<SendPromptArgs, "key" | "text">,
): Promise<{
  ok: boolean;
  error?: string;
  data?: { accepted?: boolean; alreadyAccepted?: boolean };
}> {
  const args: SendPromptArgs = { key, text, ...opts };
  // The engine's run joins the trace under this call span, not directly under
  // the caller's span, so the hop into the engine is a client->server pair.
  const call = startEngineCallSpan(args.traceparent, key);
  if (call) args.traceparent = call.traceparent;
  log(buildSendPromptLogLine(args), traceFields(args.traceparent));
  try {
    await bridge.connect();
    const result = await bridge._sendWithResult<{ accepted?: boolean; alreadyAccepted?: boolean }>(buildSendPromptMessage(args));
    call?.end({ accepted: result.ok }, result.ok ? undefined : `send_prompt refused: ${result.error ?? "no answer"}`);
    return result;
  } catch (err) {
    call?.end(undefined, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function drainBuffer(bridge: EngineBridge): void {
  if (bridge._drainScheduled) return;
  const batchSize = 10;
  let processed = 0;
  let newline: number;
  while (
    processed < batchSize &&
    (newline = bridge.buffer.indexOf("\n")) !== -1
  ) {
    const line = bridge.buffer.slice(0, newline);
    bridge.buffer = bridge.buffer.slice(newline + 1);
    if (line.trim()) {
      handleMessage(bridge, line);
      processed++;
    }
  }
  if (bridge.buffer.indexOf("\n") !== -1) {
    bridge._drainScheduled = true;
    setImmediate(() => {
      bridge._drainScheduled = false;
      drainBuffer(bridge);
    });
  }
}

export function handleMessage(bridge: EngineBridge, line: string): void {
  bridge.consecutiveTimeouts = 0;

  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    warn("unparseable_message", { preview: line.substring(0, 200) });
    return;
  }

  if (msg.cmd === "result" && msg.requestId) {
    debug("result", {
      request_id: msg.requestId,
      ok: msg.ok,
      error: msg.error ?? "none",
    });
    const callback = bridge.requestCallbacks.get(msg.requestId);
    if (callback) {
      bridge.requestCallbacks.delete(msg.requestId);
      callback(msg);
    }
    return;
  }

  if (msg.cmd === "session_list") return;

  if (typeof msg.key === "string" && msg.event) {
    const routedKey = bridge.keyAliases.get(msg.key) ?? msg.key;
    if (msg.event.type === "engine_status") {
      bridge.lastEngineStatusAt.set(routedKey, Date.now());
    }
    // TRACE: one line per engine event, the single largest source of
    // server.jsonl volume at DEBUG.
    trace("event", {
      key: msg.key,
      routed_key: routedKey,
      type: msg.event.type,
    });
    // Every listener (the control plane that feeds the store, the wire
    // projection, notifications) must see the display name, so it is applied
    // here, before the first of them runs. See event-wiring-tool-names.ts.
    applyToolDisplayNames(msg.event);
    bridge.emit("event", routedKey, msg.event as EngineEvent);
  }
}

const MAX_PENDING_OUTBOUND = 256;

/**
 * Fire-and-forget commands sent before the socket was connected, per bridge,
 * flushed in order once it is (engine-bridge-connection.ts). Boot restoration
 * adopts every saved tab and sends each one's `set_plan_mode` while the first
 * connect is still in flight; those used to be dropped with a warning, so a
 * restored plan-mode tab came back in the wrong mode. Kept here rather than
 * on the bridge: the queue is this module's mechanism, not facade surface.
 */
const pendingOutbound = new WeakMap<EngineBridge, string[]>();

/** The bridge's pre-connect queue (created on first use). */
export function pendingOutboundFor(bridge: EngineBridge): string[] {
  let queue = pendingOutbound.get(bridge);
  if (!queue) {
    queue = [];
    pendingOutbound.set(bridge, queue);
  }
  return queue;
}

export function send(bridge: EngineBridge, msg: any): boolean {
  if (!bridge.conn || bridge.conn.destroyed) {
    if (bridge.reconnectDisabled) {
      warn("_send: dropped, bridge stopped", { cmd: msg?.cmd, key: msg?.key });
      return false;
    }
    const queue = pendingOutboundFor(bridge);
    if (queue.length >= MAX_PENDING_OUTBOUND) {
      const dropped = queue.shift();
      warn("_send: pending queue full; dropped the oldest", { dropped_head: dropped?.slice(0, 40) ?? "", queued: queue.length });
    }
    queue.push(JSON.stringify(msg) + "\n");
    debug("_send: queued until connected", { cmd: msg?.cmd, key: msg?.key, queued: queue.length });
    return true;
  }
  try {
    const accepted = bridge.conn.write(JSON.stringify(msg) + "\n");
    if (!accepted)
      warn("_send: backpressure", { cmd: msg?.cmd, key: msg?.key });
    return true;
  } catch (caught: any) {
    error("_send: write failed", {
      cmd: msg?.cmd,
      key: msg?.key,
      error: caught.message,
    });
    return false;
  }
}

/**
 * `unanswered` marks a result the engine never sent (timeout, lost or
 * unavailable connection). Without it an engine refusal and a missing answer
 * both read as `ok: false`.
 */
export interface BridgeRequestResult<T> {
  ok: boolean;
  error?: string;
  /** The engine's machine-readable reason for a refusal, when it gave one. */
  code?: string;
  data?: T;
  unanswered?: true;
}

export function sendWithResult<T = unknown>(
  bridge: EngineBridge,
  msg: any,
): Promise<BridgeRequestResult<T>> {
  return sendWithResponse<T>(bridge, msg, true);
}

export function sendWithData<T>(
  bridge: EngineBridge,
  msg: any,
): Promise<BridgeRequestResult<T>> {
  return sendWithResponse<T>(bridge, msg, false);
}

function sendWithResponse<T>(
  bridge: EngineBridge,
  msg: any,
  logTimeout: boolean,
): Promise<BridgeRequestResult<T>> {
  const requestId = `bridge-${++bridge.requestCounter}-${Date.now()}`;
  msg.requestId = requestId;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!bridge.requestCallbacks.has(requestId)) return;
      bridge.requestCallbacks.delete(requestId);
      if (logTimeout)
        warn("request_timeout", { request_id: requestId, cmd: msg.cmd });
      bridge._onRequestTimeout();
      resolve({ ok: false, error: "Request timed out", unanswered: true });
    }, 30000);

    bridge.requestCallbacks.set(requestId, (result) => {
      clearTimeout(timer);
      bridge.consecutiveTimeouts = 0;
      resolve({ ok: result.ok, error: result.error, ...(result.code ? { code: result.code } : {}), data: result.data as T, ...(result.unanswered ? { unanswered: true } : {}) });
    });

    if (!send(bridge, msg)) {
      clearTimeout(timer);
      bridge.requestCallbacks.delete(requestId);
      warn("request_send_failed", {
        request_id: requestId,
        cmd: msg.cmd,
        key: msg.key,
      });
      resolve({ ok: false, error: "Engine connection unavailable", unanswered: true });
    }
  });
}

export async function stopBackgroundTask(
  bridge: EngineBridge,
  key: string,
  taskId: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  log("stop_background_task", { key, task_id: taskId });
  const result = await bridge.request<{ status?: string }>(
    "stop_background_task",
    { key, taskId },
  );
  return { ok: result.ok, status: result.data?.status, error: result.error };
}

export function sendSteer(
  bridge: EngineBridge,
  key: string,
  message: string,
  clientMessageId?: string,
): void {
  log("send_steer", {
    key,
    len: message.length,
    client_message_id: clientMessageId ?? "",
  });
  bridge._send({
    cmd: "steer_agent",
    key,
    agentName: "",
    message,
    ...(clientMessageId ? { clientMessageId } : {}),
  });
}

export function sendDialogResponse(
  bridge: EngineBridge,
  key: string,
  dialogId: string,
  value: any,
): void {
  debug("send_dialog_response", { key, dialog_id: dialogId });
  bridge._send({ cmd: "dialog_response", key, dialogId, value });
}

export function sendCommand(
  bridge: EngineBridge,
  promptArgs: SendPromptArgs,
  command: string,
  commandArgs: string,
): void {
  // Same hop as sendPrompt. The command is sent without awaiting an answer,
  // so its call span covers the send only.
  const call = startEngineCallSpan(promptArgs.traceparent, promptArgs.key);
  const args = call ? { ...promptArgs, traceparent: call.traceparent } : promptArgs;
  log("send_command", {
    key: args.key,
    command,
    temporary_auto_from_plan: args.temporaryAutoFromPlan ?? false,
    plan_file_path: args.planFilePath ?? "",
    ...traceFields(args.traceparent),
  });
  try {
    bridge._send(buildSendCommandMessage(args, command, commandArgs));
    call?.end({ command, awaited_answer: false });
  } catch (err) {
    call?.end({ command }, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Resolves once the engine has answered the stop. The engine runs each
 * session's commands on that session's own lane and removes the session
 * before it replies, so after the answer a command on another lane (such as
 * `delete_stored_conversations`) no longer sees the conversation as active.
 * An engine refusal only means it held no session under this key, which is
 * the same end state, so it resolves. Rejects only when the engine never
 * answered, because then the session may still be running.
 */
export async function stopSession(bridge: EngineBridge, key: string): Promise<void> {
  log("stop_session", { key });
  bridge.activeSessions.delete(key);
  bridge.retirePendingAbort(key);
  const result = await bridge._sendWithResult({ cmd: "stop_session", key });
  if (result.unanswered) {
    warn("stop_session: engine did not answer", { key, error: result.error ?? "" });
    throw new Error(`engine did not answer stop_session for ${key}: ${result.error ?? "no answer"}`);
  }
  if (result.ok) {
    debug("stop_session: stopped", { key });
  } else {
    debug("stop_session: engine held no session", { key, error: result.error ?? "" });
  }
}

export function sendSetPlanMode(
  bridge: EngineBridge,
  key: string,
  enabled: boolean,
  allowedTools?: string[],
  source?: string,
  allowedBashCommands?: string[],
  planFilePath?: string,
): void {
  log("send_set_plan_mode", {
    key,
    enabled,
    source: source ?? "unknown",
    bash_cmd_count: allowedBashCommands?.length ?? 0,
    plan_file_path: planFilePath ?? "",
  });
  // Restores plan-file continuity when session replacement cleared the engine's
  // in-memory path. The engine only adopts a supplied existing file path.
  bridge._send({
    cmd: "set_plan_mode",
    key,
    enabled,
    allowedTools,
    source,
    planModeAllowedBashCommands: allowedBashCommands,
    ...(planFilePath ? { planFilePath } : {}),
  });
}
