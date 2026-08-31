/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type {
  FsEntry,
  EngineConfig,
  EngineEvent,
  RemoteTransportState,
} from "../shared/types";
import type {} from "../shared/types-ipc";
import type {} from "../shared/types-automation";
import type { ModelTier } from "../shared/types-model-tiers";

export interface IonEngineApi {
  // ─── Filesystem operations ───
  fsReadDir(directory: string): Promise<{ entries: FsEntry[]; error?: string }>;
  fsReadFile(
    filePath: string,
  ): Promise<{ content: string | null; error?: string }>;
  fsWriteFile(
    filePath: string,
    content: string,
  ): Promise<{ ok: boolean; error?: string }>;
  fsCreateDir(dirPath: string): Promise<{ ok: boolean; error?: string }>;
  fsCreateFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
  fsRename(
    oldPath: string,
    newPath: string,
  ): Promise<{ ok: boolean; error?: string }>;
  fsDelete(targetPath: string): Promise<{ ok: boolean; error?: string }>;
  fsSaveDialog(
    defaultPath?: string,
    defaultFileName?: string,
  ): Promise<{ filePath: string | null; error?: string }>;
  fsRevealInFinder(targetPath: string): Promise<void>;
  fsOpenNative(targetPath: string): Promise<{ ok: boolean; error?: string }>;
  fsExists(targetPath: string): Promise<{ exists: boolean }>;
  fsWatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
  fsUnwatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
  onFileChanged(callback: (filePath: string) => void): () => void;

  // ─── Engine operations ───
  engineStart(
    key: string,
    config: EngineConfig,
  ): Promise<{ ok: boolean; error?: string; conversationId?: string }>;
  engineSetPlanMode(key: string, enabled: boolean, planFilePath?: string): void;
  engineAbort(
    key: string,
    scope?: import("../shared/types-engine").AbortScope,
  ): Promise<void>;
  engineAbortDispatch(key: string, dispatchId: string): Promise<void>;
  engineStopBackgroundTask(
    key: string,
    taskId: string,
  ): Promise<{ ok: boolean; status?: string; error?: string }>;
  engineDialogResponse(
    key: string,
    dialogId: string,
    value: any,
  ): Promise<void>;
  engineCommand(key: string, command: string, args: string): Promise<void>;
  engineStop(key: string): Promise<void>;
  /** Tree-native rewind: move the conversation leaf to the PARENT of the
   *  given entry so the next prompt replaces it on the active path (a new
   *  sibling branch) instead of appending a duplicate after the old leaf.
   *  Rejects when the session/entry is unknown. */
  engineBranchBefore(key: string, entryId: string): Promise<void>;
  /** Ordinal-addressed tree-native rewind: the engine resolves the 0-based
   *  user-turn ordinal against its own tree, moves the leaf to before that turn,
   *  and restores plan-file continuity, so the next prompt replaces the turn on
   *  a fresh branch with no duplicate. Resolves with {ok,error?}; ok=false when
   *  the ordinal is out of range or the session is unknown. */
  /** Fire-and-forget rewind to the target entry, tracked either by its exact
   *  entryId or by userTurnIndex (legacy ordinal). The engine records identity
   *  and restores plan-file continuity, so the next prompt replaces the turn on
   *  a fresh branch with no duplicate. Resolves with {ok,error?}; ok=false when
   *  the target is invalid/out of range or the session is unknown. */
  engineRewind(
    key: string,
    target: { entryId?: string; userTurnIndex?: number },
  ): Promise<{ ok: boolean; error?: string }>;
  /** Create a durable, independent conversation from the source session. */
  engineFork(
    key: string,
    newKey: string,
    target: { messageIndex: number; entryId?: string; userTurnIndex?: number },
  ): Promise<{ ok: boolean; error?: string; newKey?: string; conversationId?: string }>;
  /** Fire get_context_breakdown for the given engine key. Fire-and-forget:
   *  the engine emits engine_context_breakdown on its event bus; the renderer
   *  observes the result via the existing context_breakdown normalized event. */
  engineGetContextBreakdown(key: string): Promise<void>;
  /** Read the plan-mode Bash allowlist (engine policy) from engine.json's
   *  limits.planModeAllowedBashCommands. Returns the command-prefix list;
   *  empty when unset (Bash blocked in plan mode). */
  getPlanBashAllowlist(): Promise<string[]>;
  /** Write the plan-mode Bash allowlist to engine.json. The engine re-reads
   *  it fresh at the next dispatch, so the change takes effect on the next
   *  prompt with no daemon restart. */
  setPlanBashAllowlist(cmds: string[]): Promise<void>;
  engineRemapSession(oldKey: string, newKey: string): Promise<void>;
  /** Broadcast a fresh engine_conversation_history for tabId/instanceId to all
   *  connected remote devices. Called by the renderer after a rewind restart so
   *  iOS replaces its now-stale truncated message list immediately. */
  engineBroadcastHistory(
    tabId: string,
    instanceId: string | null,
    opts?: { queueUntilTabExists?: boolean },
  ): Promise<void>;
  /** Notify the main process that the user focused a tab. The main
   *  process publishes the session key as a desktop.focus resource so
   *  extensions can route to the active session. */
  notifyTabFocus(tabId: string, engineProfileId?: string | null): void;
  /** Publish a mark_read delta for a resource. Propagates the read state to
   *  all subscribers (including iOS) via the engine's resource broker. */
  markResourceRead(kind: string, resourceId: string, producer?: string): void;
  /** Get persisted read resource IDs from the main process. */
  getReadResourceIds(): Promise<string[]>;
  /** Get persisted resources from disk (cold-load fallback). */
  getPersistedResources(): Promise<
    Array<{
      id: string;
      kind: string;
      producer?: string;
      title?: string;
      content: string;
      createdAt: string;
      conversationId?: string;
      metadata?: Record<string, unknown>;
      read?: boolean;
    }>
  >;
  /** Publish a delete op for a resource. Removes the item from all
   *  subscribers (including iOS) via the engine's resource broker. */
  publishResourceDelete(
    kind: string,
    resourceId: string,
    producer?: string,
  ): void;
  /** Fetch a single resource item's full content on demand by kind + id.
   *  The engine calls the registered producer's query handler and emits
   *  engine_resource_item, which the event-wiring layer broadcasts to the
   *  renderer as resource_item. The call resolves once the command completes;
   *  the item itself arrives via the event stream. Use resourceGlobal:true for
   *  workspace-scoped items (briefings, global notifications). */
  resourceGet(
    kind: string,
    id: string,
    opts?: { sessionKey?: string; global?: boolean; producer?: string },
  ): Promise<void>;
  onEngineEvent(
    callback: (key: string, event: EngineEvent) => void,
  ): () => void;

  // ─── Guided Questions (AskUserQuestions wizard) ───
  /** The main-owned QuestionsCoordinator's full synchronized state. */
  questionsGetState(): Promise<
    import("../shared/questions-state").QuestionsStateSnapshot
  >;
  /** Apply a revisioned draft patch. */
  questionsPatch(
    patch: import("../shared/questions-state").QuestionsPatch,
  ): Promise<import("../shared/questions-state").QuestionsActionResult>;
  /** Apply a revisioned workflow action. */
  questionsAction(
    action: import("../shared/questions-state").QuestionsAction,
  ): Promise<import("../shared/questions-state").QuestionsActionResult>;
  /** Native image picker for per-question answer attachments. */
  questionsPickAttachments(): Promise<Array<{ path: string; name: string }>>;
  /** Rebuild a parked question from a restored conversation transcript. */
  questionsRehydrate(payload: {
    tabId: string;
    rows: Array<{
      role?: string;
      content?: string;
      toolName?: string;
      toolId?: string;
      toolInput?: string;
      injectionKind?: string;
      machineAuthored?: boolean;
    }>;
  }): Promise<boolean>;
  /** Subscribe to authoritative Questions state broadcasts. */
  onQuestionsState(
    callback: (
      snapshot: import("../shared/questions-state").QuestionsStateSnapshot,
    ) => void,
  ): () => void;

  // ─── Plugin management ───
  /** Install a Claude Code-compatible plugin from a GitHub source ("owner/repo"). */
  pluginInstall(source: string): Promise<{
    ok: boolean;
    error?: string;
    data?: { name: string; source: string; version: string };
  }>;
  /** List all installed plugins. */
  pluginList(): Promise<{
    ok: boolean;
    error?: string;
    data?: Array<{
      name: string;
      source: string;
      version: string;
      installedAt: string;
    }>;
  }>;
  /** Remove an installed plugin by name. */
  pluginRemove(
    name: string,
  ): Promise<{ ok: boolean; error?: string; data?: { removed: string } }>;

  // ─── MCP server administration ───
  /** List configured MCP servers with their connection and authorization state. */
  mcpList(): Promise<{
    ok: boolean;
    servers?: import("../shared/types-engine-event").McpServerStatus[];
    error?: string;
  }>;
  /** Add an MCP server. Omitting `transport` lets the engine infer it: a url
   *  means http, a command means stdio. */
  mcpAdd(request: {
    name: string;
    transport?: string;
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Remove a server and its stored credentials. */
  mcpRemove(name: string): Promise<{ ok: boolean; error?: string }>;
  /** Authorize a server via OAuth. Opens the system browser and resolves only
   *  after the operator completes the flow (or it times out), so callers must
   *  keep their pending UI state until it settles. */
  mcpLogin(
    name: string,
    scope?: string,
  ): Promise<{ ok: boolean; authorizationUrl?: string; error?: string }>;
  /** Drop a server's stored credentials, leaving its configuration in place. */
  mcpLogout(name: string): Promise<{ ok: boolean; error?: string }>;

  // ─── Model & provider management ───
  listModels(): Promise<{
    models: import("../shared/types-models").ModelEntry[];
    providers: import("../shared/types-models").ProviderEntry[];
  }>;
  resolveModelTier(tier: string): Promise<{
    tier: string;
    model: string;
    fallbacks: string[];
    configured: boolean;
  }>;
  listModelTiers(): Promise<ModelTier[]>;
  setModelTier(tier: ModelTier): Promise<{ ok: boolean; error?: string }>;
  removeModelTier(name: string): Promise<{ ok: boolean; error?: string }>;
  onModelTiersUpdated(callback: () => void): () => void;
  storeCredential(
    provider: string,
    credential: string,
  ): Promise<{ ok: boolean; error?: string }>;
  refreshModels(provider?: string): Promise<{ ok: boolean; error?: string }>;

  // ─── Delegated-CLI provider auth (codex/claude-code/grok/cursor) ───
  providerLogin(provider: string): Promise<{ ok: boolean; error?: string }>;
  providerLoginCancel(
    provider: string,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Return a browser-issued auth code to a login parked on await_auth_code. */
  providerLoginCode(
    provider: string,
    code: string,
  ): Promise<{ ok: boolean; error?: string }>;
  providerLogout(provider: string): Promise<{ ok: boolean; error?: string }>;
  onProviderLoginEvent(
    handler: (
      update: import("../shared/types-engine-event").ProviderLoginUpdate,
    ) => void,
  ): () => void;

  // ─── OAuth ───
  startOAuth(provider: string): Promise<{ ok: boolean; error?: string }>;
  logoutOAuth(provider: string): Promise<{ ok: boolean }>;
  oauthStatus(provider: string): Promise<{ hasTokens: boolean }>;
  oauthDeviceCode(provider: string): Promise<{
    ok: boolean;
    userCode?: string;
    verificationUri?: string;
    deviceCode?: string;
    interval?: number;
    expiresIn?: number;
    error?: string;
  }>;
  oauthDevicePoll(
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ): Promise<{ ok: boolean; error?: string }>;

  // ─── Entra OIDC (Feature 0001 Part F — telemetry auth) ───
  entraSignIn(): Promise<{
    ok: boolean;
    identity?: {
      user: string;
      username: string;
      displayName: string;
      oid: string;
    };
    error?: string;
  }>;
  entraSignOut(): Promise<{ ok: boolean; error?: string }>;
  entraIdentity(): Promise<{
    identity: {
      user: string;
      username: string;
      displayName: string;
      oid: string;
    } | null;
  }>;

  // ─── Remote control ───
  remoteGetState(): Promise<{ transportState: RemoteTransportState } | null>;
  remoteGetMessages(tabId: string): Promise<any[]>;
  remoteStartPairing(): Promise<string | null>;
  remoteCancelPairing(): void;
  remoteRevokeDevice(deviceId: string): void;
  remoteDiscoverRelays(): Promise<
    Array<{
      id: string;
      name: string;
      host: string;
      port: number;
      addresses: string[];
    }>
  >;
  remoteStopDiscovery(): void;
  remoteTestRelay(
    relayUrl: string,
    relayApiKey: string,
  ): Promise<{ success: boolean; error?: string }>;
  /** Probe the relay's auth config without connecting (returns null on failure). */
  remoteRelayAuthConfig(relayUrl: string): Promise<{
    oidc: boolean;
    issuer: string;
    audience: string;
    requiredScope: string;
    psk: boolean;
  } | null>;
  remoteSetLanDisabled(disabled: boolean): Promise<void>;
  /** Set the per-desktop display name/icon override. Returns the value now stored. */
  remoteSetDisplay(
    customName: string | null,
    customIcon: string | null,
  ): Promise<{
    customName: string | null;
    customIcon: string | null;
    updatedAt: number;
  }>;
  /** Read the current per-desktop display override (null when unset). */
  remoteGetDisplay(): Promise<{
    customName: string | null;
    customIcon: string | null;
    updatedAt: number;
  } | null>;
  on(channel: string, callback: (...args: any[]) => void): void;
  off(channel: string, callback: (...args: any[]) => void): void;

  // ─── Auto-update ───
  installUpdate(): void;
  restartForUpdate(): void;
  onUpdateDownloaded(callback: (info: { version: string }) => void): () => void;
  onUpdateProgress(
    callback: (info: { percent: number; status: string }) => void,
  ): () => void;
  onUpdateStaged(callback: (info: { workerPid: number }) => void): () => void;
  onUpdateError(callback: (info: { message: string }) => void): () => void;

  // ─── Renderer logging bridge ───
  /** Write a structured log line from renderer context. The main process
   *  stamps component=desktop and forwards to the shared desktop logger. */
  logWrite(
    level: string,
    tag: string,
    msg: string,
    fields?: Record<string, unknown>,
  ): void;

  // ─── Window management ───
  resizeHeight(height: number): void;
  setWindowWidth(width: number): void;
  animateHeight(from: number, to: number, durationMs: number): Promise<void>;
  hideWindow(): void;
  isVisible(): Promise<boolean>;
  /** OS-level click-through for transparent window regions */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
}
