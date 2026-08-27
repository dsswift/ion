/**
 * session-store-actions — action signatures implemented by the composed Zustand slices.
 *
 * Kept separate from State's data fields so the store contract stays below
 * the TypeScript file-size cap while preserving the existing public types.
 */
import type {
  TabState,
  NormalizedEvent,
  EnrichedError,
  Attachment,
  FileAttachment,
  ImageAttachmentPayload,
  WorktreeProvisionState,
  WorkStage,
  BenchAssembleResult,
  WorktreeMoveResult,
} from "../../shared/types";
import type { AbortScope } from "../../shared/types-engine";
import type { EngineSubmitActions } from "./session-store-engine-submit-actions";
import type {
  GitConflictAlert,
  CloseIntent,
  FileEditorTab,
} from "./session-store-aux-types";

export interface StoreActions extends EngineSubmitActions {
  initStaticInfo: () => Promise<void>;
  setPermissionMode: (mode: "auto" | "plan", source?: string) => void;
  /**
   * The single plan-approval → implementation pipeline (implement-slice.ts):
   * optional unpin, denial-card dismissal, implement divider, per-tab mode
   * flip to 'auto', model split switch, in-progress auto-move, plan read,
   * prompt submit. Owner-executed everywhere — the Studio mirror forwards it.
   */
  implementPlan: (
    tabId: string,
    opts?: { clearContext?: boolean; unpin?: boolean },
  ) => Promise<void>;
  /**
   * Set the per-conversation extended-thinking effort for the active
   * conversation. Isolated per-tab (bare) and per-instance (engine subtab),
   * exactly like setPermissionMode. Applied live on the next prompt — no
   * session restart. 'off' clears thinking for the conversation.
   */
  setThinkingEffort: (
    effort: import("../../shared/types-session").ThinkingEffort,
  ) => void;
  createTab: (useWorktree?: boolean) => Promise<string>;
  createTabInDirectory: (
    dir: string,
    useWorktree?: boolean,
    skipDuplicateCheck?: boolean,
    pinToGroupId?: string,
  ) => Promise<string>;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  /**
   * The pending close request. Every confirm surface reads this one field, so
   * there is exactly one close dialog regardless of which entry point raised it.
   */
  closeIntent: CloseIntent | null;
  /**
   * Ask to close a tab. Resolves the worktree warning (fresh appraisal) and
   * then raises `closeIntent`. This is the ONLY way a close dialog appears —
   * entry points call this rather than opening a dialog themselves.
   */
  requestCloseTab: (tabId: string) => Promise<void>;
  /** Answer the pending close intent: closes the tab. */
  confirmCloseTab: () => void;
  /** Dismiss the pending close intent without closing. */
  cancelCloseTab: () => void;
  reorderTabs: (reorderedTabs: TabState[]) => void;
  renameTab: (tabId: string, customTitle: string | null) => void;
  /** Records a direct picker/remote model choice as explicit user intent. */
  setTabModel: (tabId: string, model: string) => void;
  /** Records a plan/implementation/workflow-selected model without masking slash frontmatter. */
  setTabAutomaticModel: (tabId: string, model: string) => void;
  setTabPillColor: (tabId: string, color: string | null) => void;
  setTabPillIcon: (tabId: string, icon: string | null) => void;
  clearTab: () => void;
  toggleExpanded: () => void;
  toggleTallView: (tabId: string) => void;
  openSettings: (initialTab?: string) => void;
  closeSettings: () => void;
  /** Increment the open floating panel count (call on FloatingPanel mount). */
  incOpenFloatingPanelCount: () => void;
  /** Decrement the open floating panel count (call on FloatingPanel unmount). */
  decOpenFloatingPanelCount: () => void;
  toggleGitPanel: () => void;
  closeGitPanel: () => void;
  /** Toggle the Status Drawer (the ⓘ right-side panel). */
  toggleStatusDrawer: () => void;
  /** Close the Status Drawer and clear the pending dispatch deep-link. */
  closeStatusDrawer: () => void;
  /**
   * Open the Status Drawer and pre-select a specific dispatch for deep-link
   * navigation. The drawer reconstructs the ancestor breadcrumb stack from
   * durable agentStates (dispatchParentId walk) before presenting the panel.
   */
  openDispatchPreview: (dispatchId: string) => void;
  toggleTerminal: (tabId: string) => void;
  runInTerminal: (tabId: string, cmd: string) => void;
  consumeTerminalPendingCommand: (key: string) => string | undefined;
  /** `adoptTabId` is supplied only by boot restoration; see resumeSession. */
  createTerminalTab: (dir?: string, adoptTabId?: string) => Promise<string>;
  addTerminalInstance: (tabId: string, kind: string, cwd?: string) => string;
  removeTerminalInstance: (tabId: string, instanceId: string) => void;
  selectTerminalInstance: (tabId: string, instanceId: string) => void;
  toggleTerminalReadOnly: (tabId: string, instanceId: string) => void;
  toggleTerminalTall: (tabId: string) => void;
  toggleTerminalBigScreen: (tabId: string) => void;
  getOrCreateDedicatedTerminal: (tabId: string, kind: string) => string;
  runQuickTool: (tabId: string, toolId: string) => void;
  renameTerminalInstance: (
    tabId: string,
    instanceId: string,
    label: string,
  ) => void;
  toggleFileExplorer: (tabId: string) => void;
  setFileExplorerExpanded: (
    dir: string,
    path: string,
    expanded: boolean,
  ) => void;
  setFileExplorerSelected: (dir: string, path: string | null) => void;
  collapseAllExplorer: (dir: string) => void;
  toggleFileEditor: (tabId: string) => void;
  focusFileEditor: () => void;
  blurFileEditor: () => void;
  openFileInEditor: (
    dir: string,
    tabId: string,
    filePath: string,
    opts?: { insertAfterActive?: boolean },
  ) => void;
  closeFileEditorTab: (dir: string, fileId: string) => void;
  setActiveEditorFile: (dir: string, fileId: string) => void;
  createScratchFile: (dir: string) => void;
  updateEditorContent: (dir: string, fileId: string, content: string) => void;
  markEditorSaved: (dir: string, fileId: string, filePath: string) => void;
  reorderEditorFiles: (dir: string, reordered: FileEditorTab[]) => void;
  toggleEditorPreview: (dir: string, fileId: string) => void;
  toggleEditorReadOnly: (dir: string, fileId: string) => void;
  setEditorGeometry: (geo: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => void;
  setPlanGeometry: (geo: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => void;
  setResourceViewerGeometry: (geo: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => void;
  setAgentDetailGeometry: (geo: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => void;
  forkTab: (sourceTabId: string) => Promise<string | null>;
  rewindToMessage: (tabId: string, messageId: string) => void;
  forkFromMessage: (tabId: string, messageId: string) => Promise<string | null>;
  /**
   * Open a conversation in a tab.
   *
   * `adoptTabId` is the persisted tab id, supplied ONLY by boot restoration.
   * Restoring under a fresh id orphans everything keyed by the old one — the
   * Studio Surface stores browser and terminal tabs per conversation id, so a
   * new id every launch means the panel comes back empty. The History Picker
   * omits it, because opening a past conversation is a genuinely new tab.
   */
  resumeSession: (
    sessionId: string,
    title?: string,
    projectPath?: string,
    customTitle?: string | null,
    encodedDir?: string | null,
    adoptTabId?: string,
  ) => Promise<string>;
  resumeSessionWithChain: (
    sessionId: string,
    historicalSessionIds: string[],
    title?: string,
    projectPath?: string,
    customTitle?: string | null,
    encodedDir?: string | null,
  ) => Promise<string>;
  /** Load messages for a skeleton tab (messages: null) on demand. Called by selectTab. */
  loadSkeletonMessages: (tabId: string) => Promise<void>;
  /** Re-arm hydration for panes whose history load failed while the engine was down. Called on engine reconnect. */
  rehydrateFailedHistory: () => void;
  addSystemMessage: (content: string) => void;
  startBashCommand: (
    command: string,
    execId: string,
  ) => { toolMsgId: string; tabId: string };
  completeBashCommand: (
    tabId: string,
    toolMsgId: string,
    command: string,
    stdout: string,
    stderr: string,
    exitCode: number | null,
  ) => void;
  /**
   * Unified prompt submit for every conversation tab (plain or extension-backed).
   * The single send path — `submitEnginePrompt` is gone. An extension-backed tab
   * resolves a non-empty `extensions` list from its profile (which the main
   * pipeline routes on and which starts the engine session with those
   * extensions); a plain tab resolves none. Everything else is identical.
   */
  submit: (
    tabId: string,
    text: string,
    opts?: {
      projectPath?: string;
      extraAttachments?: Attachment[];
      appendSystemPrompt?: string;
      implementationPhase?: boolean;
      imageAttachments?: ImageAttachmentPayload[];
      /** Raw attachment metadata forwarded from iOS via REMOTE_ENGINE_PROMPT.
       *  When present, stored on the optimistic user message so InlineMessageImages
       *  renders inline previews and parseAttachmentsFromMessages populates the
       *  attachments panel on the desktop side. */
      remoteAttachments?: Array<{ type: string; name: string; path: string }>;
      source?: "remote" | "machine";
      resolveSlash?: boolean;
    },
  ) => void;
  submitRemotePrompt: (
    tabId: string,
    prompt: string,
    imageAttachments?: ImageAttachmentPayload[],
    resolveSlash?: boolean,
    remoteAttachments?: Array<{ type: string; name: string; path: string }>,
    requestId?: string,
    implementationPhase?: boolean,
  ) => void;
  /**
   * Move a tab to its planning/in-progress group on send, based on the tab's
   * AUTHORITATIVE permission mode (effectivePermissionMode — reads the active
   * instance for every tab type; tab-level permissionMode was removed in WI-002).
   * Shared by sendMessage, submitRemotePrompt, and
   * submit so all send paths (CLI + engine) move consistently.
   * No-op unless autoGroupMovement is on, tabGroupMode is 'manual', and the tab
   * is unpinned. Also cancels any pending done-move for the tab.
   */
  applySendAutoGroupMove: (tabId: string) => void;
  /**
   * Stop a tab's active run. `all` also recalls background dispatches;
   * `orchestrator` leaves them running.
   */
  interrupt: (tabId: string, scope?: AbortScope) => void;
  /** Stop one background dispatch while its orchestrator and siblings run. */
  abortDispatch: (tabId: string, dispatchId: string) => void;
  /**
   * Stop every running dispatch instance represented by one agent row. Each
   * dispatch ID cascades through its own descendant chain; orchestrator and
   * other rows survive.
   */
  abortDispatches: (tabId: string, dispatchIds: string[]) => void;
  submitRemoteBash: (tabId: string, command: string) => void;
  respondPermission: (
    tabId: string,
    questionId: string,
    optionId: string,
  ) => void;
  respondElicitation: (
    tabId: string,
    requestId: string,
    response: Record<string, unknown> | undefined,
    cancelled: boolean,
  ) => void;
  addDirectory: (dir: string) => void;
  removeDirectory: (dir: string) => void;
  setBaseDirectory: (dir: string) => void;
  setupWorktree: (
    tabId: string,
    sourceBranch: string,
    setAsDefault: boolean,
  ) => Promise<void>;
  convertToWorktree: (tabId: string) => Promise<void>;
  cancelWorktreeSetup: (tabId: string) => void;
  /**
   * Rename a conversation AND the worktree it lives in, to the same name.
   *
   * The one path that changes both. Ordinary renames are independent by design
   * (a worktree's topic does not follow every relabelling of a conversation in
   * it), so this exists as an explicit operator verb rather than a heuristic.
   */
  renameTabAndWorktree: (tabId: string, title: string) => Promise<void>;
  finishWorktreeTab: (
    tabId: string,
    strategyOverride?: "merge-ff" | "merge" | "pr",
  ) => Promise<void>;
  addAttachments: (attachments: FileAttachment[]) => void;
  removeAttachment: (attachmentId: string) => void;
  clearAttachments: () => void;
  editQueuedMessage: (tabId: string) => void;
  setDraftInput: (tabId: string, text: string) => void;
  clearPendingInput: (tabId: string) => void;
  handleNormalizedEvent: (tabId: string, event: NormalizedEvent) => void;
  handleStatusChange: (
    tabId: string,
    newStatus: string,
    oldStatus: string,
  ) => void;
  handleError: (tabId: string, error: EnrichedError) => void;
  forceRecoverTab: (tabId: string, reason: string) => void;
  /**
   * Auto-recover a stalled tab WITHOUT user involvement: recreate the engine
   * session in-process (resetTabSession → next prompt re-StartSessions) and
   * resubmit the last user prompt, so a tab the user left running keeps
   * running. Bounded by autoRecoveryAttempts within a rolling window — once the
   * cap is hit it falls back to forceRecoverTab with an honest message. This is
   * the watchdog path; it is distinct from forceRecoverTab (the user-interrupt
   * fallback, which intentionally abandons the run because the user asked to
   * stop). Returns true if an auto-resume was attempted, false if it fell back.
   */
  autoRecoverStuckTab: (tabId: string) => boolean;
  moveTabToGroup: (tabId: string, groupId: string) => void;
  moveTabToGroupAndPin: (tabId: string, groupId: string) => void;
  setTabGroupId: (tabId: string, groupId: string | null) => void;
  toggleTabGroupPin: (tabId: string) => void;
  setWorktreeUncommitted: (tabId: string, hasChanges: boolean) => void;
  refreshWorktreeInventory: (repoPath: string) => Promise<void>;
  /** Seal every existing conversation in a landed worktree for read-only review. */
  sealLandedWorktree: (worktreePath: string) => Promise<void>;
  /**
   * Re-read both worktree surfaces (inventory + bench) for a repo.
   *
   * The pair, named once, for any flow that changes git state a worktree row
   * describes — the row is a join of the two caches, so refreshing one leaves a
   * half-stale row. Never reassembles; refreshing reads, assembly mutates.
   */
  refreshWorkspaceViews: (repoPath: string) => Promise<void>;
  /** Open (or focus) a conversation in an existing worktree. */
  openWorktreeConversation: (worktreePath: string) => Promise<string>;
  /**
   * Create an ADDITIONAL conversation in a worktree, with its worktree metadata
   * attached. Distinct from `openWorktreeConversation`, which focuses or cycles
   * the ones that already exist.
   */
  newWorktreeConversation: (worktreePath: string) => Promise<string>;
  syncWorktree: (
    worktreePath: string,
    sourceBranch: string,
    repoPath: string,
  ) => Promise<{
    ok: boolean;
    error?: string;
    hasConflicts?: boolean;
    refusedDirty?: boolean;
    replayed?: boolean;
  }>;
  /**
   * Phase 1 of the sync-all pipeline: the free mechanical pass over every
   * worktree of the repo. Pauses at `awaiting-ai-confirm` when conflicts
   * survive it — agents cost money, so launching them is the operator's
   * explicit act (confirmWorktreePipelineAi) — and runs straight through to
   * the bench phase when none do. See stores/slices/worktree-pipeline-slice.ts.
   */
  startWorktreePipeline: (
    repoPath: string,
    sourceBranch?: string | null,
  ) => Promise<void>;
  /** The confirm gate's Yes: sequential AI escalation with rerere replay between agents. */
  confirmWorktreePipelineAi: () => Promise<void>;
  /** Stop between steps; never aborts an in-flight rebase or a running agent. */
  cancelWorktreePipeline: () => void;
  /** Clear the finished pipeline banner. */
  dismissWorktreePipeline: () => void;
  /**
   * Retire a worktree, relocating any conversation inside it first so the tab is
   * never left pointed at a deleted directory. Callers must confirm against
   * `gitWorktreeAppraise` before invoking: this forces removal.
   *
   * Returns the full `WorktreeMoveResult` so callers can surface `recoveryRef` —
   * the ref holding any uncommitted work the forced removal preserved. A caller
   * that cannot see it cannot tell the operator where their work went.
   */
  retireWorktree: (
    repoPath: string,
    worktreePath: string,
    branchName: string,
  ) => Promise<WorktreeMoveResult>;
  /** Retire every worktree already sealed by a successful Land. */
  retireLandedWorktrees: (
    repoPath: string,
  ) => Promise<{ ok: boolean; retired: number; error?: string }>;
  /**
   * Re-run provisioning for a worktree whose dependency state looks wrong
   * (missing node_modules, a half-finished install). Same path creation uses.
   */
  reprovisionWorktree: (
    repoPath: string,
    worktreePath: string,
  ) => Promise<{ ok: boolean; state: WorktreeProvisionState; error?: string }>;
  refreshBench: (repoPath: string) => Promise<void>;
  /** Open (or focus) a conversation in the bench worktree. */
  openBenchConversation: (
    repoPath: string,
    sourceBranch: string,
  ) => Promise<string | null>;
  /**
   * Open (or focus) the bench's ONE dedicated terminal tab, building the bench
   * first when its directory is not there. Returns the tab id, or null when the
   * workspace is unknown or the build failed.
   */
  openBenchTerminal: (
    repoPath: string,
    sourceBranch: string,
  ) => Promise<string | null>;
  benchAssemble: (
    repoPath: string,
    sourceBranch: string,
  ) => Promise<BenchAssembleResult>;
  /**
   * Resolve-once: prepare the failed assembly merge in the bench (left in
   * progress for the ConflictsDialog), or reassemble immediately when
   * recordings already cover the conflict. Returns the bench path to open the
   * dialog on, or null when nothing needed resolving / preparation failed.
   */
  benchResolveConflict: (
    repoPath: string,
    sourceBranch: string,
  ) => Promise<string | null>;
  benchRerereCount: (directory: string) => Promise<number>;
  benchRerereForget: (directory: string, paths: string[]) => Promise<number>;
  benchRerereDiscardAll: (directory: string) => Promise<number>;
  /**
   * AI-assisted analysis of a bench verification failure (never a fix — see
   * git-conflict-slice.ts's openConflictAssist for the parallel conflict-fix
   * flow this deliberately does NOT mirror on mode). ONE forwarded action:
   * materialises the failing tree back into the bench, then opens a
   * plan-mode, input-locked conversation there whose only job is to name
   * whether the failure is a poisoned recording or a genuine cross-member
   * incompatibility. Throws with a remediation message when the `standard`
   * model tier is not configured, or when the diagnostic tree could not be
   * rebuilt (the bench state moved since the failure).
   */
  openBenchVerificationAnalysis: (
    repoPath: string,
    sourceBranch: string,
  ) => Promise<string>;
  /**
   * The bench-verification recovery dialog's targeted discard: forget the
   * named suspect branches' recordings, then reassemble.
   */
  benchDiscardMemberRecordings: (
    repoPath: string,
    sourceBranch: string,
    branchNames: string[],
  ) => Promise<
    BenchAssembleResult & {
      forgottenCount?: number;
      branchesWithNothingToForget?: string[];
    }
  >;
  benchUpdateMember: (
    repoPath: string,
    sourceBranch: string,
    worktreePath: string,
  ) => Promise<BenchAssembleResult>;
  benchUpdateAll: (
    repoPath: string,
    sourceBranch: string,
  ) => Promise<BenchAssembleResult>;
  /** Apply a confirmed overlap fast lane atomically, without assembling it. */
  benchApplyOverlapFastLane: (
    repoPath: string,
    sourceBranch: string,
    basis: import("../../shared/types-worktree-overlap").WorktreeOverlapBasis,
    orderedPaths: string[],
  ) => Promise<
    import("../../shared/types-worktree-overlap").WorktreeOverlapApplyResult
  >;
  benchAddMember: (
    repoPath: string,
    sourceBranch: string,
    worktreePath: string,
    branchName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  benchRemoveMember: (
    repoPath: string,
    sourceBranch: string,
    worktreePath: string,
  ) => Promise<void>;
  benchSetEnabled: (
    repoPath: string,
    sourceBranch: string,
    worktreePath: string,
    enabled: boolean,
  ) => Promise<void>;
  /** Set or clear the operator's workflow stage on a worktree. `null` clears. */
  setWorktreeStage: (
    repoPath: string,
    worktreePath: string,
    stage: WorkStage | null,
  ) => Promise<void>;
  /**
   * @deprecated Compatibility shim over `setWorktreeStage` for call sites that
   * predate the work-stage system (`good` → `verified`, `issue` → `bug`,
   * `null` clears; `sourceBranch` ignored — stages are worktree-scoped).
   * Removable once every sibling branch has migrated to `setWorktreeStage`:
   * wt/ion-98d550f3, wt/ion-d2101138, wt/ion-c151d648, wt/ion-02804dd4.
   */
  benchSetReview: (
    repoPath: string,
    sourceBranch: string,
    worktreePath: string,
    review: "good" | "issue" | null,
  ) => Promise<void>;
  benchSetOrder: (
    repoPath: string,
    sourceBranch: string,
    worktreePath: string,
    toIndex: number,
  ) => Promise<void>;
  /** Dismiss the absorbed-into-base notice for one workspace. */
  clearBenchRetired: (repoPath: string, sourceBranch: string) => void;
  /** Record a conflicted directory (sync/land failure or detected mid-operation). */
  recordConflictAlert: (
    directory: string,
    alert: Omit<GitConflictAlert, "dismissed" | "recordedAt">,
  ) => void;
  /** Drop a directory's conflict alert — its operation completed or aborted. */
  clearConflictAlert: (directory: string) => void;
  /** Hide the toast for a directory; the badge stays until actually resolved. */
  dismissConflictAlert: (directory: string) => void;
  /** Open (or focus) a conversation in the conflicted directory and submit the assist prompt. */
  openConflictAssist: (directory: string) => Promise<string>;
  /**
   * Unified tab + engine-instance creation entry point (Phase 2, #256).
   * Both plain and engine tabs are created through this path. The extension
   * list (resolved from opts.profileId if absent) is the only variable:
   *   - non-empty extensions => engine tab (tabHasExtensions=true)
   *   - absent/empty          => plain tab (tabHasExtensions=false)
   * Returns the new tab id (async: obtains a real engine-backed id from main).
   */
  createConversationTab: (
    dir: string,
    opts?: import("./slices/engine-slice-create").CreateConversationTabOpts,
  ) => Promise<string>;
  respondEngineDialog: (tabId: string, dialogId: string, value: any) => void;
  /**
   * Create the single engine instance for a tab (single-instance-per-tab
   * model, conversation unification #256 phase 1). Returns the existing
   * instance id if one already exists (no-op guard).
   */
  addEngineInstance: (tabId: string) => string;
  /**
   * Reset an engine instance's conversation to a fresh state without
   * removing the instance itself. Wipes the per-instance message
   * buffer, status, agent-state, working message, notifications,
   * dialogs, usage, permission-denied, pinned prompt, and model-override
   * Maps. Seeds a fresh "Session started" divider. Used by the iOS
   * "Implement, clear context" flow for engine tabs.
   */
  resetEngineInstance: (tabId: string, instanceId: string) => void;
  /**
   * Rewind an engine instance to a previous user message. Truncates messages
   * to before the target, tears down the running session, and pre-fills the
   * input bar with the target message's text. Prior conversation context is
   * injected as a system prompt on the next send (one-shot).
   */
  rewindEngineInstance: (
    tabId: string,
    instanceId: string,
    messageId: string,
    userTurnIndex?: number,
  ) => void;
}
