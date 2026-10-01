/**
 * studio-wire/actions — the classification contract of the mirror-store
 * architecture (see the Studio shell ADR) AND the `studio_action` registry
 * (manifest contract C3/C4).
 *
 * This is the canonical home of `FORWARDED_ACTIONS`/`MIRROR_LOCAL_ACTIONS`
 * (moved here from `studio-mirror-actions.ts`, which is now a thin
 * re-export — see that file). The Studio window runs the real session store
 * in MIRROR mode. Every store action must be classified in exactly one of
 * two tables:
 *
 *   - FORWARDED_ACTIONS: mutations of owner-durable state (tabs,
 *     worktrees, the prompt pipeline). In the mirror these are swapped for
 *     IPC forwarders — the OWNER (overlay renderer) executes them and replies
 *     with the action's return value, so a forwarded action behaves the way its
 *     signature says it does; the resulting state also returns to the mirror
 *     via events / sync pushes. Over the Studio wire, a forwarded action is
 *     exactly what a `studio_action` frame invokes: the server runs
 *     `store.getState()[action](...args)` and replies with `ok/value/refusal/error`.
 *   - MIRROR_LOCAL_ACTIONS: safe to run in the mirror — per-window UI state,
 *     stateless engine pass-throughs, or event-stream ingestion. These never
 *     ride `studio_action` — a remote Studio client has no local store to run
 *     them against, so they simply are not in `ACTIONS`.
 *
 * The mirror-parity test enumerates the store at runtime and fails when an
 * action is unclassified or double-classified: adding a store action forces
 * an explicit parity decision. Main-process validation of studio:call-action
 * and the server's `studio_action` scope enforcement both derive from
 * FORWARDED_ACTIONS/ACTIONS — one source of truth.
 */
import type { Scope } from './types'

export interface ForwardedActionSpec {
  /** Argument-count bounds accepted over the wire. */
  minArgs: number;
  maxArgs: number;
  /** Index of a tabId/session-key argument to validate, if any. */
  tabIdAt?: number;
  /**
   * The action names no tab and acts on the ACTIVE one. A window holds tabs
   * from several environments, so "the active tab" is the window's, not
   * whichever tab each server last had selected: the mirror routes such an
   * action to the environment that owns the window's active tab and carries
   * that tab's id on the frame (`studio_action.activeTabId`), and the server
   * makes it its active tab before the action runs. Without this the action
   * went to the local server and changed whatever conversation was active
   * THERE.
   */
  activeTab?: true;
  /**
   * Index of an argument that is a path on the machine holding a worktree
   * workspace: a repository, worktree, or bench path. The action names no
   * tab, so the mirror routes it to the Environment whose worktree read
   * model holds that path. Without this it went to the local server, which
   * cannot act on another machine's worktree and, for a refresh, recorded an
   * empty row for a path it does not have.
   */
  workspacePathAt?: number;
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
  markTabRead: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
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
  // clearTab takes NO arguments — it acts on the active tab (`activeTab`).
  // A stale {minArgs:1, tabIdAt:0} spec made this action structurally
  // uncallable from the mirror (every zero-arg call failed the minArgs
  // check), and a caller supplying an argument would have had it silently
  // ignored by the real implementation regardless.
  clearTab: { minArgs: 0, maxArgs: 0, activeTab: true },
  selectTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  renameTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabPillColor: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // maxArgs 3: (tabId, model, providerId?) — providerId qualifies an explicit
  // user pick so defaultProvider bias never overrides it (see send-slice.ts
  // resolvePromptModel).
  setTabModel: { minArgs: 1, maxArgs: 3, tabIdAt: 0 },
  setTabAutomaticModel: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setBaseDirectory: { minArgs: 1, maxArgs: 1 },
  // addDirectory/removeDirectory take exactly ONE argument (a filesystem
  // path) and act on the owner's activeTabId internally — there is no tabId
  // parameter. A stale tabIdAt:0 validated the PATH as if it were a tab id,
  // rejecting any legitimate path over 128 characters and misdescribing what
  // is actually being checked. See directory-slice.ts's real (dir) => void
  // signatures.
  addDirectory: { minArgs: 1, maxArgs: 1, activeTab: true },
  removeDirectory: { minArgs: 1, maxArgs: 1, activeTab: true },
  // ── Worktrees / forking / recovery ──
  forkTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  forkFromMessage: { minArgs: 1, maxArgs: 3, tabIdAt: 0 },
  finishWorktreeTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // Terminal worktree completion is one owner-side read/mutate flow: occupant
  // preflight, merge, remove, close conversations, and refresh.
  landAndRetireWorktree: { minArgs: 2, maxArgs: 3, workspacePathAt: 0 },
  convertToWorktree: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // setupWorktree is (tabId, sourceBranch, setAsDefault) — all three required.
  // A stale maxArgs:2 rejected every real invocation from the mirror; the
  // action could never actually complete a Studio-initiated worktree setup.
  setupWorktree: { minArgs: 3, maxArgs: 3, tabIdAt: 0 },
  createWorktree: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  cancelWorktreeSetup: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // Renames a tab and then resolves that tab's worktree to rename it too,
  // reading store state between the two mutations. Owner-only for the same
  // reason as the flows below: a mirror-local run would read its own possibly
  // stale tab record to decide WHICH worktree to rename.
  renameTabAndWorktree: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  renameWorktree: { minArgs: 3, maxArgs: 3, workspacePathAt: 0 },
  // These three were misclassified as MIRROR_LOCAL under the theory
  // "read-only IPC fetch into a per-window derived cache" -- that theory
  // predates the server-owned store (ADR-033): there is no per-window IPC
  // to fetch from any more, only real `git`/filesystem I/O that exists
  // solely in the server process. Running them "locally" in a Studio
  // window (Electron's own window included, not just a browser client)
  // hits `host-api-git.ts`'s build-time renderer stub and throws
  // "cannot run in the Studio renderer" the instant a render-time effect
  // calls them.
  refreshWorktreeInventory: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  refreshBench: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  refreshWorkspaceViews: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  // Same misclassification as the three above: a bench git-rerere count is a
  // real `git` subprocess read (host-api-git.ts's benchRerereCount), not a
  // "read-only main-process query" with no renderer equivalent post-ADR-033.
  benchRerereCount: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  // Worktree inventory actions. openWorktreeConversation is a multi-step flow
  // (find-existing / create tab / attach worktree metadata) that reads store
  // state between mutations, so it MUST be one forwarded action rather than a
  // component handler -- in the mirror a handler would mix forwarded and local
  // calls and decide against stale mirror state.
  openWorktreeConversation: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  // Same reasoning as openWorktreeConversation: creates a tab and then reads
  // store state to attach the worktree metadata, so it must run in the owner.
  newWorktreeConversation: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  syncWorktree: { minArgs: 3, maxArgs: 3, workspacePathAt: 0 },
  // The sync-all pipeline is the canonical multi-step flow: it reads store
  // state between mutations (tab status while agents run, the bench list for
  // the assembly phase) and mutates worktrees on disk. Owner-only — a
  // mirror-local run would launch a SECOND set of rebases and agents against
  // the same repo. Cancel/dismiss ride along: they mutate the owner's
  // pipeline record, which the mirror renders via state sync.
  startWorktreePipeline: { minArgs: 1, maxArgs: 2, workspacePathAt: 0 },
  confirmWorktreePipelineAi: { minArgs: 0, maxArgs: 0 },
  cancelWorktreePipeline: { minArgs: 0, maxArgs: 0 },
  dismissWorktreePipeline: { minArgs: 0, maxArgs: 0 },
  // Retire destroys a directory and relocates the conversation that lived in it,
  // reading store state between the two steps. Owner-only: a mirror-local run
  // would relocate against stale mirror state, and a double retire would race
  // the directory removal.
  retireWorktree: { minArgs: 3, maxArgs: 3, workspacePathAt: 0 },
  // Provisioning spawns install processes and mutates the worktree on disk.
  // Owner-only: a mirror-local run would start a second `npm ci` against the
  // same tree while the owner's is still going.
  reprovisionWorktree: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  // Bench mutations are owner-durable: they advance pins and reassemble a shared
  // worktree, so the mirror must never run them locally.
  openBenchConversation: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  // Cycle control for an already-open bench. Owner-only for the same reason
  // as openBenchConversation: it reads activeTabId to decide which tab is
  // "next", and a component handler in the mirror would read its own
  // async-delivered COPY of that value instead of the owner's live one.
  cycleBenchConversation: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  // Creates a tab, then reads store state to name it — and may assemble the bench
  // on disk on the way. Owner-only for the same reason as the flows above: a
  // mirror-local run would decide whether a bench terminal already exists from
  // possibly stale mirror tabs, and two windows could each open one.
  openBenchTerminal: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  benchAssemble: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  // Resolve-once prepares an in-progress merge on disk and may reassemble —
  // owner-durable git mutations, so the mirror must never run it locally.
  benchResolveConflict: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  benchRerereForget: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  benchRerereDiscardAll: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  benchUpdateMember: { minArgs: 3, maxArgs: 3, workspacePathAt: 0 },
  benchUpdateAll: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  benchAddMember: { minArgs: 4, maxArgs: 4, workspacePathAt: 0 },
  benchRemoveMember: { minArgs: 3, maxArgs: 3, workspacePathAt: 0 },
  // Registry write + inventory refresh — owner-durable; the mirror running it
  // locally would write ~/.ion/worktree-registry.json from the wrong window
  // and refresh against stale mirror state.
  setWorktreeStage: { minArgs: 3, maxArgs: 3, workspacePathAt: 0 },
  // Deprecated shim over setWorktreeStage (see worktree-inventory-slice.ts).
  // Forwarded for the same reason: unmigrated call sites invoke it directly,
  // and in the mirror that invocation must ride to the owner, not delegate
  // locally through a mirror-side setWorktreeStage.
  benchSetReview: { minArgs: 4, maxArgs: 4, workspacePathAt: 0 },
  benchSetOrder: { minArgs: 4, maxArgs: 4, workspacePathAt: 0 },
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
  openBenchVerificationAnalysis: { minArgs: 2, maxArgs: 2, workspacePathAt: 0 },
  // Targeted forget-then-reassemble — owner-durable git mutation.
  benchDiscardMemberRecordings: { minArgs: 3, maxArgs: 3, workspacePathAt: 0 },
  benchApplyOverlapFastLane: { minArgs: 4, maxArgs: 4, workspacePathAt: 0 },
  retireLandedWorktrees: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
  sealLandedWorktree: { minArgs: 1, maxArgs: 1, workspacePathAt: 0 },
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
  // appendSystemNotice writes a message into the conversation, which is
  // owner-durable state the owner persists and echoes. It is forwarded for the
  // same reason submit is — and specifically so a refusal raised by the
  // OWNER's guard lands in the owner's copy of the conversation, rather than
  // only in whichever window happened to host the click.
  appendSystemNotice: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  submitRemoteBash: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  // editQueuedMessage is (tabId) — a single argument. A stale {minArgs:2}
  // rejected every real invocation from the mirror. See attachments-slice.ts's
  // real (tabId: string) => void signature.
  editQueuedMessage: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // The unsent composer text is owner-durable: it is serialized onto the
  // conversation pane (serialize-conversation-pane.ts) and restored at boot
  // (boot-restore-tab.ts), so a half-written prompt survives a quit, a crash,
  // and a machine restart. That is only true if the write reaches the process
  // that owns the store and writes the tabs file — a mirror-local write never
  // left the window, which is why the serialize/restore pair above had nothing
  // to write for as long as it existed. Composers debounce their writes, so
  // this is a low-rate action despite being per-keystroke at the source.
  setDraftInput: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
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
  // setPermissionMode is (mode, source?) — no tabId arg; it acts on the
  // active tab (`activeTab`).
  setPermissionMode: { minArgs: 1, maxArgs: 2, activeTab: true },
  // Read-plus-write mode inversion must happen in the owner. A Studio mirror
  // may lag between event batches, so forwarding a precomputed target mode
  // could invert the owner's current mode incorrectly.
  togglePermissionMode: { minArgs: 0, maxArgs: 1, activeTab: true },
  setThinkingEffort: { minArgs: 1, maxArgs: 1, activeTab: true },
  // The whole plan-approval pipeline (implement-slice.ts): unpin, denial
  // clear, divider, per-tab mode flip, plan read, submit.
  // Forwarding the COMPOSITE keeps every decision in the owner window —
  // forwarding its pieces individually is what let the mirror's stale pin
  // state suppress the in-progress move.
  implementPlan: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // Automation conversation command can create tabs, mutate pills,
  // and submit. Only main's onAutomationCommand listener in the owner window
  // ever invokes this (a mirror never receives that IPC event), but it is
  // classified FORWARDED rather than omitted so a future call site cannot
  // silently run it against stale mirror state.
  runAutomationCommand: { minArgs: 1, maxArgs: 1 },
  // Card dismissal is a store clear PLUS an engine notify that releases the
  // engine's retention of the denial. Both must run in the owner window: a
  // mirror-local clear would leave the engine still re-publishing the denial,
  // and a split call would notify for whichever tab the owner thought active.
  dismissPermissionDenied: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // Completion evidence causes a delayed tab close plus workspace refresh. This
  // owner-durable decision must see owner state once, never mirror state.
  reportAutoFixCompletion: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  // ── Attachments stage on the active tab (no tabId arg; `activeTab`) ──
  addAttachments: { minArgs: 1, maxArgs: 1, activeTab: true },
  removeAttachment: { minArgs: 1, maxArgs: 1, activeTab: true },
  clearAttachments: { minArgs: 0, maxArgs: 0, activeTab: true },
  // Rebuilds previews for the owner's restored tray. Runs only in the owner's
  // restore path today, but it writes the same owner-durable tab.attachments
  // the three above do, so it forwards with them rather than splitting the
  // field's ownership across windows.
  rehydrateAttachmentPreviews: { minArgs: 0, maxArgs: 0 },
  // ── Conversation Terminal Panel metadata is owner-controlled ──
  toggleTerminal: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  addTerminalInstance: { minArgs: 2, maxArgs: 5, tabIdAt: 0 },
  relaunchTerminalInstance: { minArgs: 2, maxArgs: 4, tabIdAt: 0 },
  // (tabId, cwd?) — the owner creates a first shell only when IT has none.
  // A client must not decide this from its own copy of the terminal state,
  // which has not arrived yet when the terminal panel first mounts.
  ensureTerminalInstance: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  removeTerminalInstance: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  selectTerminalInstance: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  toggleTerminalReadOnly: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  renameTerminalInstance: { minArgs: 3, maxArgs: 3, tabIdAt: 0 },
  getOrCreateDedicatedTerminal: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  runInTerminal: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  runQuickTool: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  // ── Engine pass-throughs previously misclassified as MIRROR_LOCAL ──
  // These were reasoned about under the pre-ADR-033 model, where "pass-through
  // to engine" meant an IPC round trip to the owner window's real preload
  // bridge -- a bridge every window had. Post server-owned-store, the real
  // functions (host-api-engine.ts / host-api-misc.ts) are reachable only in
  // the server process; calling them from ANY renderer (Electron's own Studio
  // window included) hits their build-time browser stub, which either rejects
  // outright or returns an inert placeholder that silently never does the
  // real thing. Each needs the SAME owner-execution + state-sync treatment
  // every other FORWARDED action already gets.
  respondPermission: { minArgs: 3, maxArgs: 3, tabIdAt: 0 },
  respondElicitation: { minArgs: 4, maxArgs: 5, tabIdAt: 0 },
  respondEngineDialog: { minArgs: 3, maxArgs: 3, tabIdAt: 0 },
  interrupt: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  abortDispatch: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  abortDispatches: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  stopBackgroundTask: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  submitRemotePrompt: { minArgs: 2, maxArgs: 10, tabIdAt: 0 },
  // initStaticInfo has no tabId: it reads the engine's own version/auth/home
  // info once at boot, via host-api-misc.ts's start().
  initStaticInfo: { minArgs: 0, maxArgs: 0 },
  // loadSkeletonMessages loads externalized scrollback via host-api-misc.ts's
  // loadChainHistory/loadTabContent -- real filesystem/engine-store I/O. Its
  // browser stub does not throw (it resolves an empty/null placeholder), so
  // mirror-local this action was NOT a crash -- it silently loaded no
  // history at all, forever, in any Studio window (Electron's own included).
  loadSkeletonMessages: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // requestCloseTab's appraisal is real git I/O (host-api-git.ts's
  // gitWorktreeAppraise). Its return value now carries the raised
  // `closeIntent` (or null) so the calling window's own mirror reconciliation
  // (secondary-store-reconcile.ts's reconcileForwardedCloseIntent) can apply
  // it locally -- the close dialog is per-window and must never appear via a
  // broadcast that would pop it in every connected window at once.
  requestCloseTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
};

/**
 * Actions the mirror executes locally, with the reason each is safe.
 * "pass-through" = stateless main-process call (sessionPlane routes to the
 * engine; no renderer-owned durable state). "per-window UI" = view state
 * that intentionally differs between windows. "ingestion" = event-stream
 * reducers — the mirror consumes the same stream as the owner.
 */
export const MIRROR_LOCAL_ACTIONS: Record<string, string> = {
  markResourceRead:
    "pass-through: mark_read delta via engine broker + local read-state",
  markAllResourcesRead:
    "pass-through: mark_read deltas via engine broker + local read-state",
  deleteResource: "local view of resource list; producer owns persistence",
  // Dismissing the absorbed-into-base notice is per-window UI state: the bench
  // record itself is untouched, and each window's operator dismisses their own
  // notice. Forwarding it would clear the overlay's notice from the Studio window.
  clearBenchRetired: "per-window notice dismissal; no bench mutation",
  // Conflict-alert bookkeeping mutates no git state. record/clear are driven by
  // each window's own inventory refresh and sync results (both windows observe
  // the same main-process truth), and dismissing a toast is per-window UI.
  recordConflictAlert:
    "ingestion: derived from inventory/sync results each window already receives",
  clearConflictAlert:
    "ingestion: derived from inventory refresh; no git mutation",
  dismissConflictAlert:
    "per-window toast dismissal; badges derive from live inventory state",
  // ── Close confirmation ──
  // The close DIALOG is per-window: the operator who clicked X in a given
  // window is the one who must answer. requestCloseTab itself is now
  // FORWARDED (its appraisal is real git I/O -- see FORWARDED_ACTIONS), with
  // its return value reconciled onto this window's own `closeIntent` so the
  // dialog still appears only here (secondary-store-reconcile.ts's
  // reconcileForwardedCloseIntent). confirmCloseTab/cancelCloseTab stay
  // mirror-local: they only clear the LOCAL `closeIntent` this window raised
  // and, on confirm, delegate to `closeTab`, which the mirror has swapped for
  // its own forwarder, so the tab teardown still executes in the owner.
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
  // rehydrateFailedHistory itself only resets local hydration markers; the
  // actual reload it triggers (get().loadSkeletonMessages) is FORWARDED, and
  // a mirror's `get()` call automatically resolves to the installed
  // forwarder override (applyMirrorOverrides replaces the store action, not
  // just its call sites) -- see secondary-store.ts's `applyMirrorOverrides`.
  rehydrateFailedHistory:
    "ingestion: retry lazy history hydration after engine reconnect; delegates to forwarded loadSkeletonMessages",
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
  toggleTallView: "per-window UI",
  openSettings: "per-window UI",
  closeSettings: "per-window UI",
  incOpenFloatingPanelCount: "per-window UI",
  decOpenFloatingPanelCount: "per-window UI",
  // A rewind/fork prefill is a one-shot handoff into the composer of the
  // window that asked for it, not durable state: the mirror sets it locally
  // (secondary-store-reconcile.ts) and clears it locally once the composer has
  // consumed it. The draft the prefill lands in IS durable, and is forwarded —
  // see setDraftInput in FORWARDED_ACTIONS.
  clearPendingInput: "per-window UI: one-shot composer prefill handoff",
  setEditorGeometry: "per-window UI",
  setPlanGeometry: "per-window UI",
  setResourceViewerGeometry: "per-window UI",
  setAgentDetailGeometry: "per-window UI",
  setWorktreeUncommitted: "per-window derived cache",
  // File explorer / editor (window-local workbench state).
  toggleFileExplorer: "per-window UI",
  collapseAllExplorer: "converges via the main-owned explorer-state funnel",
  collapseAllExplorerRoots: "converges via the main-owned explorer-state funnel",
  setExplorerRootCollapsed: "converges via the main-owned explorer-state funnel",
  // Explorer tree state is no longer per-window: main owns the snapshot and
  // every window publishes to it through the explorer-state funnel, which
  // persists it and fans the result to both presentations. These stay
  // mirror-local because each window applies the same accepted snapshot —
  // forwarding them would route a change through the owner only to have it
  // arrive back over the very channel that already carries it.
  setFileExplorerExpanded: "converges via the main-owned explorer-state funnel",
  setFileExplorerSelected: "converges via the main-owned explorer-state funnel",
  applyExplorerState: "applies the main-owned snapshot in this window",
  pruneExplorerExpanded:
    "drops expansions the directory listing this window just read disproved",
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
  // Conversation Terminal Panel geometry is local. The pane list and its
  // selection/visibility are owner-controlled and listed in FORWARDED_ACTIONS.
  toggleTerminalTall: "per-window Conversation Terminal Panel display",
  toggleTerminalBigScreen: "per-window Conversation Terminal Panel display",
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

// The scope registry (`ACTIONS`, `scopeSatisfies`) lives in ./action-scopes,
// split off at the TypeScript size cap. It is deliberately NOT re-exported
// here: that module reads FORWARDED_ACTIONS at load time, and a re-export
// would make this file import it back. `export ... from` is hoisted above the
// table declarations, so the scope module would then evaluate before
// FORWARDED_ACTIONS is assigned and build its registry from undefined.
// Import the registry from './action-scopes' directly.
