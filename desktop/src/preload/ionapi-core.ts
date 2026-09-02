/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type {
  RunOptions,
  HealthReport,
  FileAttachment,
  SessionMeta,
  SessionLoadMessage,
  PersistedTabState,
  EngineHostInfo,
  EngineDirListing,
  DiscoveredCommand,
  NewConversationDefaultsPolicy,
  ResolvedNewConversationDefaults,
} from "../shared/types";
import type {
  DeepLinkConfirmRequest,
  DeepLinkConfirmResult,
} from "../shared/types-ipc";
import type { EnterprisePolicy } from "../shared/types-engine";
import type { CustomThemeForRenderer } from "../shared/theme-pack-types";
import type { StartupReport } from "../shared/startup-state";

export interface IonCoreApi {
  /** Report a factual bootstrap phase to the main-process splash coordinator. */
  startupReport(report: StartupReport): void;
  // ─── Request-response (renderer → main) ───
  start(): Promise<{
    version: string;
    auth: { email?: string; subscriptionType?: string; authMethod?: string };
    mcpServers: string[];
    projectPath: string;
    homePath: string;
  }>;
  createTab(): Promise<{ tabId: string }>;
  adoptTab(tabId: string): Promise<{ tabId: string }>;
  prompt(tabId: string, requestId: string, options: RunOptions): Promise<void>;
  cancel(requestId: string): Promise<boolean>;
  steer(
    tabId: string,
    message: string,
    clientMessageId?: string,
    meta?: import("../shared/types-session").SteerMeta,
  ): void;
  stopTab(
    tabId: string,
    scope?: import("../shared/types-engine").AbortScope,
  ): Promise<boolean>;
  retry(tabId: string, requestId: string, options: RunOptions): Promise<void>;
  status(): Promise<HealthReport>;
  tabHealth(): Promise<HealthReport>;
  closeTab(tabId: string): Promise<void>;
  /**
   * Fire-and-forget notification to the main process that a tab field changed.
   * Main pushes a desktop_tab_meta delta to iOS immediately (no poll wait).
   */
  tabMetaChanged(payload: {
    tabId: string;
    title?: string;
    runCostUsd?: number;
    totalCostUsd?: number;
    groupId?: string | null;
    pillColor?: string | null;
    pillIcon?: string | null;
  }): void;
  /**
   * Fire-and-forget push of the renderer's remote tab-state projection
   * (renderer-push snapshot architecture). The OWNER renderer calls this on
   * store change (debounced ~250 ms); the main process caches the payload and
   * getRemoteTabStates() serves the cache. See
   * renderer/stores/remote-projection-push.ts.
   */
  pushRemoteTabStates(
    payload: import("../shared/remote-projection-types").RemoteTabStatesPayload,
  ): void;
  selectDirectory(): Promise<string | null>;
  selectExtensionFiles(): Promise<string[] | null>;
  getEngineHostInfo(): Promise<{
    ok: boolean;
    error?: string;
    data?: EngineHostInfo;
  }>;
  listEngineDirectory(
    path: string,
    showHidden: boolean,
  ): Promise<{ ok: boolean; error?: string; data?: EngineDirListing }>;
  engineIsRemote(): Promise<boolean>;
  /** Fetch the enterprise new-tab policy from the engine. Returns null when no enterprise config is active. */
  getEnterprisePolicy(): Promise<NewConversationDefaultsPolicy | null>;
  /** Fetch the full enterprise policy blob (D-004). Returns null when no enterprise config is active. */
  getEnterprisePolicyFull(): Promise<EnterprisePolicy | null>;
  resolveNewConversationDefaults(path: string): Promise<ResolvedNewConversationDefaults | null>;
  /** Custom theme packs installed on disk (desktop components, resolved with inline asset data URLs). */
  listCustomThemes(): Promise<CustomThemeForRenderer[]>;
  openExternal(url: string): Promise<boolean>;
  /** Main-process-cached site favicon as a data: URL (null = unavailable;
   * renderer falls back to its Globe glyph). */
  getFavicon(host: string): Promise<string | null>;
  /** iOS asked to open (or focus) a conversation in a worktree. */
  onRemoteOpenWorktreeConversation(
    callback: (arg: { worktreePath: string; newConversation: boolean }) => void,
  ): () => void;
  /** iOS asked the owner renderer to retire a landed worktree safely. */
  onRemoteRetireWorktree(
    callback: (arg: {
      repoPath: string;
      worktreePath: string;
      branchName: string;
    }) => void,
  ): () => void;
  /** iOS asked the owner renderer to retire every landed worktree in a repo. */
  onRemoteRetireLandedWorktrees(
    callback: (arg: { repoPath: string }) => void,
  ): () => void;
  /** iOS asked to open (or focus) a conversation in the integration bench. */
  onRemoteOpenBenchConversation(
    callback: (arg: { repoPath: string; sourceBranch: string }) => void,
  ): () => void;
  /** iOS asked to open (or focus) the integration bench's dedicated terminal. */
  onRemoteOpenBenchTerminal(
    callback: (arg: { repoPath: string; sourceBranch: string }) => void,
  ): () => void;
  /** iOS requests that the owner renderer perform a worktree or bench mutation. */
  onRemoteWorktreeAction(
    callback: (action: string, arg: Record<string, unknown>) => void,
  ): () => void;
  /** iOS drives the sync pipeline (start / confirm-ai / cancel / dismiss). */
  onRemoteWorktreePipeline(
    callback: (arg: {
      verb: "start" | "confirm-ai" | "cancel" | "dismiss";
      repoPath: string;
      sourceBranch?: string;
    }) => void,
  ): () => void;
  /** A worktree was named (generated or renamed). Both windows re-read the row. */
  onWorktreeTitled(
    callback: (arg: {
      repoPath: string;
      worktreePath: string;
      title: string;
    }) => void,
  ): () => void;
  /** A successful Land sealed the worktree; owners lock existing review tabs. */
  onWorktreeLanded(
    callback: (arg: {
      repoPath: string;
      worktreePath: string;
      prunedBenchPaths: string[];
    }) => void,
  ): () => void;
  /**
   * The main-process freshness poll re-crawled these repos. The owner renderer
   * re-reads its worktree + bench caches; both refreshes no-op when git has not
   * moved, which is what keeps a forever-ticking poll quiescent.
   */
  onWorktreeFreshnessTick(
    callback: (arg: { repoPaths: string[] }) => void,
  ): () => void;
  /** Reveal a directory in the OS file manager. */
  revealPath(path: string): Promise<boolean>;

  attachFiles(): Promise<FileAttachment[] | null>;
  attachFileByPath(path: string): Promise<FileAttachment | null>;
  takeScreenshot(): Promise<FileAttachment | null>;
  pasteImage(dataUrl: string): Promise<FileAttachment | null>;
  transcribeAudio(
    audioBase64: string,
  ): Promise<{ error: string | null; transcript: string | null }>;
  getDiagnostics(): Promise<any>;
  /**
   * Copy PNG bytes to the OS clipboard. Resolves false on any refusal (wrong
   * type, oversize, bad signature, undecodable) so the caller can tell the
   * user rather than leaving them to discover an empty paste.
   */
  copyPngToClipboard(png: ArrayBuffer): Promise<boolean>;
  /** Ask the conversation transcript to scroll to a chart's newest card. */
  requestChartJump(request: {
    tabId: string;
    chartId: string;
    messageId: string;
  }): void;
  /** Transcript side: chart-jump requests arriving from any surface. */
  onChartJump(
    callback: (request: { tabId: string; chartId: string; messageId: string }) => void,
  ): () => void;
  /**
   * Rebuild a conversation's durable chart index from the rows its ACTIVE
   * BRANCH can see, after a rewind or a fork adopting its own conversation.
   *
   * `rows` carries each completed RenderChart row's input AND its committed
   * result text: the chart id lives in the result, never in the row id, so a
   * rebuild without it would reconcile the wrong charts.
   */
  reconcileCharts(request: {
    tabId: string;
    conversationId: string;
    rows: Array<{
      toolMessageId: string;
      toolInput: string;
      resultText: string;
      index: number;
    }>;
  }): void;
  /**
   * Main announces the resource catalog changed outside a live delta (e.g.
   * persisted charts republished on session subscribe). Consumers re-read the
   * catalog rather than waiting for the next producer action.
   */
  onResourceCatalogChanged(callback: () => void): () => void;
  respondPermission(
    tabId: string,
    questionId: string,
    optionId: string,
  ): Promise<boolean>;
  respondElicitation(
    tabId: string,
    requestId: string,
    response: Record<string, unknown> | undefined,
    cancelled: boolean,
    declined?: boolean,
  ): Promise<boolean>;
  approveDeniedTools(tabId: string, toolNames: string[]): Promise<boolean>;
  /**
   * Tells the engine this client has moved past the retained denials for this
   * tab (dismissed, answered, or superseded by an approval), so the engine
   * releases its retention and stops re-publishing the denial.
   */
  resolvePermissionDenials(tabId: string): void;
  initSession(tabId: string): void;
  ensureEngineSession(args: {
    tabId: string;
    workingDirectory: string;
    conversationId?: string | null;
    permissionMode?: "auto" | "plan";
  }): Promise<{ ok: boolean; error?: string; conversationId?: string }>;
  resetTabSession(tabId: string): void;
  restartTabSession(tabId: string): void;
  /**
   * Move a live conversation to a new working directory, preserving its
   * conversationId and history. Lets a conversation outlive its worktree.
   */
  relocateTabSession(
    tabId: string,
    workingDirectory: string,
  ): Promise<{ ok: boolean; conversationId?: string; error?: string }>;
  listSessions(projectPath?: string): Promise<SessionMeta[]>;
  listAllSessions(): Promise<SessionMeta[]>;
  loadSession(
    sessionId: string,
    projectPath?: string,
    encodedDir?: string,
  ): Promise<SessionLoadMessage[]>;
  conversationExists(sessionId: string): Promise<boolean>;
  readPlan(
    filePath: string,
  ): Promise<{ content: string | null; fileName: string | null }>;
  readImageDataUrl(filePath: string): Promise<{ dataUrl: string | null }>;
  discoverCommands(projectPath: string): Promise<DiscoveredCommand[]>;
  listFonts(): Promise<string[]>;
  terminalCreate(key: string, cwd: string): Promise<void>;
  terminalWrite(key: string, data: string): void;
  terminalResize(key: string, cols: number, rows: number): void;
  terminalDestroy(key: string): Promise<void>;
  /** Attach protocol (D2): history snapshot + lifecycle; optional respawn. */
  terminalAttach(
    key: string,
    opts?: { restartIfNotRunning?: boolean; cwd?: string },
  ): Promise<{
    history: string;
    running: boolean;
    exitCode: number | null;
    cwd: string;
    cwdFellBack: boolean;
  }>;
  /** Active-UI picker: current resolution + enterprise lock state. */
  getActiveUi(): Promise<{ activeUi: "overlay" | "studio"; locked: boolean }>;
  /** Set the active conversation UI (live switch, no restart). False = rejected/locked. */
  setActiveUi(ui: "overlay" | "studio"): Promise<boolean>;
  terminalActiveTabs(): Promise<string[]>;
  terminalActivitySnapshot(): Promise<import('../shared/terminal-activity').TerminalActivity[]>;
  onTerminalActivity(callback: (activity: import('../shared/terminal-activity').TerminalActivity) => void): () => void;
  /**
   * An untrusted ion:// deep link is awaiting approval. The callback receives
   * everything the operator needs to decide; answer with
   * `resolveDeepLinkConfirm`.
   */
  onDeepLinkConfirmRequest(
    callback: (request: DeepLinkConfirmRequest) => void,
  ): () => void;
  onDeepLinkConfirmSettled(callback: (id: string) => void): () => void;
  setDeepLinkConfirmAvailability(
    owner: "overlay" | "studio",
    available: boolean,
  ): void;
  resolveDeepLinkConfirm(result: DeepLinkConfirmResult): void;
  onTerminalData(callback: (key: string, data: string) => void): () => void;
  onTerminalExit(callback: (key: string, exitCode: number) => void): () => void;
  executeBash(
    id: string,
    command: string,
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  cancelBash(id: string): void;
  sendRemote(event: any): void;
  setPermissionMode(
    tabId: string,
    mode: string,
    source?: string,
    planFilePath?: string,
  ): void;
  loadSettings(): Promise<Record<string, any>>;
  saveSettings(data: Record<string, any>): Promise<void>;
  loadTabs(): Promise<PersistedTabState | null>;
  saveTabs(data: PersistedTabState): Promise<void>;
  loadTabContent(
    tabId: string,
  ): Promise<
    import("../shared/types-persistence").ExternalInstanceContent | null
  >;
  saveTabContent(
    tabId: string,
    instanceId: string,
    messages: unknown[],
  ): Promise<void>;
  deleteTabContent(tabId: string): Promise<void>;
  saveSessionLabel(
    sessionId: string,
    customTitle: string | null,
  ): Promise<void>;
  loadSessionLabels(): Promise<Record<string, string>>;
  generateTitle(text: string): Promise<string>;
  loadSessionChains(): Promise<{
    chains: Record<string, string[]>;
    reverse: Record<string, string>;
  }>;
  saveSessionChains(data: {
    chains: Record<string, string[]>;
    reverse: Record<string, string>;
  }): Promise<void>;
  getConversation(
    conversationId: string,
    offset?: number,
    limit?: number,
  ): Promise<{ messages: any[]; total: number; hasMore: boolean }>;
  deleteStoredConversations(sessionIds: string[]): Promise<{ deleted: number }>;
  loadChainHistory(sessionIds: string[]): Promise<SessionLoadMessage[]>;
  loadConversationTranscript(tabId: string): Promise<string>;

  // ─── Conversation backup (export/restore zip archives) ───
  conversationExportPreview(scope: "currently-open" | "all"): Promise<{
    ok: boolean;
    error?: string;
    conversationCount?: number;
    totalUncompressedBytes?: number;
    estimatedCompressedBytes?: number;
    tabCount?: number;
  }>;
  conversationExport(args: {
    scope: "currently-open" | "all";
    destinationPath?: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    destinationPath?: string;
    conversationCount?: number;
    bytesWritten?: number;
  }>;
  conversationRestorePreview(args?: { sourcePath?: string }): Promise<{
    ok: boolean;
    error?: string;
    sourcePath?: string;
    manifest?: {
      version: number;
      createdAt: string;
      createdBy: string;
      ionVersion: string;
      scope: "currently-open" | "all";
      conversationCount: number;
      backendSnapshot?: "api" | "cli";
      hostname: string;
    };
  }>;
  conversationRestore(args: {
    sourcePath: string;
    conflictPolicy?: "skip" | "overwrite" | "rename";
    restoreTabs?: boolean;
  }): Promise<{
    ok: boolean;
    error?: string;
    restored: number;
    skipped: number;
    overwritten: number;
    renamed: number;
    errors: string[];
  }>;
  onConversationBackupProgress(
    callback: (data: { current: number; total: number; label: string }) => void,
  ): () => void;
}
