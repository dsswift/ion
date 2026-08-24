import type { EngineEvent } from "../shared/types";
import type { EngineBridge } from "./engine-bridge";
import {
  buildSendPromptLogLine,
  buildSendPromptMessage,
} from "./engine-bridge-prompts";
import type { SendPromptArgs } from "./engine-bridge-prompts";
import {
  debug as _debug,
  error as _error,
  log as _log,
  warn as _warn,
} from "./logger";

const TAG = "EngineBridge";

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug(TAG, msg, fields);
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
  log(buildSendPromptLogLine(args));
  await bridge.connect();
  return bridge._sendWithResult(buildSendPromptMessage(args));
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
    debug("event", {
      key: msg.key,
      routed_key: routedKey,
      type: msg.event.type,
    });
    bridge.emit("event", routedKey, msg.event as EngineEvent);
  }
}

export function send(bridge: EngineBridge, msg: any): boolean {
  if (!bridge.conn || bridge.conn.destroyed) {
    warn("_send: dropped, no connection", { cmd: msg?.cmd, key: msg?.key });
    return false;
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

export function sendWithResult<T = unknown>(
  bridge: EngineBridge,
  msg: any,
): Promise<{ ok: boolean; error?: string; data?: T }> {
  return sendWithResponse<T>(bridge, msg, true);
}

export function sendWithData<T>(
  bridge: EngineBridge,
  msg: any,
): Promise<{ ok: boolean; error?: string; data?: T }> {
  return sendWithResponse<T>(bridge, msg, false);
}

function sendWithResponse<T>(
  bridge: EngineBridge,
  msg: any,
  logTimeout: boolean,
): Promise<{ ok: boolean; error?: string; data?: T }> {
  const requestId = `bridge-${++bridge.requestCounter}-${Date.now()}`;
  msg.requestId = requestId;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!bridge.requestCallbacks.has(requestId)) return;
      bridge.requestCallbacks.delete(requestId);
      if (logTimeout)
        warn("request_timeout", { request_id: requestId, cmd: msg.cmd });
      bridge._onRequestTimeout();
      resolve({ ok: false, error: "Request timed out" });
    }, 30000);

    bridge.requestCallbacks.set(requestId, (result) => {
      clearTimeout(timer);
      bridge.consecutiveTimeouts = 0;
      resolve({ ok: result.ok, error: result.error, data: result.data as T });
    });

    send(bridge, msg);
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
  key: string,
  command: string,
  args: string,
): void {
  log("send_command", { key, command });
  bridge._send({ cmd: "command", key, command, args });
}

export function stopSession(bridge: EngineBridge, key: string): void {
  log("stop_session", { key });
  bridge.activeSessions.delete(key);
  bridge.retirePendingAbort(key);
  bridge._send({ cmd: "stop_session", key });
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
