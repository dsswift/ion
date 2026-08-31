import { EventEmitter } from "events";
import { Socket } from "net";
import { log as _log, warn as _warn } from "./logger";
import { installLogCorrelation } from "./engine-bridge-log-correlation";
import { doConnect, scheduleReconnect } from "./engine-bridge-connection";
import {
  startSession as startSessionImpl,
  reRegisterSessions as reRegisterSessionsImpl,
} from "./engine-bridge-start-session";
import {
  sendReconcileState as sendReconcileStateImpl,
  sendQuerySessionStatus as sendQuerySessionStatusImpl,
  sendResolvePermissionDenials as sendResolvePermissionDenialsImpl,
} from "./engine-bridge-state-sync";
import {
  disconnect as disconnectImpl,
  shutdownAndWait as shutdownAndWaitImpl,
} from "./engine-bridge-lifecycle";
import { installAgentStateRecovery } from "./engine-bridge-agent-state";
import type { SendPromptArgs } from "./engine-bridge-prompts";
import * as abort from "./engine-bridge-abort";
import * as core from "./engine-bridge-core";
import * as conv from "./engine-bridge-conversations";
import * as prov from "./engine-bridge-providers";
import type { EngineConfig, DiscoveredCommand } from "../shared/types";
import type { AbortScope } from "../shared/types-engine";
import type { ModelTier } from "../shared/types-model-tiers";

const TAG = "EngineBridge";
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields);
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields);
}
// Connection constants live in engine-bridge-connection.ts (the connect
// ladder + reconnect-loop module); re-exported here so existing consumers
// keep importing them from the bridge module.
export {
  IS_REMOTE,
  REMOTE_SOCKET,
  LADDER_FAST_FAIL_WINDOW_MS,
} from "./engine-bridge-connection";

/**
 * EngineBridge: thin socket client connecting Ion to the standalone
 * ion engine server process.
 *
 * Events emitted:
 *  - 'event' (key, EngineEvent) -- forwarded from engine server
 */
export class EngineBridge extends EventEmitter {
  conn: Socket | null = null;
  // Package-internal (written by engine-bridge-connection.ts).
  buffer = "";
  connected = false;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Package-internal (managed by engine-bridge-connection.ts).
  reconnectAttempts = 0;
  requestCallbacks = new Map<string, (result: any) => void>();
  requestCounter = 0;
  private connectPromise: Promise<void> | null = null;
  /**
   * Set when a full connect retry ladder exhausted against a dead socket;
   * cleared on any successful connect. While recent (see
   * LADDER_FAST_FAIL_WINDOW_MS), subsequent connect() callers make one
   * immediate attempt and then fail fast instead of re-running the ladder —
   * the background reconnect loop owns recovery during an outage.
   * Package-internal (managed by engine-bridge-connection.ts).
   */
  lastLadderFailureAt = 0;
  reconnectDisabled = false;
  /**
   * Monotonic counter incremented on every successful socket connect.
   * Package-internal (used by engine-bridge-start-session.ts to cancel
   * stale reRegisterSessions batches after a new connection replaces the
   * one that triggered the batch).
   */
  _reRegisterGeneration = 0;
  _drainScheduled = false;
  sessionGeneration = 0;
  // Package-internal (used by engine-bridge-start-session.ts and other siblings).
  activeSessions = new Map<
    string,
    { config: EngineConfig; conversationId?: string; generation?: number }
  >();
  /** Client-side key aliases: oldKey → newKey. Rewrites incoming event keys. */
  keyAliases = new Map<string, string>();
  /** Tracks last `engine_status` receipt per key for stale-sweep polling. */
  lastEngineStatusAt = new Map<string, number>();
  // Package-internal: reset by engine-bridge-connection.ts on new connection.
  consecutiveTimeouts = 0;

  constructor() {
    super();
    installAgentStateRecovery(this);
    // Let the logger resolve each line's conversation from its own session key
    // (see engine-bridge-log-correlation.ts). The bridge owns that mapping.
    installLogCorrelation(
      this as unknown as Parameters<typeof installLogCorrelation>[0],
    );
  }

  // ─── Connection lifecycle ───

  async connect(): Promise<void> {
    if (this.connected) return;
    // Prevent concurrent connect() calls from creating multiple connections.
    // All callers share the same in-flight connection attempt.
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = doConnect(this);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  _onRequestTimeout(): void {
    this.consecutiveTimeouts++;
    if (this.consecutiveTimeouts >= 2 && this.conn) {
      warn("consecutive_timeouts", { count: this.consecutiveTimeouts });
      this.conn.destroy();
    }
  }

  // Package-internal seam: the reconnect loop lives in
  // engine-bridge-connection.ts; this thin method remains for in-class
  // callers (request-timeout eviction path).
  _scheduleReconnect(): void {
    scheduleReconnect(this);
  }

  _drainBuffer(): void {
    core.drainBuffer(this);
  }

  _handleMessage(line: string): void {
    core.handleMessage(this, line);
  }

  _send(msg: any): boolean {
    return core.send(this, msg);
  }

  _sendWithResult<T = unknown>(
    msg: any,
  ): Promise<{ ok: boolean; error?: string; data?: T }> {
    return core.sendWithResult<T>(this, msg);
  }

  _sendWithData<T>(
    msg: any,
  ): Promise<{ ok: boolean; error?: string; data?: T }> {
    return core.sendWithData<T>(this, msg);
  }

  /** Reject all pending request callbacks with an error message.
   * Package-internal (called by engine-bridge-connection.ts on remote errors). */
  _failPendingRequests(reason: string): void {
    for (const [_id, cb] of this.requestCallbacks) {
      cb({ ok: false, error: reason });
    }
    this.requestCallbacks.clear();
  }

  /** Re-register all tracked sessions, then reconcile (see engine-bridge-start-session.ts).
   * Package-internal (called by engine-bridge-connection.ts after a reconnect). */
  _reRegisterSessions(): void {
    reRegisterSessionsImpl(this);
  }

  /**
   * Remap a session key client-side.
   * Moves the activeSessions entry from oldKey to newKey and registers an alias
   * so incoming engine events keyed by oldKey are transparently rewritten.
   */
  remapSession(oldKey: string, newKey: string): void {
    log("remap_session", { old_key: oldKey, new_key: newKey });
    const entry = this.activeSessions.get(oldKey);
    if (entry) {
      this.activeSessions.set(newKey, entry);
      this.activeSessions.delete(oldKey);
      log("remap_session: active_sessions moved", {
        old_key: oldKey,
        new_key: newKey,
      });
    } else {
      log("remap_session: no active_sessions entry", { old_key: oldKey });
    }
    this.keyAliases.set(oldKey, newKey);
    // Remove any prior alias that pointed to oldKey to avoid stale chains
    for (const [k, v] of this.keyAliases) {
      if (v === oldKey && k !== oldKey) {
        this.keyAliases.set(k, newKey);
        log("remap_session: transitive_alias updated", {
          alias: k,
          new_key: newKey,
        });
      }
    }
  }

  // ─── Command helpers ───

  // ─── Public API ───

  async startSession(
    key: string,
    config: EngineConfig,
  ): Promise<{ ok: boolean; error?: string; conversationId?: string }> {
    return startSessionImpl(this, key, config);
  }

  /** Send a typed-response command. Sibling helpers (e.g. engine-bridge-fs.ts) layer on top of the bridge via this. */
  async request<T>(
    cmd: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; error?: string; data?: T }> {
    await this.connect();
    return this._sendWithData<T>({ cmd, ...payload });
  }

  async getAgentState(key: string): Promise<{
    ok: boolean;
    error?: string;
    agents?: import("../shared/types").AgentStateUpdate[];
  }> {
    const result = await this.request<{
      agents?: import("../shared/types").AgentStateUpdate[];
    }>("get_agent_state", { key });
    return { ok: result.ok, error: result.error, agents: result.data?.agents };
  }

  /** Track the conversation ID for a session so it can be restored on reconnect. */
  updateSessionConversationId(key: string, conversationId: string): void {
    const entry = this.activeSessions.get(key);
    if (entry) {
      entry.conversationId = conversationId;
    }
  }

  /**
   * Return a shallow copy of the last EngineConfig used to start this session
   * key, or undefined if the key was never started. Used by the divergence
   * resume path (engine-control-plane-events.ts) so a post-restart resume
   * carries the tab's real workingDirectory/extensions/model instead of empty
   * placeholders. Returning a copy keeps callers from mutating bridge state.
   */
  getSessionConfig(key: string): EngineConfig | undefined {
    const entry = this.activeSessions.get(key);
    return entry ? { ...entry.config } : undefined;
  }

  /**
   * Send a prompt for one session.
   *
   * Takes a NAMED options object rather than positional parameters. The
   * previous signature had grown to fifteen positional arguments, all but two
   * optional and several adjacent strings — a shape where inserting a
   * parameter anywhere but the end silently shifts every later argument, and
   * where `undefined` placeholders at call sites carry no indication of which
   * field they stand for. `SendPromptArgs` already described exactly this
   * payload one layer down, so the positional list was a redundant
   * restatement whose only contribution was the ordering hazard.
   */
  async sendPrompt(
    key: string,
    text: string,
    opts: Omit<import("./engine-bridge-prompts").SendPromptArgs, "key" | "text"> = {},
  ): Promise<{
    ok: boolean;
    error?: string;
    data?: { accepted?: boolean; alreadyAccepted?: boolean };
  }> {
    return core.sendPrompt(this, key, text, opts);
  }

  /**
   * Deferred interrupts keyed by session key and the connection generation that
   * must deliver them. A reconnect can fail while flushing; entries stay here
   * until both abort writes reach a live socket. Live-write failure uses the
   * current generation, so only a later connection can retry it.
   */
  pendingAborts = new Map<string, number>();
  pendingAbortScopes = new Map<string, AbortScope>();

  nextSessionGeneration(): number {
    return abort.nextSessionGeneration(this);
  }

  retirePendingAbort(key: string): void {
    abort.retirePendingAbort(this, key);
  }

  sendAbort(key: string, scope: AbortScope = "all"): void {
    abort.sendAbort(this, key, scope);
  }

  flushPendingAborts(): void {
    abort.flushPendingAborts(this);
  }

  sendAbortDispatch(key: string, dispatchId: string): void {
    abort.sendAbortDispatch(this, key, dispatchId);
  }

  async stopBackgroundTask(
    key: string,
    taskId: string,
  ): Promise<{ ok: boolean; status?: string; error?: string }> {
    return core.stopBackgroundTask(this, key, taskId);
  }

  sendSteer(key: string, message: string, clientMessageId?: string): void {
    core.sendSteer(this, key, message, clientMessageId);
  }

  async sendDialogResponse(
    key: string,
    dialogId: string,
    value: any,
  ): Promise<void> {
    core.sendDialogResponse(this, key, dialogId, value);
  }

  async sendCommand(
    promptArgs: SendPromptArgs,
    command: string,
    commandArgs: string,
  ): Promise<void> {
    core.sendCommand(this, promptArgs, command, commandArgs);
  }

  async stopSession(key: string): Promise<void> {
    core.stopSession(this, key);
  }

  // Tree-native rewind RPCs. Bodies live in engine-bridge-conversations.ts.
  async forkSession(
    key: string,
    newKey: string,
    target: { messageIndex: number; entryId?: string; userTurnIndex?: number },
  ): Promise<{ ok: boolean; error?: string; newKey?: string; conversationId?: string }> {
    return conv.forkSession(this, key, newKey, target);
  }
  async branchSessionBefore(key: string, entryId: string): Promise<void> {
    return conv.branchSessionBefore(this, key, entryId);
  }
  async rewindSession(
    key: string,
    target: { entryId?: string; userTurnIndex?: number },
  ): Promise<{ ok: boolean; error?: string }> {
    return conv.rewindSession(this, key, target);
  }

  sendPermissionResponse(
    key: string,
    questionId: string,
    optionId: string,
  ): void {
    log("send_permission_response", {
      key,
      question_id: questionId,
      option_id: optionId,
    });
    this._send({ cmd: "permission_response", key, questionId, optionId });
  }

  sendElicitationResponse(
    key: string,
    requestId: string,
    response: Record<string, unknown> | undefined,
    cancelled: boolean,
    declined = false,
  ): void {
    log("send_elicitation_response", {
      key,
      request_id: requestId,
      cancelled,
      declined,
    });
    this._send({
      cmd: "elicitation_response",
      key,
      elicitRequestId: requestId,
      elicitResponse: response,
      elicitCancelled: cancelled,
      elicitDeclined: declined,
    });
  }

  sendRaw(payload: Record<string, unknown>): void {
    this._send(payload);
  }

  sendSetPlanMode(
    key: string,
    enabled: boolean,
    allowedTools?: string[],
    source?: string,
    allowedBashCommands?: string[],
    planFilePath?: string,
  ): void {
    core.sendSetPlanMode(
      this,
      key,
      enabled,
      allowedTools,
      source,
      allowedBashCommands,
      planFilePath,
    );
  }

  // ─── Conversation-data RPCs ───
  //
  // Bodies live in engine-bridge-conversations.ts. The methods stay on
  // the bridge so external callers (renderer IPC, control plane, OAuth
  // token store) keep their existing surface area. Each wrapper is a
  // single-line delegate — see the sibling file for behavior, logging,
  // and wire-protocol contract notes.

  async listStoredSessions(limit?: number): Promise<any[]> {
    return conv.listStoredSessions(this, limit);
  }

  async loadSessionHistory(sessionId: string): Promise<any[]> {
    return conv.loadSessionHistory(this, sessionId);
  }

  // Discover filesystem `.md`/skill slash templates (the engine OWNS slash
  // resolution). `claudeCompat` gates the .claude roots engine-side. Mapping +
  // contract live in the sibling file.
  discoverSlashCommands(
    workingDir: string,
    claudeCompat: boolean,
  ): Promise<DiscoveredCommand[]> {
    return conv.discoverSlashCommands(this, workingDir, claudeCompat);
  }

  async loadChainHistory(sessionIds: string[]): Promise<any[]> {
    return conv.loadChainHistory(this, sessionIds);
  }

  async getConversation(
    conversationId: string,
    offset = 0,
    limit = 50,
  ): Promise<any> {
    return conv.getConversation(this, conversationId, offset, limit);
  }

  async deleteStoredConversations(
    sessionIds: string[],
  ): Promise<{ deleted: number }> {
    return conv.deleteStoredConversations(this, sessionIds);
  }

  async clearConversationFile(conversationId: string): Promise<void> {
    return conv.clearConversationFile(this, conversationId);
  }

  async saveSessionLabel(
    sessionId: string,
    label: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return conv.saveSessionLabel(this, sessionId, label);
  }

  async generateTitle(text: string): Promise<string> {
    return conv.generateTitle(this, text);
  }

  async migrateConversation(
    sessionId: string,
    targetFormat: string,
    targetDir: string,
    sourceDir: string,
  ): Promise<{
    ok: boolean;
    error?: string;
    data?: {
      newSessionId: string;
      outputPath: string;
      messageCount: number;
      contentHash: string;
    };
  }> {
    return conv.migrateConversation(
      this,
      sessionId,
      targetFormat,
      targetDir,
      sourceDir,
    );
  }

  // Model / credential / delegated-CLI provider RPCs delegate to
  // engine-bridge-providers.ts (file-size cap).
  async listModels(): Promise<{ models: any[]; providers: any[] }> {
    return prov.listModels(this);
  }
  async resolveModelTier(tier: string): Promise<{
    tier: string;
    model: string;
    fallbacks: string[];
    configured: boolean;
  }> {
    return prov.resolveModelTier(this, tier);
  }
  async listModelTiers(): Promise<ModelTier[]> {
    return prov.listModelTiers(this);
  }
  async setModelTier(
    tier: ModelTier,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.setModelTier(this, tier);
  }
  async removeModelTier(
    name: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.removeModelTier(this, name);
  }
  async storeCredential(
    provider: string,
    credential: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.storeCredential(this, provider, credential);
  }
  async refreshModels(
    provider?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.refreshModels(this, provider);
  }
  async providerLogin(
    provider: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.providerLogin(this, provider);
  }
  async providerLoginCancel(
    provider: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.providerLoginCancel(this, provider);
  }
  async providerLoginCode(
    provider: string,
    code: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.providerLoginCode(this, provider, code);
  }
  async providerLogout(
    provider: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return prov.providerLogout(this, provider);
  }

  sendReconcileState(key: string): void {
    sendReconcileStateImpl(this, key);
  }
  sendQuerySessionStatus(key: string): void {
    sendQuerySessionStatusImpl(this, key);
  }
  sendResolvePermissionDenials(key: string): void {
    sendResolvePermissionDenialsImpl(this, key);
  }

  stopByPrefix(prefix: string): void {
    for (const key of this.activeSessions.keys()) {
      if (key.startsWith(prefix)) {
        this.activeSessions.delete(key);
        this.retirePendingAbort(key);
      }
    }
    this._send({ cmd: "stop_by_prefix", prefix });
  }

  /**
   * Drop this desktop's socket to the engine daemon. Stops NO sessions — see
   * engine-bridge-lifecycle.disconnect for why the old name (`stopAll`) was a
   * defect generator.
   */
  async disconnect(): Promise<void> {
    return disconnectImpl(this);
  }
  shutdown(): void {
    this._send({ cmd: "shutdown" });
  }
  async shutdownAndWait(timeoutMs = 3000): Promise<void> {
    return shutdownAndWaitImpl(this, timeoutMs);
  }

  isRunning(_key: string): boolean {
    // Can't synchronously check -- return true if connected
    return this.connected;
  }
}
