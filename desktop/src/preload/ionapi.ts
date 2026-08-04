/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type { AtvApi } from './atv-api'
import type { RunOptions, NormalizedEvent, HealthReport, EnrichedError, FileAttachment, SessionMeta, SessionLoadMessage, GitGraphData, GitChangesData, GitBranchInfo, GitCommitDetail, PersistedTabState, FsEntry, WorktreeInfo, WorktreeStatus, LandResult, WorktreeMoveResult, WorktreeInventoryEntry, WorktreeAppraisalWire, WorktreeProvisionState, IntegrationWorkspace, BenchAssembleResult, EngineConfig, EngineEvent, EngineHostInfo, EngineDirListing, RemoteTransportState, DiscoveredCommand, GitEvent, RepoSnapshot, NewConversationDefaultsPolicy } from '../shared/types'
import type { EnterprisePolicy } from '../shared/types-engine'
import type { CustomThemeForRenderer } from '../shared/theme-pack-types'

export interface IonAPI extends AtvApi {
  // ─── Request-response (renderer → main) ───
  start(): Promise<{ version: string; auth: { email?: string; subscriptionType?: string; authMethod?: string }; mcpServers: string[]; projectPath: string; homePath: string }>
  createTab(): Promise<{ tabId: string }>
  adoptTab(tabId: string): Promise<{ tabId: string }>
  prompt(tabId: string, requestId: string, options: RunOptions): Promise<void>
  cancel(requestId: string): Promise<boolean>
  steer(tabId: string, message: string): void
  stopTab(tabId: string): Promise<boolean>
  retry(tabId: string, requestId: string, options: RunOptions): Promise<void>
  status(): Promise<HealthReport>
  tabHealth(): Promise<HealthReport>
  closeTab(tabId: string): Promise<void>
  /**
   * Fire-and-forget notification to the main process that a tab field changed.
   * Main pushes a desktop_tab_meta delta to iOS immediately (no poll wait).
   */
  tabMetaChanged(payload: { tabId: string; title?: string; runCostUsd?: number; totalCostUsd?: number; groupId?: string | null }): void
  /**
   * Fire-and-forget push of the renderer's remote tab-state projection
   * (renderer-push snapshot architecture). The OWNER renderer calls this on
   * store change (debounced ~250 ms); the main process caches the payload and
   * getRemoteTabStates() serves the cache. See
   * renderer/stores/remote-projection-push.ts.
   */
  pushRemoteTabStates(payload: import('../shared/remote-projection-types').RemoteTabStatesPayload): void
  selectDirectory(): Promise<string | null>
  selectExtensionFiles(): Promise<string[] | null>
  getEngineHostInfo(): Promise<{ ok: boolean; error?: string; data?: EngineHostInfo }>
  listEngineDirectory(path: string, showHidden: boolean): Promise<{ ok: boolean; error?: string; data?: EngineDirListing }>
  engineIsRemote(): Promise<boolean>
  /** Fetch the enterprise new-tab policy from the engine. Returns null when no enterprise config is active. */
  getEnterprisePolicy(): Promise<NewConversationDefaultsPolicy | null>
  /** Fetch the full enterprise policy blob (D-004). Returns null when no enterprise config is active. */
  getEnterprisePolicyFull(): Promise<EnterprisePolicy | null>
  /** Custom theme packs installed on disk (desktop components, resolved with inline asset data URLs). */
  listCustomThemes(): Promise<CustomThemeForRenderer[]>
  openExternal(url: string): Promise<boolean>
  /** Main-process-cached site favicon as a data: URL (null = unavailable;
   * renderer falls back to its Globe glyph). */
  getFavicon(host: string): Promise<string | null>
  /** iOS asked to open (or focus) a conversation in a worktree. */
  onRemoteOpenWorktreeConversation(callback: (arg: { worktreePath: string; newConversation: boolean }) => void): () => void
  /** iOS asked to open (or focus) a conversation in the integration bench. */
  onRemoteOpenBenchConversation(callback: (arg: { repoPath: string; sourceBranch: string }) => void): () => void
  /** iOS asked to open (or focus) the integration bench's dedicated terminal. */
  onRemoteOpenBenchTerminal(callback: (arg: { repoPath: string; sourceBranch: string }) => void): () => void
  /** A worktree was named (generated or renamed). Both windows re-read the row. */
  onWorktreeTitled(callback: (arg: { repoPath: string; worktreePath: string; title: string }) => void): () => void
  /** Reveal a directory in the OS file manager. */
  revealPath(path: string): Promise<boolean>

  attachFiles(): Promise<FileAttachment[] | null>
  attachFileByPath(path: string): Promise<FileAttachment | null>
  takeScreenshot(): Promise<FileAttachment | null>
  pasteImage(dataUrl: string): Promise<FileAttachment | null>
  transcribeAudio(audioBase64: string): Promise<{ error: string | null; transcript: string | null }>
  getDiagnostics(): Promise<any>
  respondPermission(tabId: string, questionId: string, optionId: string): Promise<boolean>
  respondElicitation(tabId: string, requestId: string, response: Record<string, unknown> | undefined, cancelled: boolean): Promise<boolean>
  approveDeniedTools(tabId: string, toolNames: string[]): Promise<boolean>
  initSession(tabId: string): void
  ensureEngineSession(args: { tabId: string; workingDirectory: string; conversationId?: string | null; permissionMode?: 'auto' | 'plan' }): Promise<{ ok: boolean; error?: string; conversationId?: string }>
  resetTabSession(tabId: string): void
  restartTabSession(tabId: string): void
  /**
   * Move a live conversation to a new working directory, preserving its
   * conversationId and history. Lets a conversation outlive its worktree.
   */
  relocateTabSession(tabId: string, workingDirectory: string): Promise<{ ok: boolean; conversationId?: string; error?: string }>
  listSessions(projectPath?: string): Promise<SessionMeta[]>
  listAllSessions(): Promise<SessionMeta[]>
  loadSession(sessionId: string, projectPath?: string, encodedDir?: string): Promise<SessionLoadMessage[]>
  conversationExists(sessionId: string): Promise<boolean>
  readPlan(filePath: string): Promise<{ content: string | null; fileName: string | null }>
  readImageDataUrl(filePath: string): Promise<{ dataUrl: string | null }>
  discoverCommands(projectPath: string): Promise<DiscoveredCommand[]>
  listFonts(): Promise<string[]>
  terminalCreate(key: string, cwd: string): Promise<void>
  terminalWrite(key: string, data: string): void
  terminalResize(key: string, cols: number, rows: number): void
  terminalDestroy(key: string): Promise<void>
  onTerminalData(callback: (key: string, data: string) => void): () => void
  onTerminalExit(callback: (key: string, exitCode: number) => void): () => void
  executeBash(id: string, command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  cancelBash(id: string): void
  sendRemote(event: any): void
  setPermissionMode(tabId: string, mode: string, source?: string, planFilePath?: string): void
  loadSettings(): Promise<Record<string, any>>
  saveSettings(data: Record<string, any>): Promise<void>
  loadTabs(): Promise<PersistedTabState | null>
  saveTabs(data: PersistedTabState): Promise<void>
  loadTabContent(tabId: string): Promise<import('../shared/types-persistence').ExternalInstanceContent | null>
  saveTabContent(tabId: string, instanceId: string, messages: unknown[]): Promise<void>
  deleteTabContent(tabId: string): Promise<void>
  saveSessionLabel(sessionId: string, customTitle: string | null): Promise<void>
  loadSessionLabels(): Promise<Record<string, string>>
  generateTitle(text: string): Promise<string>
  loadSessionChains(): Promise<{ chains: Record<string, string[]>; reverse: Record<string, string> }>
  saveSessionChains(data: { chains: Record<string, string[]>; reverse: Record<string, string> }): Promise<void>
  getConversation(conversationId: string, offset?: number, limit?: number): Promise<{ messages: any[]; total: number; hasMore: boolean }>
  loadChainHistory(sessionIds: string[]): Promise<SessionLoadMessage[]>

  // ─── Conversation backup (export/restore zip archives) ───
  conversationExportPreview(scope: 'currently-open' | 'all'): Promise<{ ok: boolean; error?: string; conversationCount?: number; totalUncompressedBytes?: number; estimatedCompressedBytes?: number; tabCount?: number }>
  conversationExport(args: { scope: 'currently-open' | 'all'; destinationPath?: string }): Promise<{ ok: boolean; error?: string; destinationPath?: string; conversationCount?: number; bytesWritten?: number }>
  conversationRestorePreview(args?: { sourcePath?: string }): Promise<{ ok: boolean; error?: string; sourcePath?: string; manifest?: { version: number; createdAt: string; createdBy: string; ionVersion: string; scope: 'currently-open' | 'all'; conversationCount: number; backendSnapshot?: 'api' | 'cli'; hostname: string } }>
  conversationRestore(args: { sourcePath: string; conflictPolicy?: 'skip' | 'overwrite' | 'rename'; restoreTabs?: boolean }): Promise<{ ok: boolean; error?: string; restored: number; skipped: number; overwritten: number; renamed: number; errors: string[] }>
  onConversationBackupProgress(callback: (data: { current: number; total: number; label: string }) => void): () => void
  // ─── Git operations ───
  gitIsRepo(directory: string): Promise<{ isRepo: boolean }>
  gitGraph(directory: string, skip?: number, limit?: number, search?: string, author?: string, extra?: { path?: string; refKind?: string; dateAfter?: string; dateBefore?: string }): Promise<GitGraphData>
  gitChanges(directory: string): Promise<GitChangesData>
  gitCommit(directory: string, message: string, opts?: { amend?: boolean; signoff?: boolean; gpg?: boolean } | boolean): Promise<{ ok: boolean; error?: string }>
  gitFetch(directory: string): Promise<{ ok: boolean; error?: string }>
  gitPull(directory: string): Promise<{ ok: boolean; error?: string }>
  gitPush(directory: string): Promise<{ ok: boolean; error?: string }>
  gitBranches(directory: string): Promise<{ branches: GitBranchInfo[]; current: string }>
  gitCheckout(directory: string, branch: string): Promise<{ ok: boolean; error?: string }>
  gitCreateBranch(directory: string, name: string): Promise<{ ok: boolean; error?: string }>
  gitDiff(directory: string, path: string, staged: boolean): Promise<{ diff: string; fileName: string }>
  gitStage(directory: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  gitUnstage(directory: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  gitDiscard(directory: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  gitDeleteBranch(directory: string, branch: string): Promise<{ ok: boolean; error?: string }>
  gitCommitDetail(directory: string, hash: string): Promise<GitCommitDetail>
  gitCommitFiles(directory: string, hash: string): Promise<{ files: Array<{ path: string; status: string; oldPath?: string }> }>
  gitCommitFileDiff(directory: string, hash: string, path: string): Promise<{ diff: string; fileName: string }>
  gitIgnoredFiles(directory: string): Promise<{ paths: string[] }>
  gitStashList(directory: string): Promise<{ stashes: Array<{ ref: string; message: string; date: string; parentSha?: string }> }>
  gitStashSave(directory: string, message?: string): Promise<{ ok: boolean; error?: string }>
  gitStashPop(directory: string, ref?: string): Promise<{ ok: boolean; error?: string }>
  gitStashDrop(directory: string, ref: string): Promise<{ ok: boolean; error?: string }>
  gitCherryPick(directory: string, hash: string): Promise<{ ok: boolean; error?: string }>
  gitRevert(directory: string, hash: string): Promise<{ ok: boolean; error?: string }>
  gitReset(directory: string, hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<{ ok: boolean; error?: string }>
  gitBlame(directory: string, path: string): Promise<{ lines: Array<{ hash: string; author: string; date: string; lineNo: number; content: string }>; ok: boolean; error?: string }>
  gitResolveConflict(directory: string, path: string, content: string): Promise<{ ok: boolean; error?: string }>
  gitRebaseTodo(directory: string, onto: string): Promise<{ commits: Array<{ hash: string; subject: string; action: string }>; ok: boolean; error?: string }>
  gitRebaseExec(directory: string, onto: string, commits: Array<{ hash: string; action: string }>): Promise<{ ok: boolean; error?: string }>
  gitRebaseAbort(directory: string): Promise<{ ok: boolean; error?: string }>
  gitRebaseContinue(directory: string): Promise<{ ok: boolean; error?: string }>
  gitOpState(directory: string): Promise<{
    ok: boolean
    error?: string
    state?: 'rebasing' | 'merging' | 'cherry-picking' | null
    branch?: string | null
    onto?: string | null
    oursLabel?: string
    theirsLabel?: string
    files?: Array<{ path: string; shape: string; hasBase: boolean; hasOurs: boolean; hasTheirs: boolean }>
  }>
  gitConflictStages(directory: string, path: string): Promise<{
    ok: boolean
    error?: string
    base?: string | null
    ours?: string | null
    theirs?: string | null
    oursLabel?: string
    theirsLabel?: string
  }>
  gitConflictAccept(directory: string, path: string, side: 'ours' | 'theirs'): Promise<{ ok: boolean; error?: string }>
  gitSubscribe(directory: string): Promise<{ snapshot: RepoSnapshot | null }>
  gitUnsubscribe(directory: string): Promise<{ ok: boolean }>
  gitRefresh(directory: string): Promise<{ ok: boolean }>
  gitApplyPatch(directory: string, patch: string, opts?: { reverse?: boolean; cached?: boolean }): Promise<{ ok: boolean; error?: string }>
  gitTagCreate(directory: string, name: string, ref?: string, message?: string): Promise<{ ok: boolean; error?: string }>
  gitShowFile(directory: string, hash: string, path: string): Promise<{ ok: boolean; content: string; error?: string }>
  gitCommitSignature(directory: string, hash: string): Promise<{ ok: boolean; status?: string; signer?: string; key?: string; error?: string }>
  gitRecentRefs(directory: string, limit?: number): Promise<{ ok: boolean; refs: string[]; error?: string }>
  onGitEvent(callback: (event: GitEvent) => void): () => void

  // ─── Git worktree operations ───
  gitWorktreeAdd(repoPath: string, sourceBranch: string): Promise<{ ok: boolean; worktree?: WorktreeInfo; error?: string }>
  gitWorktreeRemove(repoPath: string, worktreePath: string, branchName: string, force?: boolean): Promise<{ ok: boolean; error?: string }>
  gitWorktreeList(repoPath: string): Promise<{ worktrees: Array<{ path: string; branch: string; head: string }> }>
  gitWorktreeStatus(worktreePath: string, sourceBranch: string): Promise<WorktreeStatus>
  gitWorktreeMerge(repoPath: string, worktreeBranch: string, sourceBranch: string, noFf?: boolean): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean }>
  gitWorktreePush(worktreePath: string, sourceBranch: string): Promise<{ ok: boolean; error?: string; remoteBranch?: string; remoteUrl?: string }>
  gitWorktreeRebase(worktreePath: string, sourceBranch: string): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean }>
  /**
   * Worktree lifecycle verbs. `land` integrates repeatably without clobbering
   * a checkout; `retire` and `reattach` return the directory the caller should
   * relocate the conversation into (see relocateTabSession).
   */
  gitWorktreeLand(args: { repoPath: string; worktreePath: string; worktreeBranch: string; sourceBranch: string; noFf?: boolean; syncFirst?: boolean; requireFastForward?: boolean }): Promise<LandResult>
  gitWorktreeSync(worktreePath: string, sourceBranch: string): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean; refusedDirty?: boolean }>
  /** Every managed worktree for a repo, with state for describing and acting on it. */
  gitWorktreeInventory(repoPath: string): Promise<{ worktrees: WorktreeInventoryEntry[] }>
  /**
   * Seed a worktree's name with a title the renderer already generated for the
   * conversation running inside it.
   *
   * A recording, not a generation — the string is produced once, by the tab
   * titling path, so the two names cannot diverge. Fire-and-forget from the
   * renderer's point of view: the main process decides whether the directory is
   * a worktree at all and whether it is already named (first prompt wins), and
   * the answer comes back as a no-op reason.
   */
  gitWorktreeSeedTitle(worktreePath: string, title: string): Promise<{
    ok: boolean
    title?: string
    reason?: 'empty-input' | 'not-a-worktree' | 'already-titled'
  }>
  /** Operator override for a worktree's title. */
  gitWorktreeSetTitle(args: { worktreePath: string; repoPath?: string; title: string }): Promise<{ ok: boolean; title?: string; error?: string }>
  /** What would be lost if this worktree were removed right now. */
  gitWorktreeAppraise(worktreePath: string, sourceBranch: string): Promise<WorktreeAppraisalWire>
  // ── Integration workspace (the bench) ──
  benchList(repoPath: string): Promise<{ workspaces: IntegrationWorkspace[]; tips: Record<string, string> }>
  benchEnsure(repoPath: string, sourceBranch: string): Promise<{ workspace: IntegrationWorkspace }>
  benchAddMember(args: { repoPath: string; sourceBranch: string; worktreePath: string; branchName: string }): Promise<{ ok: boolean; error?: string; workspace?: IntegrationWorkspace }>
  benchRemoveMember(args: { repoPath: string; sourceBranch: string; worktreePath: string }): Promise<{ workspace: IntegrationWorkspace | null }>
  benchSetEnabled(args: { repoPath: string; sourceBranch: string; worktreePath: string; enabled: boolean }): Promise<{ workspace: IntegrationWorkspace | null }>
  /**
   * The registry's record for a worktree. The authoritative answer for which
   * repo owns it -- never derive that from the renderer's inventory cache, which
   * is keyed by whatever path the panel last queried.
   */
  gitWorktreeRegistration(worktreePath: string): Promise<{
    registration: { repoPath: string; branchName: string; sourceBranch: string | null; title: string | null } | null
  }>
  benchSetReview(args: { repoPath: string; sourceBranch: string; worktreePath: string; review: 'good' | 'issue' | null }): Promise<{ workspace: IntegrationWorkspace | null }>
  benchSetOrder(args: { repoPath: string; sourceBranch: string; worktreePath: string; toIndex: number }): Promise<{ workspace: IntegrationWorkspace | null }>
  benchUpdateMember(args: { repoPath: string; sourceBranch: string; worktreePath: string }): Promise<BenchAssembleResult>
  benchUpdateAll(repoPath: string, sourceBranch: string): Promise<BenchAssembleResult>
  benchAssemble(repoPath: string, sourceBranch: string): Promise<BenchAssembleResult>
  /**
   * Re-create the failed assembly merge in the bench and leave it in progress
   * so the ConflictsDialog can resolve it once (rerere records the resolution).
   * `branchName` names the conflicted member when a merge was left open;
   * absent when everything now merges cleanly (recordings already cover it).
   */
  benchResolveConflict(repoPath: string, sourceBranch: string): Promise<{ ok: boolean; benchPath?: string; branchName?: string; error?: string }>
  benchRerereCount(directory: string): Promise<{ ok: boolean; count: number; error?: string }>
  benchRerereForget(directory: string, paths: string[]): Promise<{ ok: boolean; count: number; error?: string }>
  benchRerereDiscardAll(directory: string): Promise<{ ok: boolean; count: number; error?: string }>
  benchRefreshStaleness(repoPath: string, sourceBranch: string): Promise<{ workspace: IntegrationWorkspace | null }>
  /** Base staleness: has the feature branch moved ahead of this worktree? */
  gitWorktreeBaseStatus(worktreePath: string, sourceBranch: string): Promise<{ behindCount: number; behindSubjects: string[]; needsSync: boolean; hasUncommittedChanges: boolean; appraisalFailed?: boolean }>
  gitWorktreeRetire(args: { repoPath: string; worktreePath: string; branchName: string; force?: boolean }): Promise<WorktreeMoveResult>
  /**
   * Re-run provisioning for a worktree whose dependency state looks wrong.
   * Same code path as creation, so a repair cannot drift from a fresh provision.
   */
  gitWorktreeReprovision(args: { repoPath: string; worktreePath: string }): Promise<{ ok: boolean; state: WorktreeProvisionState; error?: string }>
  gitWorktreeReattach(args: { repoPath: string; sourceBranch: string; title?: string }): Promise<WorktreeMoveResult>

  // ─── Filesystem operations ───
  fsReadDir(directory: string): Promise<{ entries: FsEntry[]; error?: string }>
  fsReadFile(filePath: string): Promise<{ content: string | null; error?: string }>
  fsWriteFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }>
  fsCreateDir(dirPath: string): Promise<{ ok: boolean; error?: string }>
  fsCreateFile(filePath: string): Promise<{ ok: boolean; error?: string }>
  fsRename(oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }>
  fsDelete(targetPath: string): Promise<{ ok: boolean; error?: string }>
  fsSaveDialog(defaultPath?: string): Promise<{ filePath: string | null }>
  fsRevealInFinder(targetPath: string): Promise<void>
  fsOpenNative(targetPath: string): Promise<{ ok: boolean; error?: string }>
  fsExists(targetPath: string): Promise<{ exists: boolean }>
  fsWatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>
  fsUnwatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>
  onFileChanged(callback: (filePath: string) => void): () => void

  // ─── Engine operations ───
  engineStart(key: string, config: EngineConfig): Promise<{ ok: boolean; error?: string; conversationId?: string }>
  engineSetPlanMode(key: string, enabled: boolean, planFilePath?: string): void
  engineAbort(key: string): Promise<void>
  engineAbortAgent(key: string, agentName: string, subtree: boolean): Promise<void>
  engineDialogResponse(key: string, dialogId: string, value: any): Promise<void>
  engineCommand(key: string, command: string, args: string): Promise<void>
  engineStop(key: string): Promise<void>
  /** Tree-native rewind: move the conversation leaf to the PARENT of the
   *  given entry so the next prompt replaces it on the active path (a new
   *  sibling branch) instead of appending a duplicate after the old leaf.
   *  Rejects when the session/entry is unknown. */
  engineBranchBefore(key: string, entryId: string): Promise<void>
  /** Ordinal-addressed tree-native rewind: the engine resolves the 0-based
   *  user-turn ordinal against its own tree, moves the leaf to before that turn,
   *  and restores plan-file continuity, so the next prompt replaces the turn on
   *  a fresh branch with no duplicate. Resolves with {ok,error?}; ok=false when
   *  the ordinal is out of range or the session is unknown. */
  engineRewind(key: string, userTurnIndex: number): Promise<{ ok: boolean; error?: string }>
  /** Fire get_context_breakdown for the given engine key. Fire-and-forget:
   *  the engine emits engine_context_breakdown on its event bus; the renderer
   *  observes the result via the existing context_breakdown normalized event. */
  engineGetContextBreakdown(key: string): Promise<void>
  /** Read the plan-mode Bash allowlist (engine policy) from engine.json's
   *  limits.planModeAllowedBashCommands. Returns the command-prefix list;
   *  empty when unset (Bash blocked in plan mode). */
  getPlanBashAllowlist(): Promise<string[]>
  /** Write the plan-mode Bash allowlist to engine.json. The engine re-reads
   *  it fresh at the next dispatch, so the change takes effect on the next
   *  prompt with no daemon restart. */
  setPlanBashAllowlist(cmds: string[]): Promise<void>
  engineRemapSession(oldKey: string, newKey: string): Promise<void>
  /** Broadcast a fresh engine_conversation_history for tabId/instanceId to all
   *  connected remote devices. Called by the renderer after a rewind restart so
   *  iOS replaces its now-stale truncated message list immediately. */
  engineBroadcastHistory(tabId: string, instanceId: string | null): Promise<void>
  /** Notify the main process that the user focused a tab. The main
   *  process publishes the session key as a desktop.focus resource so
   *  extensions can route to the active session. */
  notifyTabFocus(tabId: string, engineProfileId?: string | null): void
  /** Publish a mark_read delta for a resource. Propagates the read state to
   *  all subscribers (including iOS) via the engine's resource broker. */
  markResourceRead(kind: string, resourceId: string): void
  /** Get persisted read resource IDs from the main process. */
  getReadResourceIds(): Promise<string[]>
  /** Get persisted resources from disk (cold-load fallback). */
  getPersistedResources(): Promise<Array<{ id: string; kind: string; title?: string; content: string; createdAt: string; conversationId?: string; metadata?: Record<string, unknown>; read?: boolean }>>
  /** Publish a delete op for a resource. Removes the item from all
   *  subscribers (including iOS) via the engine's resource broker. */
  publishResourceDelete(kind: string, resourceId: string): void
  /** Fetch a single resource item's full content on demand by kind + id.
   *  The engine calls the registered producer's query handler and emits
   *  engine_resource_item, which the event-wiring layer broadcasts to the
   *  renderer as resource_item. The call resolves once the command completes;
   *  the item itself arrives via the event stream. Use resourceGlobal:true for
   *  workspace-scoped items (briefings, global notifications). */
  resourceGet(kind: string, id: string, opts?: { sessionKey?: string; global?: boolean }): Promise<void>
  onEngineEvent(callback: (key: string, event: EngineEvent) => void): () => void

  // ─── Plugin management ───
  /** Install a Claude Code-compatible plugin from a GitHub source ("owner/repo"). */
  pluginInstall(source: string): Promise<{ ok: boolean; error?: string; data?: { name: string; source: string; version: string } }>
  /** List all installed plugins. */
  pluginList(): Promise<{ ok: boolean; error?: string; data?: Array<{ name: string; source: string; version: string; installedAt: string }> }>
  /** Remove an installed plugin by name. */
  pluginRemove(name: string): Promise<{ ok: boolean; error?: string; data?: { removed: string } }>

  // ─── MCP server administration ───
  /** List configured MCP servers with their connection and authorization state. */
  mcpList(): Promise<{ ok: boolean; servers?: import('../shared/types-engine-event').McpServerStatus[]; error?: string }>
  /** Add an MCP server. Omitting `transport` lets the engine infer it: a url
   *  means http, a command means stdio. */
  mcpAdd(request: {
    name: string
    transport?: string
    url?: string
    command?: string
    args?: string[]
    headers?: Record<string, string>
    env?: Record<string, string>
  }): Promise<{ ok: boolean; error?: string }>
  /** Remove a server and its stored credentials. */
  mcpRemove(name: string): Promise<{ ok: boolean; error?: string }>
  /** Authorize a server via OAuth. Opens the system browser and resolves only
   *  after the operator completes the flow (or it times out), so callers must
   *  keep their pending UI state until it settles. */
  mcpLogin(name: string, scope?: string): Promise<{ ok: boolean; authorizationUrl?: string; error?: string }>
  /** Drop a server's stored credentials, leaving its configuration in place. */
  mcpLogout(name: string): Promise<{ ok: boolean; error?: string }>

  // ─── Model & provider management ───
  listModels(): Promise<{ models: import('../shared/types-models').ModelEntry[]; providers: import('../shared/types-models').ProviderEntry[] }>
  resolveModelTier(tier: string): Promise<{ tier: string; model: string; fallbacks: string[]; configured: boolean }>
  storeCredential(provider: string, credential: string): Promise<{ ok: boolean; error?: string }>
  refreshModels(provider?: string): Promise<{ ok: boolean; error?: string }>

  // ─── Delegated-CLI provider auth (codex/claude-code/grok/cursor) ───
  providerLogin(provider: string): Promise<{ ok: boolean; error?: string }>
  providerLoginCancel(provider: string): Promise<{ ok: boolean; error?: string }>
  /** Return a browser-issued auth code to a login parked on await_auth_code. */
  providerLoginCode(provider: string, code: string): Promise<{ ok: boolean; error?: string }>
  providerLogout(provider: string): Promise<{ ok: boolean; error?: string }>
  onProviderLoginEvent(handler: (update: import('../shared/types-engine-event').ProviderLoginUpdate) => void): () => void

  // ─── OAuth ───
  startOAuth(provider: string): Promise<{ ok: boolean; error?: string }>
  logoutOAuth(provider: string): Promise<{ ok: boolean }>
  oauthStatus(provider: string): Promise<{ hasTokens: boolean }>
  oauthDeviceCode(provider: string): Promise<{ ok: boolean; userCode?: string; verificationUri?: string; deviceCode?: string; interval?: number; expiresIn?: number; error?: string }>
  oauthDevicePoll(deviceCode: string, interval: number, expiresIn: number): Promise<{ ok: boolean; error?: string }>

  // ─── Entra OIDC (Feature 0001 Part F — telemetry auth) ───
  entraSignIn(): Promise<{ ok: boolean; identity?: { user: string; username: string; displayName: string; oid: string }; error?: string }>
  entraSignOut(): Promise<{ ok: boolean; error?: string }>
  entraIdentity(): Promise<{ identity: { user: string; username: string; displayName: string; oid: string } | null }>

  // ─── Remote control ───
  remoteGetState(): Promise<{ transportState: RemoteTransportState } | null>
  remoteGetMessages(tabId: string): Promise<any[]>
  remoteStartPairing(): Promise<string | null>
  remoteCancelPairing(): void
  remoteRevokeDevice(deviceId: string): void
  remoteDiscoverRelays(): Promise<Array<{ id: string; name: string; host: string; port: number; addresses: string[] }>>
  remoteStopDiscovery(): void
  remoteTestRelay(relayUrl: string, relayApiKey: string): Promise<{ success: boolean; error?: string }>
  /** Probe the relay's auth config without connecting (returns null on failure). */
  remoteRelayAuthConfig(relayUrl: string): Promise<{ oidc: boolean; issuer: string; audience: string; requiredScope: string; psk: boolean } | null>
  remoteSetLanDisabled(disabled: boolean): Promise<void>
  /** Set the per-desktop display name/icon override. Returns the value now stored. */
  remoteSetDisplay(customName: string | null, customIcon: string | null): Promise<{ customName: string | null; customIcon: string | null; updatedAt: number }>
  /** Read the current per-desktop display override (null when unset). */
  remoteGetDisplay(): Promise<{ customName: string | null; customIcon: string | null; updatedAt: number } | null>
  on(channel: string, callback: (...args: any[]) => void): void
  off(channel: string, callback: (...args: any[]) => void): void

  // ─── Auto-update ───
  installUpdate(): void
  onUpdateDownloaded(callback: (info: { version: string }) => void): () => void

  // ─── Renderer logging bridge ───
  /** Write a structured log line from renderer context. The main process
   *  stamps component=desktop and forwards to the shared desktop logger. */
  logWrite(level: string, tag: string, msg: string, fields?: Record<string, unknown>): void

  // ─── Window management ───
  resizeHeight(height: number): void
  setWindowWidth(width: number): void
  animateHeight(from: number, to: number, durationMs: number): Promise<void>
  hideWindow(): void
  isVisible(): Promise<boolean>
  /** OS-level click-through for transparent window regions */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void

  // ─── Event listeners (main → renderer) ───
  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onTabStatusChange(callback: (tabId: string, newStatus: string, oldStatus: string) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
  onSkillStatus(callback: (status: { name: string; state: string; error?: string; reason?: string }) => void): () => void
  onWindowShown(callback: () => void): () => void
  onShowSettings(callback: () => void): () => void
}
