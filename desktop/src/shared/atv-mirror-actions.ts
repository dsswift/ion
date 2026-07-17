/**
 * atv-mirror-actions — the classification contract of the mirror-store
 * architecture (see the ATV shell ADR).
 *
 * The ATV window runs the real session store in MIRROR mode. Every store
 * action must be classified in exactly one of two tables:
 *
 *   - FORWARDED_ACTIONS: mutations of owner-durable state (tabs, groups,
 *     worktrees, the prompt pipeline). In the mirror these are swapped for
 *     IPC forwarders — the OWNER (overlay renderer) executes them, and the
 *     resulting state returns to the mirror via events / sync pushes.
 *   - MIRROR_LOCAL_ACTIONS: safe to run in the mirror — per-window UI state,
 *     stateless engine pass-throughs, or event-stream ingestion.
 *
 * The mirror-parity test enumerates the store at runtime and fails when an
 * action is unclassified or double-classified: adding a store action forces
 * an explicit parity decision. Main-process validation of atv:forward-action
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
  runQuickTool: 'pass-through: one-shot tool run',
  // Event-stream ingestion (mirror consumes the same normalized stream).
  handleNormalizedEvent: 'ingestion: normalized-event reducer',
  handleStatusChange: 'ingestion: tab-status reducer',
  handleError: 'ingestion: error reducer',
  insertRemoteUserMessage: 'ingestion: user-message echo insertion',
  addSystemMessage: 'ingestion: local system row',
  addEngineSystemMessage: 'ingestion: local system row',
  loadSkeletonMessages: 'ingestion: lazy history hydration',
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
