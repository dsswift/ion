import Foundation

struct PinOrderAssignment: Codable, Sendable {
  let tabId: String
  let orderKey: String
}

/// Commands sent from iOS to Ion. Mirrors `RemoteCommand` in `src/main/remote/protocol.ts`.
enum RemoteCommand: Sendable {
  case sync
  /// `profileId` and `extensions` are present when the caller wants an
  /// engine-hosted conversation. When absent the desktop creates a plain
  /// CLI tab. This merges the former `desktop_create_engine_tab` wire
  /// command into the unified create-tab shape (#256).
  /// `clientCmdId` is a locally-generated correlation id for the
  /// confirm-or-resend delivery loop (see `SessionViewModel+PendingCreate`).
  /// A create can be silently lost when the transport wedges after a
  /// background/resume cycle — `lan.send` succeeds into a dead socket and
  /// nothing throws — so the client tracks the create as pending and resends
  /// until the desktop echoes this id back on `desktop_tab_created`. The
  /// desktop dedupes by it so a resend re-emits the existing tab, never a
  /// duplicate. Absent (nil) for any non-tracked caller.
  ///
  /// With `useWorktree`: `ephemeralWorktree` nil leaves the answer to the
  /// project's remembered choice, then its `.ion/worktree.json`;
  /// `rememberWorktreeChoice` saves the branch and that answer for the project.
  case createTab(
    workingDirectory: String?, profileId: String? = nil,
    extensions: [String]? = nil, clientCmdId: String? = nil,
    useWorktree: Bool? = nil, sourceBranch: String? = nil,
    ephemeralWorktree: Bool? = nil, rememberWorktreeChoice: Bool? = nil)
  case createTerminalTab(workingDirectory: String?, clientCmdId: String? = nil)
  case closeTab(tabId: String)
  case resetTabSession(tabId: String)
  /// Engine-instance counterpart to `resetTabSession` — stops the engine
  /// session keyed by `${tabId}:${instanceId}` and wipes the renderer-side
  /// per-instance state (messages, status, dialogs, etc.). Used by the
  /// "Implement, clear context" flow on engine tabs. `resetTabSession`
  /// only addresses the CLI session plane and silently misses engine
  /// instances, so engine tabs must send this variant instead.
  case resetEngineSession(tabId: String, instanceId: String)
  /// User-typed prompt routed to the desktop's prompt pipeline.
  ///
  /// iOS does NOT carry the harness-supplied EnterPlanMode tool
  /// description (ADR-004): that's the desktop's responsibility. When
  /// iOS sends `prompt`, the desktop's prompt-pipeline.ts constructs an
  /// `IncomingPrompt` and applies the desktop's
  /// `ENTER_PLAN_MODE_DESCRIPTION` constant automatically before
  /// forwarding to the engine. The model sees the same plan-mode
  /// framing regardless of which client typed the prompt.
  ///
  /// This is deliberate: the desktop is the authoritative harness for
  /// the pairing, and the policy prose (per ADR-004) belongs in the
  /// harness, not the client. iOS would only need to carry an
  /// `enterPlanModeDescription` field of its own if it ever became
  /// an independent harness — at which point it would also need its
  /// own copy of the prose. Today the wire stays minimal.
  /// `instanceId` scopes the prompt to a specific engine instance. When
  /// present the desktop routes through the engine pipeline (isEngineTab=true).
  /// When absent the desktop uses the CLI pipeline. This merges the former
  /// `desktop_engine_prompt` wire command into the unified prompt shape (#256).
  /// `traceparent` names the phone's `prompt.send` span: the server's
  /// `prompt.handle` span joins that trace, and the frame carrying the prompt
  /// sets it on its outer envelope for the relay's `relay.forward` span.
  case prompt(
    tabId: String, text: String, origin: String? = "remote", clientMsgId: String? = nil,
    attachments: [CommandAttachment]? = nil, implementationPhase: Bool? = nil,
    instanceId: String? = nil, traceparent: String? = nil)
  case cancel(tabId: String, scope: String? = nil)
  case abortDispatch(tabId: String, dispatchId: String)
  /// Stop one exact background Bash task through the paired desktop.
  case stopBackgroundTask(tabId: String, taskId: String, requestId: String)
  case respondPermission(tabId: String, questionId: String, optionId: String)
  /// Answer a live extension elicitation (ctx.elicit). `cancelled` true means
  /// the user declined; `response` carries the approval payload (empty object
  /// on a plain approve). Lockstep desktop↔iOS wire — mirrors the desktop's
  /// `desktop_respond_elicitation` command.
  case respondElicitation(
    tabId: String, requestId: String, response: [String: AnyCodable]?, cancelled: Bool,
    declined: Bool = false)
  case setPermissionMode(tabId: String, mode: PermissionMode)
  /// This device's unsent composer text for a conversation.
  ///
  /// The draft is durable conversation state the host persists, not a local
  /// scratchpad: sending it is what lets the same half-written prompt appear
  /// in Ion Studio, and what makes it survive a host restart. Debounced at the
  /// call site (see SessionViewModel+Drafts.swift) so normal typing does not
  /// put a frame on the wire per character.
  case setDraft(tabId: String, text: String)
  /// Start (`on: true`) or stop the connected Environment's System Metrics
  /// summary (`desktop_system_metrics`, every 10 s). The phone watches while
  /// it is in the foreground and connected.
  case systemMetricsWatch(on: Bool)
  /// Per-conversation extended-thinking effort change. effort is one of
  /// "off"|"low"|"medium"|"high". The desktop applies it to the same
  /// per-conversation state its own prompts read, so the next prompt from
  /// either client carries the level. Lockstep desktop↔iOS wire.
  case setThinkingEffort(tabId: String, effort: String)
  /// Inbox actions (settle/snooze/mark-unread). The desktop routes each
  /// into the owner renderer's forwarded store action; the next snapshot
  /// reflects the change on every client. Lockstep desktop↔iOS wire.
  case tabSettle(tabId: String)
  /// Permanently delete a conversation and its stored transcript on the desktop.
  case tabDelete(tabId: String)
  case tabUnsettle(tabId: String)
  case tabSnooze(tabId: String, untilMs: Double)
  case tabUnsnooze(tabId: String)
  /// Hold the server's resume prompt until the usage limit that stopped this conversation resets.
  case tabResumeAtReset(tabId: String)
  case tabSnoozeUntilReset(tabId: String)
  /// Hold `text` until the conversation's account has weekly quota about to reset unused.
  case tabQueueSpareQuota(tabId: String, text: String)
  case tabCancelHeldPrompt(tabId: String)
  case tabSendHeldPrompt(tabId: String)
  case tabMarkUnread(tabId: String)
  case tabPin(tabId: String)
  case tabUnpin(tabId: String)
  case tabReorderPin(assignments: [PinOrderAssignment])
  case tabRegenerateTitle(tabId: String)
  /// Materialize a cold settled-history record as a temporary review tab.
  case requestTranscript(tabId: String, requestId: String)
  case reviewSettledTab(tabId: String)
  /// One page of a conversation's transcript (`studio_body_request`). `before`
  /// nil asks for the newest page, which subscribes this connection to the
  /// transcript's patches. See SessionViewModel+Transcript.swift.
  case loadConversation(tabId: String, before: String?, pageSize: Int? = nil, held: TranscriptRevision? = nil)
  /// Ask the desktop to replay wire frames [fromSeq, toSeq] after iOS detected
  /// a forward seq gap (frames lost in transit, e.g. a LAN↔relay transport
  /// switch). The desktop replays the byte-identical originals from its
  /// retransmit buffer, or answers desktop_resend_unavailable. Lockstep wire.
  case requestResend(fromSeq: UInt64, toSeq: UInt64)
  case terminalInput(tabId: String, instanceId: String, data: String)
  case terminalResize(tabId: String, instanceId: String, cols: Int, rows: Int)
  case terminalAddInstance(tabId: String)
  /// Run one of the operator's own Quick Tools in the conversation's
  /// terminal. Only the id travels: the server reads the command from the
  /// operator's settings, so the phone never supplies a shell command.
  case runQuickTool(tabId: String, toolId: String)
  case terminalRemoveInstance(tabId: String, instanceId: String)
  case terminalSelectInstance(tabId: String, instanceId: String)
  case requestTerminalSnapshot(tabId: String)
  /// Ask the desktop to open a terminal-owned web application in its native
  /// content surface. iOS sends intent because the URL targets the desktop host.
  case openTerminalApplication(tabId: String, url: String)

  /// Ask the desktop to re-send one tab's agent roster.
  ///
  /// Scoped deliberately rather than reusing `sync`, which rebuilds every
  /// tab plus engine profiles, settings, and terminal buffers. Sent after a
  /// degraded roster arrives (`metadataOmitted`) or a gap is detected.
  case requestAgentState(tabId: String, instanceId: String?)
  /// Request on-demand context breakdown from the desktop for a tab.
  /// The desktop forwards get_context_breakdown to the engine; the result
  /// arrives as desktop_context_breakdown and populates inst.contextBreakdown.
  case requestContextBreakdown(tabId: String)
  case renameTab(tabId: String, customTitle: String?)
  case renameTerminalInstance(tabId: String, instanceId: String, label: String)
  case forkFromMessage(tabId: String, messageId: String)
  /// Rewind an engine-tab instance's conversation to a chosen message.
  /// Mirrors the desktop `engine_rewind` remote command: the desktop
  /// stops the engine session, starts a fresh one, truncates the
  /// instance's messages, and replies with an `input_prefill` carrying
  /// the rewound user message. This is the one tree-native rewind command for
  /// Plain and extension-hosted tabs; `instanceId` selects the tab's active
  /// conversation-pane instance (`main` for a Plain tab).
  ///
  /// `userTurnIndex` is the 0-based index of the target among role==.user
  /// messages. The desktop tries `messageId` as an EXACT match against its
  /// own conversation first (this already succeeds whenever the row was
  /// re-keyed to the engine's durable entry id by a prior
  /// `desktop_user_turn_persisted` / `desktop_engine_message_end` /
  /// `desktop_steer_injected`), falling back to `userTurnIndex` only when
  /// that lookup misses — which happens for a row still carrying iOS's own
  /// optimistic UUID (the desktop never minted it). Nil only for callers
  /// that can guarantee a desktop-minted id.
  case engineRewind(tabId: String, instanceId: String, messageId: String, userTurnIndex: Int?)
  case unpair
  /// First message sent on a freshly opened channel when the connected server
  /// advertises OIDC via `GET /auth/config`. The server validates `token`
  /// against `(issuer, audience, scope)` before treating the channel as
  /// authenticated. Sent once per connection, not per-command; resent with a
  /// fresh token whenever the transport reconnects after a token expiry. See
  /// `OIDCTokenManagerRegistry` for how the token is acquired.
  ///
  /// The Studio wire carries a bearer on its hello rather than as a command,
  /// so its mapping drops this one; it stays for a consumer whose wire needs
  /// an in-band auth message.
  case desktopAuth(token: String)
  case engineAbort(tabId: String, instanceId: String? = nil)
  case engineDialogResponse(
    tabId: String, dialogId: String, value: String, instanceId: String? = nil)
  // Multi-instance conversation commands removed in #256 (single-instance collapse).
  // engineAddInstance, engineRemoveInstance, engineRenameInstance, engineSelectInstance,
  // engineMoveInstance are no longer sent. The desktop dispatch already
  // silently dropped them; removing the iOS send path completes the cleanup.
  /// One page of a dispatched agent's transcript (`studio_body_request`
  /// naming the dispatch). `before` nil asks for the newest page, which
  /// subscribes this connection to the dispatch's transcript patches.
  case loadDispatchTranscript(tabId: String, conversationId: String, dispatchId: String, before: String?, pageSize: Int, held: TranscriptRevision? = nil)
  case engineSetModel(tabId: String, model: String, instanceId: String? = nil)
  // providerId, when known, is the provider group the operator explicitly
  // picked -- carried so the server can qualify the wire model id and this
  // explicit choice can never be silently rerouted by defaultProvider bias.
  case setTabModel(tabId: String, model: String, providerId: String? = nil)
  /// This phone's Personal preferences, declared to the server once per
  /// connection and on change. The server holds them for the life of the
  /// connection and stamps them onto conversations this phone creates or
  /// prompts; it keeps no settings copy. See `PersonalPreferencesStore`.
  case declarePreferences(preferences: [String: JSONValue])
  /// Where this phone receives pushes: its APNs token and the environment
  /// that issued it (`APNsEnvironment`). Sent to the connected server once
  /// per connection and whenever the token changes. The server keeps it on
  /// this phone's pairing and sends it with every push it rings.
  case registerPush(token: String, env: String)
  case gitChanges(directory: String)
  case gitBranches(directory: String)
  case gitGraph(directory: String, skip: Int? = nil, limit: Int? = nil)
  case gitDiff(directory: String, path: String, staged: Bool)
  case gitStage(directory: String, paths: [String])
  case gitUnstage(directory: String, paths: [String])
  case gitCommit(directory: String, message: String)
  case gitDiscard(directory: String, paths: [String])
  case gitFetch(directory: String)
  case gitPull(directory: String)
  case gitPush(directory: String)
  case gitCommitFiles(directory: String, hash: String)
  case gitCommitFileDiff(directory: String, hash: String, path: String)
  // ── Worktree + integration bench (see Models/WorktreeTypes.swift) ──
  case worktreeRefresh(repoPath: String)
  /// `newConversation: true` creates an ADDITIONAL conversation; false (the
  /// default) opens or cycles the existing ones, which is what tapping a row
  /// does. One command, two verbs -- a parallel case would duplicate the relay
  /// and the owner-window routing behind it.
  case worktreeOpenConversation(worktreePath: String, newConversation: Bool)
  case worktreeSync(worktreePath: String, sourceBranch: String, repoPath: String)
  /// Bulk sync: every managed worktree of the repo, run by the desktop
  /// sequentially with rerere replay between rebases. The mechanical pass
  /// only — the desktop's AI escalation never runs from this command (same
  /// desktop-only precedent as conflict resolution). The outcome arrives as
  /// a `sync_all` op result carrying a pre-worded `summary`.
  case worktreeSyncAll(repoPath: String)
  case worktreeLandAndRetire(
    repoPath: String, worktreePath: String, worktreeBranch: String, sourceBranch: String)
  case benchOpenConversation(repoPath: String, sourceBranch: String)
  /// Open (or focus) the bench's ONE dedicated terminal tab. Distinct from
  /// `benchOpenConversation`: a shell and a conversation are different things
  /// to want, and the desktop keeps exactly one terminal per bench rather than
  /// stacking a new one per press.
  case benchOpenTerminal(repoPath: String, sourceBranch: String)
  case benchAssemble(repoPath: String, sourceBranch: String)
  case benchUpdateMember(repoPath: String, sourceBranch: String, worktreePath: String)
  case benchUpdateAll(repoPath: String, sourceBranch: String)
  /// Set or clear the operator's workflow stage on a worktree. Worktree-scoped
  /// (no sourceBranch): the stage lives in the desktop's worktree registry,
  /// not on a bench member, so it applies to unenrolled worktrees too. A nil
  /// stage clears, so re-selecting the active stage un-sets it.
  case worktreeSetStage(repoPath: String, worktreePath: String, stage: String?)
  /// Move a member in the merge order. Order is array position on the desktop,
  /// so this is an index rather than a stored rank.
  case benchReorderMember(
    repoPath: String, sourceBranch: String, worktreePath: String, toIndex: Int)
  case benchAddMember(
    repoPath: String, sourceBranch: String, worktreePath: String, branchName: String)
  case benchRemoveMember(repoPath: String, sourceBranch: String, worktreePath: String)
  case worktreeRetireLanded(repoPath: String)
  case worktreeCreate(repoPath: String, sourceBranch: String)
  case worktreeConvertConversation(tabId: String)
  case worktreeRename(repoPath: String, worktreePath: String, title: String)
  case worktreeReprovision(repoPath: String, worktreePath: String)
  case benchRecoverConflict(repoPath: String, sourceBranch: String)
  case benchAnalyseVerification(repoPath: String, sourceBranch: String)
  case benchDiscardMemberRecordings(repoPath: String, sourceBranch: String, branchNames: [String])
  case benchDiscardAllRecordings(repoPath: String, sourceBranch: String)
  /// Retire ONE worktree (unlanded or landed). The desktop appraises and can
  /// refuse (refusedDirty) — the op result distinguishes that from a failure.
  case worktreeRetire(repoPath: String, worktreePath: String, branchName: String)
  /// Launch the AI-assisted conflict resolver on a conflicted worktree
  /// (operationState set). Answers with a `conflict_assist` op result whose
  /// tabId is the resolver conversation.
  case worktreeConflictAssist(repoPath: String, worktreePath: String)
  /// Bench chain: recreate the failed assembly merge, then launch the
  /// assisted resolver on the bench directory.
  case benchConflictAssist(repoPath: String, sourceBranch: String)
  /// The full sync pipeline (mechanical pass → AI gate → agents → assembly).
  /// Progress rides `desktop_worktree_pipeline` events.
  case worktreePipelineStart(repoPath: String, sourceBranch: String)
  case worktreePipelineConfirmAi(repoPath: String)
  case worktreePipelineCancel(repoPath: String)
  case worktreePipelineDismiss(repoPath: String)
  case fsListDir(directory: String, includeHidden: Bool = false)
  case fsReadFile(filePath: String)
  case fsReadImage(filePath: String)
  /// Lazy fetch of one theme-pack image asset after a
  /// `desktop_theme_manifest` whose descriptor sha256 misses the local
  /// cache. Desktop answers with `desktopThemeAssetContent`.
  case requestThemeAsset(themeId: String, slot: String)
  case fsWriteFile(filePath: String, content: String)
  /// Rename a file or directory inside a project root on the paired
  /// desktop. The desktop validates both paths via `isValidProjectPath`
  /// and replies with `fsRenameResult`. iOS does not synthesize an
  /// optimistic local rename — the file listing is owned by the
  /// desktop, so we wait for the result event and re-issue
  /// `fsListDir` on the parent directory to refresh.
  case fsRename(oldPath: String, newPath: String)
  case discoverCommands(directory: String)
  case uploadAttachment(dataUrl: String, name: String, correlationId: String)
  case loadAttachments(tabId: String)
  /// Read a conversation's branches (`engine.listBranches`); answered with `conversationBranches`.
  case listBranches(tabId: String)
  /// Make the branch ending at `leafId` the active path (`engine.switchBranch`). The new
  /// transcript arrives as a transcript replace; a refusal as `branchSwitchResult`.
  case switchBranch(tabId: String, leafId: String)
  case voiceConfig(enabled: Bool, mode: String, systemPrompt: String?)
  /// Send collected iOS diagnostic logs to the desktop. `pairingId` is the
  /// ECDH channel ID (`activeDeviceId`) that identifies which desktop pairing
  /// collected these logs — it is NOT the per-device hardware identity
  /// (`device_id`), which is stamped on every log line by iOS directly.
  ///
  /// `withheldUnstamped` / `withheldOtherPairing` count lines newer than the
  /// request's cursor that the pairing filter kept back. The cursor still
  /// advances past them, so the desktop needs the counts to tell "nothing
  /// new" apart from "lines were written and none were sent".
  case diagnosticLogsResponse(
    logs: String, pairingId: String, nextSeq: Int,
    withheldUnstamped: Int = 0, withheldOtherPairing: Int = 0)
  /// Set the per-desktop display override. `updatedAt` is ms since epoch
  /// (`Date().timeIntervalSince1970 * 1000`). The desktop applies LWW and
  /// broadcasts the canonical value back via `.remoteDisplay`.
  case setRemoteDisplay(customName: String?, customIcon: String?, updatedAt: Date)
  /// Write-back for a single projectable desktop setting. The desktop
  /// validates `key` against its allowlist (see
  /// `desktop/src/main/projectable-settings.ts`) and validates
  /// `value`'s runtime type matches the declared type before
  /// persisting. Unknown keys and wrong-type values are silently
  /// rejected on the desktop. After a successful write the desktop
  /// broadcasts a fresh `desktopSettingsSnapshot` event so every
  /// paired iOS device (including this one) sees the new value.
  ///
  /// `value` is type-erased on the wire — the supported runtime
  /// types are Bool, String, and Double (Swift's `Int`/`Double`
  /// distinction collapses to Double on JSON round-trip; the
  /// desktop's validator coerces back to its declared type). The
  /// iOS UI today only emits Bool, but the wire shape is
  /// shape-agnostic so future string/number projections need no
  /// protocol change.
  case setDesktopSetting(key: String, value: AnyCodable)
  /// Set the custom pill background color for a tab.
  /// `pillColor` is a hex string (e.g. "#f08c4a") or nil to reset to the theme default.
  case setPillColor(tabId: String, pillColor: String?)
  /// Report iOS device focus to the desktop for intercept routing.
  /// Sent when the user switches tabs, the app foregrounds, or the
  /// intercept preference changes. `tabId: nil` means the app is
  /// backgrounded (no active tab). `interceptEnabled` carries the
  /// current value of the "Allow conversation intercepts" UserDefaults
  /// preference (default true). The desktop stores this in `deviceFocusMap`
  /// and uses it to decide whether to perform redirect-level intercepts
  /// on behalf of this device.
  case reportFocus(tabId: String?, interceptEnabled: Bool)
  /// Display-only account summary for this paired phone. No access or refresh
  /// token crosses the wire; desktop persists it as last-reported context.
  case reportMobileAuth(
    accountUsername: String?, accountName: String?, subject: String?, tenantId: String?,
    signedInAt: Date?, clearIdentity: Bool, accessStatus: String?, accessReason: String?,
    reportedAt: Date?)
  /// Request the full content for a single resource item from the
  /// desktop's renderer store. Sent when the user taps a resource card
  /// to expand it. The snapshot carries only metadata (id, kind, title,
  /// createdAt, read) to keep the payload small; content arrives via
  /// the `resource_content` event in response to this command.
  case requestResourceContent(kind: String, producer: String? = nil, resourceId: String)

  /// Notify the desktop that the user read a resource on iOS. The desktop
  /// persists the read state and publishes a mark_read delta through the
  /// engine so all subscribers converge.
  case markResourceRead(kind: String, producer: String? = nil, resourceId: String)

  /// Permanently remove a notification from the global resource broker.
  /// The desktop publishes a delete delta through the engine so all
  /// subscribers (desktop + iOS) remove the item from their collections.
  case deleteResource(kind: String, producer: String? = nil, resourceId: String)

  // MARK: - Plan implement intent (plan gentle-perching-lemon)

  /// Ask the desktop to run the implement pipeline for an ExitPlanMode
  /// permission entry. iOS sends intent only — no plan body crosses the
  /// wire. The desktop resolves the plan file path from its renderer
  /// store, reads the plan from disk, runs setPermissionMode→auto,
  /// inserts the implement divider, and calls processIncomingPrompt with
  /// implementationPhase=true + the plan attachment.
  ///
  /// `clearContext` maps to the "Implement, clear context" button: the
  /// desktop resets the engine session before implementing. Omit or pass
  /// false for the regular Implement action (preserves conversation).
  case implementPlan(tabId: String, questionId: String, instanceId: String?, clearContext: Bool)

  /// Request a bounded byte-range window of the plan file from the desktop.
  /// iOS pages through the plan in 64 KB windows by sending successive
  /// commands with increasing offsets until the server responds with
  /// `hasMore: false`. `length: 0` signals "use server default (64 KB)".
  /// The desktop replies with a `plan_content` event carrying the window.
  case requestPlanContent(
    tabId: String, questionId: String, planFilePath: String, offset: Int, length: Int)

  // ── Guided Questions (see Models/QuestionsModels.swift) ──
  /// Revisioned draft patch for a guided-questions workflow. The desktop
  /// main coordinator compare-and-sets by expectedRevision; a stale patch is
  /// rejected and the authoritative state comes back on
  /// desktop_questions_state for rollback.
  case questionsPatch(tabId: String, patch: QuestionsPatch)
  /// Revisioned workflow action (enter_review / edit_question /
  /// request_more / final_confirm / cancel).
  case questionsAction(tabId: String, action: QuestionsAction)
  /// Targeted re-send of the authoritative Questions state (reconnect,
  /// sequence loss).
  case questionsRefresh(tabId: String)

  // MARK: - Codable

  /// `CaseIterable` so a test can enumerate the wire names this client can
  /// send and compare them against the shared command map.
  enum TypeKey: String, Codable, CaseIterable {
    case sync = "desktop_sync"
    case createTab = "desktop_create_tab"
    case createTerminalTab = "desktop_create_terminal_tab"
    case closeTab = "desktop_close_tab"
    case resetTabSession = "desktop_reset_tab_session"
    case resetEngineSession = "desktop_reset_engine_session"
    case prompt = "desktop_prompt"
    case cancel = "desktop_cancel"
    case abortDispatch = "desktop_abort_dispatch"
    case stopBackgroundTask = "desktop_stop_background_task"
    case respondPermission = "desktop_respond_permission"
    case respondElicitation = "desktop_respond_elicitation"
    case setPermissionMode = "desktop_set_permission_mode"
    case setDraft = "desktop_set_draft"
    case systemMetricsWatch = "desktop_system_metrics_watch"
    case setThinkingEffort = "desktop_set_thinking_effort"
    case tabSettle = "desktop_tab_settle"
    case tabDelete = "desktop_tab_delete"
    case tabUnsettle = "desktop_tab_unsettle"
    case tabSnooze = "desktop_tab_snooze"
    case tabUnsnooze = "desktop_tab_unsnooze"
    case tabResumeAtReset = "desktop_tab_resume_at_reset"
    case tabSnoozeUntilReset = "desktop_tab_snooze_until_reset"
    case tabQueueSpareQuota = "desktop_tab_queue_spare_quota"
    case tabCancelHeldPrompt = "desktop_tab_cancel_held_prompt"
    case tabSendHeldPrompt = "desktop_tab_send_held_prompt"
    case tabMarkUnread = "desktop_tab_mark_unread"
    case tabPin = "desktop_tab_pin"
    case tabUnpin = "desktop_tab_unpin"
    case tabReorderPin = "desktop_tab_reorder_pin"
    case tabRegenerateTitle = "desktop_tab_regenerate_title"
    case requestTranscript = "desktop_request_transcript"
    case reviewSettledTab = "desktop_review_settled_tab"
    case loadConversation = "desktop_load_conversation"
    case requestResend = "desktop_request_resend"
    case terminalInput = "desktop_terminal_input"
    case terminalResize = "desktop_terminal_resize"
    case terminalAddInstance = "desktop_terminal_add_instance"
    case runQuickTool = "desktop_run_quick_tool"
    case terminalRemoveInstance = "desktop_terminal_remove_instance"
    case terminalSelectInstance = "desktop_terminal_select_instance"
    case requestTerminalSnapshot = "desktop_request_terminal_snapshot"
    case openTerminalApplication = "desktop_open_terminal_application"
    case requestAgentState = "desktop_request_agent_state"
    case requestContextBreakdown = "desktop_request_context_breakdown"
    case renameTab = "desktop_rename_tab"
    case renameTerminalInstance = "desktop_rename_terminal_instance"
    case forkFromMessage = "desktop_fork_from_message"
    case engineRewind = "desktop_engine_rewind"
    case unpair = "desktop_unpair"
    case desktopAuth = "desktop_auth"
    case engineAbort = "desktop_engine_abort"
    case engineDialogResponse = "desktop_engine_dialog_response"
    // Multi-instance TypeKeys removed in #256. The desktop dispatch
    // already silently ignored these; no wire traffic expected.
    // loadEngineConversation TypeKey retired in WI-004 / #259. iOS now
    // sends loadConversation for every tab.
    case loadDispatchTranscript = "desktop_load_dispatch_transcript"
    case engineSetModel = "desktop_engine_set_model"
    case setTabModel = "desktop_set_tab_model"
    case declarePreferences = "desktop_declare_preferences"
    case registerPush = "desktop_register_push"
    case gitChanges = "desktop_git_changes"
    case gitBranches = "desktop_git_branches"
    case gitGraph = "desktop_git_graph"
    case gitDiff = "desktop_git_diff"
    case gitStage = "desktop_git_stage"
    case gitUnstage = "desktop_git_unstage"
    case gitCommit = "desktop_git_commit"
    case gitDiscard = "desktop_git_discard"
    case gitFetch = "desktop_git_fetch"
    case gitPull = "desktop_git_pull"
    case gitPush = "desktop_git_push"
    case gitCommitFiles = "desktop_git_commit_files"
    case gitCommitFileDiff = "desktop_git_commit_file_diff"
    case worktreeRefresh = "desktop_worktree_refresh"
    case worktreeOpenConversation = "desktop_worktree_open_conversation"
    case worktreeSync = "desktop_worktree_sync"
    case worktreeSyncAll = "desktop_worktree_sync_all"
    case worktreeLandAndRetire = "desktop_worktree_land_and_retire"
    case benchOpenConversation = "desktop_bench_open_conversation"
    case benchOpenTerminal = "desktop_bench_open_terminal"
    case benchAssemble = "desktop_bench_assemble"
    case benchUpdateMember = "desktop_bench_update_member"
    case benchUpdateAll = "desktop_bench_update_all"
    case worktreeSetStage = "desktop_worktree_set_stage"
    case benchReorderMember = "desktop_bench_reorder_member"
    case benchAddMember = "desktop_bench_add_member"
    case benchRemoveMember = "desktop_bench_remove_member"
    case worktreeRetireLanded = "desktop_worktree_retire_landed"
    case worktreeCreate = "desktop_worktree_create"
    case worktreeConvertConversation = "desktop_worktree_convert_conversation"
    case worktreeRename = "desktop_worktree_rename"
    case worktreeReprovision = "desktop_worktree_reprovision"
    case benchRecoverConflict = "desktop_bench_recover_conflict"
    case benchAnalyseVerification = "desktop_bench_analyse_verification"
    case benchDiscardMemberRecordings = "desktop_bench_discard_member_recordings"
    case benchDiscardAllRecordings = "desktop_bench_discard_all_recordings"
    case worktreeRetire = "desktop_worktree_retire"
    case worktreeConflictAssist = "desktop_worktree_conflict_assist"
    case benchConflictAssist = "desktop_bench_conflict_assist"
    case worktreePipelineStart = "desktop_worktree_pipeline_start"
    case worktreePipelineConfirmAi = "desktop_worktree_pipeline_confirm_ai"
    case worktreePipelineCancel = "desktop_worktree_pipeline_cancel"
    case worktreePipelineDismiss = "desktop_worktree_pipeline_dismiss"
    case fsListDir = "desktop_fs_list_dir"
    case fsReadFile = "desktop_fs_read_file"
    case fsReadImage = "desktop_fs_read_image"
    case requestThemeAsset = "desktop_request_theme_asset"
    case fsWriteFile = "desktop_fs_write_file"
    case fsRename = "desktop_fs_rename"
    case discoverCommands = "desktop_discover_commands"
    case uploadAttachment = "desktop_upload_attachment"
    case loadAttachments = "desktop_load_attachments"
    case listBranches = "desktop_list_branches"
    case switchBranch = "desktop_switch_branch"
    case voiceConfig = "desktop_voice_config"
    case diagnosticLogsResponse = "desktop_diagnostic_logs_response"
    case setRemoteDisplay = "desktop_set_remote_display"
    case setDesktopSetting = "desktop_set_desktop_setting"
    case setPillColor = "desktop_set_pill_color"
    case reportFocus = "desktop_report_focus"
    case reportMobileAuth = "desktop_report_mobile_auth"
    case requestResourceContent = "desktop_request_resource_content"
    case markResourceRead = "desktop_mark_resource_read"
    case deleteResource = "desktop_delete_resource"
    case implementPlan = "desktop_implement_plan"
    case requestPlanContent = "desktop_request_plan_content"
    case questionsPatch = "desktop_questions_patch"
    case questionsAction = "desktop_questions_action"
    case questionsRefresh = "desktop_questions_refresh"
  }


  // `init(from decoder:)` is in RemoteCommand+Decode.swift to keep this
  // file under the 600-line Swift cap. The encode counterpart lives in
  // RemoteCommand+Encode.swift.

}

/// Attachment metadata sent with prompt and engine_prompt commands.
struct CommandAttachment: Codable, Sendable {
  let type: String  // "image" or "file"
  let name: String
  let path: String
  /// Exact SHA-256 identity of image bytes. Nil for legacy/file attachments.
  let contentHash: String?
}
