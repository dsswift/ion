/**
 * studio-mirror-actions — the classification contract of the mirror-store
 * architecture (see the Studio shell ADR).
 *
 * The Studio window runs the real session store in MIRROR mode. Every store
 * action must be classified in exactly one of two tables:
 *
 *   - FORWARDED_ACTIONS: mutations of owner-durable state (tabs, groups,
 *     worktrees, the prompt pipeline). In the mirror these are swapped for
 *     IPC forwarders — the OWNER (overlay renderer) executes them and replies
 *     with the action's return value, so a forwarded action behaves the way its
 *     signature says it does; the resulting state also returns to the mirror
 *     via events / sync pushes.
 *   - MIRROR_LOCAL_ACTIONS: safe to run in the mirror — per-window UI state,
 *     stateless engine pass-throughs, or event-stream ingestion.
 *
 * The mirror-parity test enumerates the store at runtime and fails when an
 * action is unclassified or double-classified: adding a store action forces
 * an explicit parity decision. Main-process validation of studio:call-action
 * derives from FORWARDED_ACTIONS — one source of truth.
 */

export interface ForwardedActionSpec {
  /** Argument-count bounds accepted over the wire. */
  minArgs: number;
  maxArgs: number;
  /** Index of a tabId/session-key argument to validate, if any. */
  tabIdAt?: number;
}

export const FORWARDED_ACTIONS: Record<string, ForwardedActionSpec> = {
  // Inbox metadata (settle/snooze/unread) is owner-durable tab state
  // persisted in tabs.json — mirror calls forward to the owner.
  settleTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // Auto-settle persists and stops an engine session, so it is owner-only just
  // like manual settlement. The mirror only renders the resulting snapshot.
  autoSettleTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  unsettleTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  restoreSettledHistoryTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  snoozeTab: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  unsnoozeTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  markTabUnread: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  pinTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  unpinTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  reorderPinnedTabs: { minArgs: 1, maxArgs: 1 },
  regenerateTabTitle: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  deleteConversationTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // ── Tab lifecycle + metadata ──
  createTab: { minArgs: 0, maxArgs: 3 },
  createTabInDirectory: { minArgs: 1, maxArgs: 4 },
  createConversationTab: { minArgs: 1, maxArgs: 2 },
  createTerminalTab: { minArgs: 0, maxArgs: 2 },
  // Optional origin keeps a forwarded close owner-executed. Main's direct
  // fallback supplies `remote-delete`; the owner's permanent-delete flow
  // supplies `delete`. Studio UI calls retain the one-argument form.
  closeTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // clearTab takes NO arguments — it always acts on the owner's activeTabId.
  // A stale {minArgs:1, tabIdAt:0} spec made this action structurally
  // uncallable from the mirror (every zero-arg call failed the minArgs
  // check), and a caller supplying an argument would have had it silently
  // ignored by the real implementation regardless.
  clearTab: { minArgs: 0, maxArgs: 0 },
  selectTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  renameTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // reorderTabs takes exactly ONE argument (the full reordered TabState[]).
  // A stale {minArgs:2,maxArgs:2} spec made every real one-argument call
  // fail validation, so a mirror-initiated reorder could never reach the
  // owner. See tab-slice.ts's real (tabs) => void signature.
  reorderTabs: { minArgs: 1, maxArgs: 1 },
  setTabPillColor: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabPillIcon: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabModel: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabAutomaticModel: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabGroupId: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  moveTabToGroup: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  moveTabToGroupAndPin: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  toggleTabGroupPin: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  applySendAutoGroupMove: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  setBaseDirectory: { minArgs: 1, maxArgs: 1 },
  // addDirectory/removeDirectory take exactly ONE argument (a filesystem
  // path) and act on the owner's activeTabId internally — there is no tabId
  // parameter. A stale tabIdAt:0 validated the PATH as if it were a tab id,
  // rejecting any legitimate path over 128 characters and misdescribing what
  // is actually being checked. See directory-slice.ts's real (dir) => void
  // signatures.
  addDirectory: { minArgs: 1, maxArgs: 1 },
  removeDirectory: { minArgs: 1, maxArgs: 1 },
  // ── Worktrees / forking / recovery ──
  forkTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  forkFromMessage: { minArgs: 1, maxArgs: 3, tabIdAt: 0 },
  finishWorktreeTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // Terminal worktree completion is one owner-side read/mutate flow: occupant
  // preflight, merge, remove, close conversations, and refresh.
  landAndRetireWorktree: { minArgs: 2, maxArgs: 3 },
  convertToWorktree: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // setupWorktree is (tabId, sourceBranch, setAsDefault) — all three required.
  // A stale maxArgs:2 rejected every real invocation from the mirror; the
  // action could never actually complete a Studio-initiated worktree setup.
  setupWorktree: { minArgs: 3, maxArgs: 3, tabIdAt: 0 },
  createWorktree: { minArgs: 2, maxArgs: 2 },
  cancelWorktreeSetup: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // Renames a tab and then resolves that tab's worktree to rename it too,
  // reading store state between the two mutations. Owner-only for the same
  // reason as the flows below: a mirror-local run would read its own possibly
  // stale tab record to decide WHICH worktree to rename.
  renameTabAndWorktree: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  renameWorktree: { minArgs: 3, maxArgs: 3 },
  // Worktree inventory actions. openWorktreeConversation is a multi-step flow
  // (find-existing / create tab / attach worktree metadata) that reads store
  // state between mutations, so it MUST be one forwarded action rather than a
  // component handler -- in the mirror a handler would mix forwarded and local
  // calls and decide against stale mirror state.
  openWorktreeConversation: { minArgs: 1, maxArgs: 1 },
  // Same reasoning as openWorktreeConversation: creates a tab and then reads
  // store state to attach the worktree metadata, so it must run in the owner.
  newWorktreeConversation: { minArgs: 1, maxArgs: 1 },
  syncWorktree: { minArgs: 3, maxArgs: 3 },
  // The sync-all pipeline is the canonical multi-step flow: it reads store
  // state between mutations (tab status while agents run, the bench list for
  // the assembly phase) and mutates worktrees on disk. Owner-only — a
  // mirror-local run would launch a SECOND set of rebases and agents against
  // the same repo. Cancel/dismiss ride along: they mutate the owner's
  // pipeline record, which the mirror renders via state sync.
  startWorktreePipeline: { minArgs: 1, maxArgs: 2 },
  confirmWorktreePipelineAi: { minArgs: 0, maxArgs: 0 },
  cancelWorktreePipeline: { minArgs: 0, maxArgs: 0 },
  dismissWorktreePipeline: { minArgs: 0, maxArgs: 0 },
  // Retire destroys a directory and relocates the conversation that lived in it,
  // reading store state between the two steps. Owner-only: a mirror-local run
  // would relocate against stale mirror state, and a double retire would race
  // the directory removal.
  retireWorktree: { minArgs: 3, maxArgs: 3 },
  // Provisioning spawns install processes and mutates the worktree on disk.
  // Owner-only: a mirror-local run would start a second `npm ci` against the
  // same tree while the owner's is still going.
  reprovisionWorktree: { minArgs: 2, maxArgs: 2 },
  // Bench mutations are owner-durable: they advance pins and reassemble a shared
  // worktree, so the mirror must never run them locally.
  openBenchConversation: { minArgs: 2, maxArgs: 2 },
  // Cycle control for an already-open bench. Owner-only for the same reason
  // as openBenchConversation: it reads activeTabId to decide which tab is
  // "next", and a component handler in the mirror would read its own
  // async-delivered COPY of that value instead of the owner's live one.
  cycleBenchConversation: { minArgs: 2, maxArgs: 2 },
  // Creates a tab, then reads store state to name it — and may assemble the bench
  // on disk on the way. Owner-only for the same reason as the flows above: a
  // mirror-local run would decide whether a bench terminal already exists from
  // possibly stale mirror tabs, and two windows could each open one.
  openBenchTerminal: { minArgs: 2, maxArgs: 2 },
  benchAssemble: { minArgs: 2, maxArgs: 2 },
  // Resolve-once prepares an in-progress merge on disk and may reassemble —
  // owner-durable git mutations, so the mirror must never run it locally.
  benchResolveConflict: { minArgs: 2, maxArgs: 2 },
  benchRerereForget: { minArgs: 2, maxArgs: 2 },
  benchRerereDiscardAll: { minArgs: 1, maxArgs: 1 },
  benchUpdateMember: { minArgs: 3, maxArgs: 3 },
  benchUpdateAll: { minArgs: 2, maxArgs: 2 },
  benchAddMember: { minArgs: 4, maxArgs: 4 },
  benchRemoveMember: { minArgs: 3, maxArgs: 3 },
  // Registry write + inventory refresh — owner-durable; the mirror running it
  // locally would write ~/.ion/worktree-registry.json from the wrong window
  // and refresh against stale mirror state.
  setWorktreeStage: { minArgs: 3, maxArgs: 3 },
  // Deprecated shim over setWorktreeStage (see worktree-inventory-slice.ts).
  // Forwarded for the same reason: unmigrated call sites invoke it directly,
  // and in the mirror that invocation must ride to the owner, not delegate
  // locally through a mirror-side setWorktreeStage.
  benchSetReview: { minArgs: 4, maxArgs: 4 },
  benchSetOrder: { minArgs: 4, maxArgs: 4 },
  // AI-assisted conflict resolution creates a tab and submits a prompt —
  // owner-durable twice over; a mirror-local run would fork the conversation.
  openConflictAssist: { minArgs: 1, maxArgs: 1 },
  // Completion changes the operation and its derived workspace state. The
  // owner performs both the Git verb and the refresh before Studio renders it.
  continueConflictOperation: { minArgs: 1, maxArgs: 1 },
  abortConflictOperation: { minArgs: 1, maxArgs: 1 },
  // Bench-verification analysis: rebuilds the failing tree on disk, THEN
  // creates a tab and submits a prompt — owner-durable three times over, same
  // reasoning as openConflictAssist plus a git mutation neither mirror may run.
  openBenchVerificationAnalysis: { minArgs: 2, maxArgs: 2 },
  // Targeted forget-then-reassemble — owner-durable git mutation.
  benchDiscardMemberRecordings: { minArgs: 3, maxArgs: 3 },
  benchApplyOverlapFastLane: { minArgs: 4, maxArgs: 4 },
  retireLandedWorktrees: { minArgs: 1, maxArgs: 1 },
  sealLandedWorktree: { minArgs: 1, maxArgs: 1 },
  // forceRecoverTab is (tabId, reason) — both required. A stale maxArgs:1
  // rejected every real two-argument call from the mirror.
  forceRecoverTab: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  // resumeSession is (sessionId, title?, projectPath?, customTitle?,
  // encodedDir?) — 5 possible arguments. A stale maxArgs:3 silently truncated
  // any call that also supplied customTitle/encodedDir, which a mirror caller
  // legitimately does. See session-store-types.ts's resumeSession signature.
  resumeSession: { minArgs: 1, maxArgs: 5 },
  // resumeSessionWithChain is (sessionId, historicalSessionIds, title?,
  // projectPath?, customTitle?, encodedDir?) — 6 possible arguments, the
  // first two required. Same truncation bug as resumeSession, one argument
  // worse because historicalSessionIds is itself required (not optional).
  resumeSessionWithChain: { minArgs: 2, maxArgs: 6 },
  // ── Conversation / prompt pipeline (owner does the optimistic insert,
  //    slash resolution, iOS echo — the mirror must never fork it) ──
  submit: { minArgs: 2, maxArgs: 3, tabIdAt: 0 },
  submitRemoteBash: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  // editQueuedMessage is (tabId) — a single argument. A stale {minArgs:2}
  // rejected every real invocation from the mirror. See attachments-slice.ts's
  // real (tabId: string) => void signature.
  editQueuedMessage: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // rewindEngineInstance is (tabId, instanceId, messageId, userTurnIndex?) —
  // 3 required plus 1 optional. minArgs was too permissive at 1 (the real
  // call always supplies at least tabId/instanceId/messageId); tightening it
  // matches session-store-types.ts's real signature and rejects a
  // malformed/truncated forwarded call earlier instead of letting it reach
  // the store action with undefined required parameters.
  rewindEngineInstance: { minArgs: 3, maxArgs: 4, tabIdAt: 0 },
  // resetEngineInstance is (tabId, instanceId) — both required. A stale
  // minArgs:1 would have accepted a call missing instanceId and let it reach
  // the store action with an undefined required parameter.
  resetEngineInstance: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  // addEngineInstance is (tabId) — a single argument. A stale maxArgs:2
  // silently accepted a bogus extra argument no real caller supplies.
  addEngineInstance: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // setPermissionMode is (mode, source?) — it acts on the owner's ACTIVE tab
  // (single-focus rule keeps that the mirror's active tab too). No tabId arg.
  setPermissionMode: { minArgs: 1, maxArgs: 2 },
  // Read-plus-write mode inversion must happen in the owner. A Studio mirror
  // may lag between event batches, so forwarding a precomputed target mode
  // could invert the owner's current mode incorrectly.
  togglePermissionMode: { minArgs: 0, maxArgs: 1 },
  setThinkingEffort: { minArgs: 1, maxArgs: 1 },
  // The whole plan-approval pipeline (implement-slice.ts): unpin, denial
  // clear, divider, per-tab mode flip, group auto-move, plan read, submit.
  // Forwarding the COMPOSITE keeps every decision in the owner window —
  // forwarding its pieces individually is what let the mirror's stale pin
  // state suppress the in-progress move.
  implementPlan: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // Card dismissal is a store clear PLUS an engine notify that releases the
  // engine's retention of the denial. Both must run in the owner window: a
  // mirror-local clear would leave the engine still re-publishing the denial,
  // and a split call would notify for whichever tab the owner thought active.
  dismissPermissionDenied: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // Completion evidence causes a delayed tab close plus workspace refresh. This
  // owner-durable decision must see owner state once, never mirror state.
  reportAutoFixCompletion: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  // ── Attachments stage on the ACTIVE tab (no tabId arg — the owner's
  //    active tab matches the mirror's by the single-focus rule) ──
  addAttachments: { minArgs: 1, maxArgs: 1 },
  removeAttachment: { minArgs: 1, maxArgs: 1 },
  clearAttachments: { minArgs: 0, maxArgs: 0 },
  // Rebuilds previews for the owner's restored tray. Runs only in the owner's
  // restore path today, but it writes the same owner-durable tab.attachments
  // the three above do, so it forwards with them rather than splitting the
  // field's ownership across windows.
  rehydrateAttachmentPreviews: { minArgs: 0, maxArgs: 0 },
  // ── Terminal instances are owner-persisted tab metadata ──
  renameTerminalInstance: { minArgs: 3, maxArgs: 3, tabIdAt: 0 },
};

/**
 * Actions the mirror executes locally, with the reason each is safe.
 * "pass-through" = stateless main-process call (sessionPlane routes to the
 * engine; no renderer-owned durable state). "per-window UI" = view state
 * that intentionally differs between windows. "ingestion" = event-stream
 * reducers — the mirror consumes the same stream as the owner.
 */
export const MIRROR_LOCAL_ACTIONS: Record<string, string> = {
  // Stateless engine pass-throughs.
  respondPermission:
    "pass-through: permission_response to engine; cross-surface reconcile via resolution push",
  respondElicitation: "pass-through: elicitation answer to engine",
  respondEngineDialog: "pass-through: dialog answer to engine",
  interrupt: "pass-through: abort to engine; status events update all windows",
  markResourceRead:
    "pass-through: mark_read delta via engine broker + local read-state",
  markAllResourcesRead:
    "pass-through: mark_read deltas via engine broker + local read-state",
  deleteResource: "local view of resource list; producer owns persistence",
  // Dismissing the absorbed-into-base notice is per-window UI state: the bench
  // record itself is untouched, and each window's operator dismisses their own
  // notice. Forwarding it would clear the overlay's notice from the Studio window.
  clearBenchRetired: "per-window notice dismissal; no bench mutation",
  benchRerereCount: "read-only main-process query over shared git state",
  // Conflict-alert bookkeeping mutates no git state. record/clear are driven by
  // each window's own inventory refresh and sync results (both windows observe
  // the same main-process truth), and dismissing a toast is per-window UI.
  recordConflictAlert:
    "ingestion: derived from inventory/sync results each window already receives",
  clearConflictAlert:
    "ingestion: derived from inventory refresh; no git mutation",
  dismissConflictAlert:
    "per-window toast dismissal; badges derive from live inventory state",
  runQuickTool: "pass-through: one-shot tool run",
  // ── Close confirmation ──
  // The close DIALOG is per-window: the operator who clicked X in a given
  // window is the one who must answer, and forwarding the intent would pop a
  // dialog in the other window instead of (or as well as) the one being used.
  // Only the durable half is forwarded, and it already is: confirmCloseTab
  // delegates to `closeTab`, which the mirror has swapped for its forwarder, so
  // the tab teardown still executes in the owner. requestCloseTab's own reads
  // are safe in the mirror — the tab list is hydrated from the owner snapshot
  // and the appraisal is a read-only main-process git call over the same
  // preload both windows share.
  requestCloseTab:
    "per-window close dialog; read-only appraisal, durable close delegates to forwarded closeTab",
  confirmCloseTab:
    "per-window dialog dismissal; the durable close routes through forwarded closeTab",
  cancelCloseTab: "per-window dialog dismissal; no durable state touched",
  // Event-stream ingestion (mirror consumes the same normalized stream).
  handleNormalizedEvent: "ingestion: normalized-event reducer",
  handleStatusChange: "ingestion: tab-status reducer",
  handleError: "ingestion: error reducer",
  insertRemoteUserMessage: "ingestion: user-message echo insertion",
  addSystemMessage: "ingestion: local system row",
  addEngineSystemMessage: "ingestion: local system row",
  loadSkeletonMessages: "ingestion: lazy history hydration",
  rehydrateFailedHistory:
    "ingestion: retry lazy history hydration after engine reconnect",
  initStaticInfo: "boot: reads static info; no durable writes",
  // Pure read accessor: derives a canonical tail fingerprint from local store
  // state; no writes, no IPC. Safe to run in either window.
  computeConvFingerprint: "read-only derived value; no mutations",
  submitRemotePrompt:
    "owner-only wiring: invoked by the iOS handler, which the mirror never registers",
  // Per-window UI state.
  toggleExpanded: "per-window UI",
  toggleInboxPanel: "per-window UI: left-side Inbox/Explorer exclusivity",
  closeInboxPanel: "per-window UI: closes only invoking window Inbox",
  toggleGitPanel: "per-window UI",
  closeGitPanel: "per-window UI",
  toggleStatusDrawer: "per-window UI",
  closeStatusDrawer: "per-window UI",
  openDispatchSplit: "per-window UI",
  closeDispatchSplit: "per-window UI",
  openDispatchPreview: "per-window UI",
  toggleTallView: "per-window UI",
  openSettings: "per-window UI",
  closeSettings: "per-window UI",
  incOpenFloatingPanelCount: "per-window UI",
  decOpenFloatingPanelCount: "per-window UI",
  setDraftInput: "per-window UI: drafts are deliberately window-local",
  setEngineDraftInput: "per-window UI: drafts are deliberately window-local",
  clearPendingInput: "per-window UI: drafts are deliberately window-local",
  setEditorGeometry: "per-window UI",
  setPlanGeometry: "per-window UI",
  setResourceViewerGeometry: "per-window UI",
  setAgentDetailGeometry: "per-window UI",
  setWorktreeUncommitted: "per-window derived cache",
  refreshWorktreeInventory:
    "read-only IPC fetch into a per-window derived cache",
  refreshBench: "read-only IPC fetch into a per-window derived cache",
  refreshWorkspaceViews:
    "read-only IPC fetch into a per-window derived cache (the inventory+bench pair)",
  // File explorer / editor (window-local workbench state).
  toggleFileExplorer: "per-window UI",
  collapseAllExplorer: "per-window UI",
  setExplorerRootCollapsed: "per-window UI",
  setFileExplorerExpanded: "per-window UI",
  setFileExplorerSelected: "per-window UI",
  toggleFileEditor: "per-window UI",
  openFileInEditor: "per-window UI",
  closeFileEditorTab: "per-window UI",
  setActiveEditorFile: "per-window UI",
  reorderEditorFiles: "per-window UI",
  updateEditorContent:
    "per-window editor buffer (disk write is a direct fs IPC)",
  markEditorSaved: "per-window UI",
  toggleEditorPreview: "per-window UI",
  toggleEditorReadOnly: "per-window UI",
  toggleEditorWordWrap: "per-window UI",
  createScratchFile: "per-window UI",
  focusFileEditor: "per-window UI",
  blurFileEditor: "per-window UI",
  // Terminals are per-window and per-conversation. Studio mounts the shared
  // bottom multiplexer, but its pane pool and visibility must stay independent
  // from the overlay window's local terminal UI.
  toggleTerminal: "per-window terminal UI",
  toggleTerminalTall: "per-window terminal UI",
  toggleTerminalBigScreen: "per-window terminal UI",
  toggleTerminalReadOnly: "per-window terminal UI",
  selectTerminalInstance: "per-window terminal UI",
  addTerminalInstance: "per-window pty pool",
  removeTerminalInstance: "per-window pty pool",
  getOrCreateDedicatedTerminal: "per-window pty pool",
  consumeTerminalPendingCommand: "per-window terminal UI",
  runInTerminal: "per-window pty pool",
  startBashCommand: "per-window bash flow",
  completeBashCommand: "per-window bash flow",
};

/** Wire-shape validation for a forwarded action call (main process). */
export function validForwardedAction(action: unknown, args: unknown): boolean {
  if (typeof action !== "string") return false;
  const spec = FORWARDED_ACTIONS[action];
  if (!spec) return false;
  if (
    !Array.isArray(args) ||
    args.length < spec.minArgs ||
    args.length > spec.maxArgs
  )
    return false;
  if (spec.tabIdAt != null) {
    const tabId = args[spec.tabIdAt];
    if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 128)
      return false;
  }
  return true;
}
