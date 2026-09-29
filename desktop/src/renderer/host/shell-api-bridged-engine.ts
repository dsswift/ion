/**
 * Bridged `host.shell` verbs, engine domain: every one is served by a
 * `studio_action` or `studio_event` on every host (`browser-shell-bridge.ts`),
 * so the Electron preload no longer carries it. Moved verbatim from the
 * preload's `ionapi-engine.ts` (spec 12: `IonAPI` shrinks toward the natives and the
 * host relay, `ShellApi` keeps the full surface).
 */
import type { FsEntry } from "@ion/shared/types";
import type { ModelTier } from "@ion/shared/types-model-tiers";

export interface BridgedEngineShell {
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
  fsExists(targetPath: string): Promise<{ exists: boolean }>;
  fsWatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
  fsUnwatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
  onFileChanged(callback: (filePath: string) => void): () => void;
  /** Report which directories under `root` change, on `onFileTreeChanged`, until unwatched. */
  fsWatchTree(root: string): Promise<{ ok: boolean; error?: string }>;
  fsUnwatchTree(root: string): Promise<{ ok: boolean }>;
  onFileTreeChanged(
    callback: (change: import("@ion/shared/fs-tree-watch").FsTreeChange) => void,
  ): () => void;
  /** The engine's complete MCP server list after any change. Replace, never merge. */
  onMcpServersChanged(
    callback: (servers: import("@ion/shared/types-engine-event").McpServerStatus[]) => void,
  ): () => void;
  /** The main-owned QuestionsCoordinator's full synchronized state. */
  questionsGetState(): Promise<
    import("@ion/shared/questions-state").QuestionsStateSnapshot
  >;
  /** Apply a revisioned draft patch. */
  questionsPatch(
    patch: import("@ion/shared/questions-state").QuestionsPatch,
  ): Promise<import("@ion/shared/questions-state").QuestionsActionResult>;
  /** Apply a revisioned workflow action. */
  questionsAction(
    action: import("@ion/shared/questions-state").QuestionsAction,
  ): Promise<import("@ion/shared/questions-state").QuestionsActionResult>;
  /** Subscribe to authoritative Questions state broadcasts. */
  onQuestionsState(
    callback: (
      snapshot: import("@ion/shared/questions-state").QuestionsStateSnapshot,
    ) => void,
  ): () => void;
  /** List configured MCP servers with their connection and authorization state. */
  mcpList(): Promise<{
    ok: boolean;
    servers?: import("@ion/shared/types-engine-event").McpServerStatus[];
    error?: string;
  }>;
  /** Add an MCP server. */
  mcpAdd(
    request: import("@ion/shared/mcp-admin-requests").McpAddRequest,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Change one server, keeping every setting the request does not name. */
  mcpUpdate(
    request: import("@ion/shared/mcp-admin-requests").McpUpdateRequest,
  ): Promise<
    { ok: boolean; error?: string } & Partial<import("@ion/shared/mcp-admin-requests").McpUpdateOutcome>
  >;
  /** Remove a server and its stored credentials. */
  mcpRemove(name: string): Promise<{ ok: boolean; error?: string }>;
  /** Authorize a server via OAuth. Opens the system browser on the server's
   *  machine and resolves only after the operator completes the flow (or it
   *  times out), so callers must keep their pending UI state until it
   *  settles. With `options.redirectUri` the server opens nothing and answers
   *  at once with `authorizationUrl` and `flowId`; the caller opens the page
   *  and finishes with `authCompleteSignIn`. */
  mcpLogin(
    name: string,
    scope?: string,
    options?: { redirectUri?: string },
  ): Promise<{ ok: boolean; authorizationUrl?: string; flowId?: string; error?: string }>;
  /** Finish a sign-in begun with a `redirectUri`: hand the server the address
   *  the browser landed on. */
  authCompleteSignIn(request: { flowId: string; callbackUrl: string }): Promise<{ ok: boolean; error?: string }>;
  /** Drop a server's stored credentials, leaving its configuration in place. */
  mcpLogout(name: string): Promise<{ ok: boolean; error?: string }>;
  // ─── Model & provider management ───
  listModels(): Promise<{
    models: import("@ion/shared/types-models").ModelEntry[];
    providers: import("@ion/shared/types-models").ProviderEntry[];
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
  onModelTiersUpdated(callback: (payload?: unknown, environmentId?: string) => void): () => void;
  /** A server's model cache changed (engine reconnect, credential stored); fires for every connected Environment with its id. */
  onModelsUpdated(callback: (payload: unknown, environmentId?: string) => void): () => void;
  /**
   * The operator's preferred provider for resolving a BARE model name in a
   * tier. Empty string means no preference is configured.
   */
  getDefaultProvider(): Promise<string>;
  /** Persist the default provider; an empty string clears the preference. */
  setDefaultProvider(
    provider: string,
  ): Promise<{ ok: boolean; error?: string }>;
  onDefaultProviderUpdated(callback: (payload?: unknown, environmentId?: string) => void): () => void;
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
  /** Fires for every connected Environment; `environmentId` names the one the login belongs to. */
  onProviderLoginEvent(
    handler: (
      update: import("@ion/shared/types-engine-event").ProviderLoginUpdate,
      environmentId?: string,
    ) => void,
  ): () => void;
  // ─── OAuth ───
  startOAuth(provider: string): Promise<{ ok: boolean; error?: string }>;
  logoutOAuth(provider: string): Promise<{ ok: boolean }>;
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
  remoteGetMessages(tabId: string): Promise<any[]>;
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
}
