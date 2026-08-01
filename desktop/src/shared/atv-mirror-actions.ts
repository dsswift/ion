/**
 * atv-mirror-actions — the classification contract of the mirror-store
 * architecture (see the ATV shell ADR).
 *
 * The ATV window runs the real session store in MIRROR mode. Every store
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
 * an explicit parity decision. Main-process validation of atv:call-action
 * derives from FORWARDED_ACTIONS — one source of truth.
 */

export interface ForwardedActionSpec {
  /** Argument-count bounds accepted over the wire. */
  minArgs: number
  maxArgs: number
  /** Index of a tabId/session-key argument to validate, if any. */
  tabIdAt?: number
}

export const FORWARDED_ACTIONS: Record<string, ForwardedActionSpec> = {
  // ── Tab lifecycle + metadata ──
  createTab: { minArgs: 0, maxArgs: 3 },
  createTabInDirectory: { minArgs: 1, maxArgs: 4 },
  createConversationTab: { minArgs: 1, maxArgs: 2 },
  createTerminalTab: { minArgs: 0, maxArgs: 2 },
  closeTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  clearTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  selectTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  renameTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  reorderTabs: { minArgs: 2, maxArgs: 2 },
  setTabPillColor: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabPillIcon: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabModel: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setTabGroupId: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  moveTabToGroup: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  moveTabToGroupAndPin: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  toggleTabGroupPin: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  applySendAutoGroupMove: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  setBaseDirectory: { minArgs: 1, maxArgs: 1 },
  addDirectory: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  removeDirectory: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // ── Worktrees / forking / recovery ──
  forkTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  forkFromMessage: { minArgs: 1, maxArgs: 3, tabIdAt: 0 },
  finishWorktreeTab: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  convertToWorktree: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  setupWorktree: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  cancelWorktreeSetup: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  // Renames a tab and then resolves that tab's worktree to rename it too,
  // reading store state between the two mutations. Owner-only for the same
  // reason as the flows below: a mirror-local run would read its own possibly
  // stale tab record to decide WHICH worktree to rename.
  renameTabAndWorktree: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
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
  // Creates a tab, then reads store state to name it — and may assemble the bench
  // on disk on the way. Owner-only for the same reason as the flows above: a
  // mirror-local run would decide whether a bench terminal already exists from
  // possibly stale mirror tabs, and two windows could each open one.
  openBenchTerminal: { minArgs: 2, maxArgs: 2 },
  benchAssemble: { minArgs: 2, maxArgs: 2 },
  // Resolve-once prepares an in-progress merge on disk and may reassemble —
  // owner-durable git mutations, so the mirror must never run it locally.
  benchResolveConflict: { minArgs: 2, maxArgs: 2 },
  benchUpdateMember: { minArgs: 3, maxArgs: 3 },
  benchUpdateAll: { minArgs: 2, maxArgs: 2 },
  benchAddMember: { minArgs: 4, maxArgs: 4 },
  benchRemoveMember: { minArgs: 3, maxArgs: 3 },
  benchSetEnabled: { minArgs: 4, maxArgs: 4 },
  benchSetReview: { minArgs: 4, maxArgs: 4 },
  benchSetOrder: { minArgs: 4, maxArgs: 4 },
  // AI-assisted conflict resolution creates a tab and submits a prompt —
  // owner-durable twice over; a mirror-local run would fork the conversation.
  openConflictAssist: { minArgs: 1, maxArgs: 1 },
  forceRecoverTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  autoRecoverStuckTab: { minArgs: 1, maxArgs: 1, tabIdAt: 0 },
  resumeSession: { minArgs: 1, maxArgs: 3 },
  resumeSessionWithChain: { minArgs: 1, maxArgs: 3 },
  // ── Conversation / prompt pipeline (owner does the optimistic insert,
  //    slash resolution, iOS echo — the mirror must never fork it) ──
  submit: { minArgs: 2, maxArgs: 3, tabIdAt: 0 },
  submitRemoteBash: { minArgs: 2, maxArgs: 2, tabIdAt: 0 },
  editQueuedMessage: { minArgs: 2, maxArgs: 3, tabIdAt: 0 },
  rewindToMessage: { minArgs: 2, maxArgs: 3, tabIdAt: 0 },
  rewindEngineInstance: { minArgs: 1, maxArgs: 3, tabIdAt: 0 },
  resetEngineInstance: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  addEngineInstance: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // setPermissionMode is (mode, source?) — it acts on the owner's ACTIVE tab
  // (single-focus rule keeps that the mirror's active tab too). No tabId arg.
  setPermissionMode: { minArgs: 1, maxArgs: 2 },
  setThinkingEffort: { minArgs: 1, maxArgs: 1 },
  // The whole plan-approval pipeline (implement-slice.ts): unpin, denial
  // clear, divider, per-tab mode flip, group auto-move, plan read, submit.
  // Forwarding the COMPOSITE keeps every decision in the owner window —
  // forwarding its pieces individually is what let the mirror's stale pin
  // state suppress the in-progress move.
  implementPlan: { minArgs: 1, maxArgs: 2, tabIdAt: 0 },
  // ── Attachments stage on the ACTIVE tab (no tabId arg — the owner's
  //    active tab matches the mirror's by the single-focus rule) ──
  addAttachments: { minArgs: 1, maxArgs: 1 },
  removeAttachment: { minArgs: 1, maxArgs: 1 },
  clearAttachments: { minArgs: 0, maxArgs: 0 },
  // ── Terminal instances are owner-persisted tab metadata ──
  renameTerminalInstance: { minArgs: 3, maxArgs: 3, tabIdAt: 0 },
}

/**
 * Actions the mirror executes locally, with the reason each is safe.
 * "pass-through" = stateless main-process call (sessionPlane routes to the
 * engine; no renderer-owned durable state). "per-window UI" = view state
 * that intentionally differs between windows. "ingestion" = event-stream
 * reducers — the mirror consumes the same stream as the owner.
 */
export const MIRROR_LOCAL_ACTIONS: Record<string, string> = {
  // Stateless engine pass-throughs.
  respondPermission: 'pass-through: permission_response to engine; cross-surface reconcile via resolution push',
  respondElicitation: 'pass-through: elicitation answer to engine',
  respondEngineDialog: 'pass-through: dialog answer to engine',
  interrupt: 'pass-through: abort to engine; status events update all windows',
  markResourceRead: 'pass-through: mark_read delta via engine broker + local read-state',
  markAllResourcesRead: 'pass-through: mark_read deltas via engine broker + local read-state',
  deleteResource: 'local view of resource list; producer owns persistence',
  // Dismissing the absorbed-into-base notice is per-window UI state: the bench
  // record itself is untouched, and each window's operator dismisses their own
  // notice. Forwarding it would clear the overlay's notice from the ATV.
  clearBenchRetired: 'per-window notice dismissal; no bench mutation',
  // Conflict-alert bookkeeping mutates no git state. record/clear are driven by
  // each window's own inventory refresh and sync results (both windows observe
  // the same main-process truth), and dismissing a toast is per-window UI.
  recordConflictAlert: 'ingestion: derived from inventory/sync results each window already receives',
  clearConflictAlert: 'ingestion: derived from inventory refresh; no git mutation',
  dismissConflictAlert: 'per-window toast dismissal; badges derive from live inventory state',
  runQuickTool: 'pass-through: one-shot tool run',
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
  requestCloseTab: 'per-window close dialog; read-only appraisal, durable close delegates to forwarded closeTab',
  confirmCloseTab: 'per-window dialog dismissal; the durable close routes through forwarded closeTab',
  cancelCloseTab: 'per-window dialog dismissal; no durable state touched',
  // Event-stream ingestion (mirror consumes the same normalized stream).
  handleNormalizedEvent: 'ingestion: normalized-event reducer',
  handleStatusChange: 'ingestion: tab-status reducer',
  handleError: 'ingestion: error reducer',
  insertRemoteUserMessage: 'ingestion: user-message echo insertion',
  addSystemMessage: 'ingestion: local system row',
  addEngineSystemMessage: 'ingestion: local system row',
  loadSkeletonMessages: 'ingestion: lazy history hydration',
  rehydrateFailedHistory: 'ingestion: retry lazy history hydration after engine reconnect',
  initStaticInfo: 'boot: reads static info; no durable writes',
  // Pure read accessor: derives a canonical tail fingerprint from local store
  // state; no writes, no IPC. Safe to run in either window.
  computeConvFingerprint: 'read-only derived value; no mutations',
  submitRemotePrompt: 'owner-only wiring: invoked by the iOS handler, which the mirror never registers',
  // Per-window UI state.
  toggleExpanded: 'per-window UI',
  toggleGitPanel: 'per-window UI',
  closeGitPanel: 'per-window UI',
  toggleStatusDrawer: 'per-window UI',
  closeStatusDrawer: 'per-window UI',
  openDispatchPreview: 'per-window UI',
  toggleTallView: 'per-window UI',
  openSettings: 'per-window UI',
  closeSettings: 'per-window UI',
  incOpenFloatingPanelCount: 'per-window UI',
  decOpenFloatingPanelCount: 'per-window UI',
  setDraftInput: 'per-window UI: drafts are deliberately window-local',
  setEngineDraftInput: 'per-window UI: drafts are deliberately window-local',
  clearPendingInput: 'per-window UI: drafts are deliberately window-local',
  setEditorGeometry: 'per-window UI',
  setPlanGeometry: 'per-window UI',
  setResourceViewerGeometry: 'per-window UI',
  setAgentDetailGeometry: 'per-window UI',
  setWorktreeUncommitted: 'per-window derived cache',
  refreshWorktreeInventory: 'read-only IPC fetch into a per-window derived cache',
  refreshBench: 'read-only IPC fetch into a per-window derived cache',
  // File explorer / editor (window-local workbench state).
  toggleFileExplorer: 'per-window UI',
  collapseAllExplorer: 'per-window UI',
  setFileExplorerExpanded: 'per-window UI',
  setFileExplorerSelected: 'per-window UI',
  toggleFileEditor: 'per-window UI',
  openFileInEditor: 'per-window UI',
  closeFileEditorTab: 'per-window UI',
  setActiveEditorFile: 'per-window UI',
  reorderEditorFiles: 'per-window UI',
  updateEditorContent: 'per-window editor buffer (disk write is a direct fs IPC)',
  markEditorSaved: 'per-window UI',
  toggleEditorPreview: 'per-window UI',
  toggleEditorReadOnly: 'per-window UI',
  createScratchFile: 'per-window UI',
  focusFileEditor: 'per-window UI',
  blurFileEditor: 'per-window UI',
  // Terminals (each window owns its pty pool; the ATV shell does not mount
  // terminals today, but running one locally would be correct).
  toggleTerminal: 'per-window terminal UI',
  toggleTerminalTall: 'per-window terminal UI',
  toggleTerminalBigScreen: 'per-window terminal UI',
  toggleTerminalReadOnly: 'per-window terminal UI',
  selectTerminalInstance: 'per-window terminal UI',
  addTerminalInstance: 'per-window pty pool',
  removeTerminalInstance: 'per-window pty pool',
  getOrCreateDedicatedTerminal: 'per-window pty pool',
  consumeTerminalPendingCommand: 'per-window terminal UI',
  runInTerminal: 'per-window pty pool',
  startBashCommand: 'per-window bash flow',
  completeBashCommand: 'per-window bash flow',
}

/** Wire-shape validation for a forwarded action call (main process). */
export function validForwardedAction(action: unknown, args: unknown): boolean {
  if (typeof action !== 'string') return false
  const spec = FORWARDED_ACTIONS[action]
  if (!spec) return false
  if (!Array.isArray(args) || args.length < spec.minArgs || args.length > spec.maxArgs) return false
  if (spec.tabIdAt != null) {
    const tabId = args[spec.tabIdAt]
    if (typeof tabId !== 'string' || tabId.length === 0 || tabId.length > 128) return false
  }
  return true
}
