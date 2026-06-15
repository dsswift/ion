import Foundation

/// Events sent from Ion to the iOS app.
/// Mirrors `RemoteEvent` in `src/main/remote/protocol.ts`.
/// (RemoteTabGroup, used by the snapshot event, lives in RemoteTabGroup.swift.)
enum RemoteEvent: Sendable {
    case snapshot(tabs: [RemoteTabState], recentDirectories: [String], tabGroupMode: String?, tabGroups: [RemoteTabGroup]?, preferredModel: String?, engineDefaultModel: String?, availableModels: [RemoteModelEntry]?, customName: String?, customIcon: String?, remoteDisplayUpdatedAt: Date?, resources: [String: [[String: AnyCodable]]]?)
    case tabCreated(tab: RemoteTabState)
    case tabClosed(tabId: String)
    case tabStatus(tabId: String, status: TabStatus)
    case textChunk(tabId: String, text: String)
    case toolCall(tabId: String, toolName: String, toolId: String)
    case toolResult(tabId: String, toolId: String, content: String, isError: Bool)
    case taskComplete(tabId: String, result: String, costUsd: Double)
    case permissionRequest(tabId: String, instanceId: String?, questionId: String, toolName: String, toolInput: [String: AnyCodable]?, options: [PermissionOption])
    case permissionResolved(tabId: String, questionId: String)
    case conversationHistory(tabId: String, messages: [Message], hasMore: Bool, cursor: String?)
    case messageAdded(tabId: String, message: Message)
    case messageUpdated(tabId: String, messageId: String, content: String?, toolStatus: ToolStatus?, toolInput: String?)
    case queueUpdate(tabId: String, prompts: [String])
    case error(tabId: String, message: String)
    /// Desktop revoked this device's pairing -- clear local state.
    case unpair
    /// Desktop pushed updated relay configuration.
    case relayConfig(relayUrl: String, relayApiKey: String)
    /// Desktop pushed the per-desktop display override. Sent live to all
    /// connected paired phones when any phone (or the desktop UI) writes
    /// a new value; also delivered in the `snapshot` event on reconnect.
    /// LWW: clients apply this only if `updatedAt > local cached value`.
    case remoteDisplay(customName: String?, customIcon: String?, updatedAt: Date)
    /// Synthesized by TransportManager when the desktop peer disconnects.
    case peerDisconnected
    /// Synthesized by TransportManager during the disconnect grace period
    /// (transports dropped but may recover within 4s).
    case transportReconnecting
    /// Heartbeat from the desktop with sender timestamp and queue depth.
    case heartbeat(senderTs: Double, buffered: Int)
    /// Desktop is prefilling input text (after rewind or fork).
    /// `instanceId` is set when the prefill targets a specific engine
    /// instance's draft (engine_rewind); nil for CLI-tab rewinds.
    case inputPrefill(tabId: String, text: String, switchTo: Bool, instanceId: String?)
    // Terminal events
    case terminalOutput(tabId: String, instanceId: String, data: String)
    case terminalExit(tabId: String, instanceId: String, exitCode: Int)
    case terminalInstanceAdded(tabId: String, instance: TerminalInstanceInfo)
    case terminalInstanceRemoved(tabId: String, instanceId: String)
    case terminalSnapshot(tabId: String, instances: [TerminalInstanceInfo], activeInstanceId: String?, buffers: [String: String]?)
    // Engine events (structured)
    case engineAgentState(tabId: String, instanceId: String?, agents: [AgentStateUpdate])
    case engineStatus(tabId: String, instanceId: String?, fields: StatusFields, metadata: [String: AnyCodable]?)
    /// Phase 3 of the state-management overhaul: engine_session_status
    /// is the typed-payload counterpart to engine_status. The engine
    /// emits both events for every status transition during the
    /// transition window; consumers may read either. SessionStatus
    /// carries `lastEmittedAt` (freshness contract) and
    /// `hasInflightRun` (the engine's cross-checked answer to "is
    /// there a live run") that the legacy event does not.
    case engineSessionStatus(tabId: String, instanceId: String?, sessionStatus: SessionStatus, metadata: [String: AnyCodable]?)
    case engineWorkingMessage(tabId: String, instanceId: String?, message: String, metadata: [String: AnyCodable]?)
    case engineToolStart(tabId: String, instanceId: String?, toolName: String, toolId: String)
    case engineToolEnd(tabId: String, instanceId: String?, toolId: String, result: String?, isError: Bool)
    case engineToolUpdate(tabId: String, instanceId: String?)
    case engineToolComplete(tabId: String, instanceId: String?)
    case engineToolStalled(tabId: String, instanceId: String?, toolId: String, toolName: String, elapsed: Double)
    /// Engine progress watchdog tripped: this run made no forward
    /// progress (no provider stream events, no tool results, no turn
    /// boundaries) for longer than the configured threshold and the
    /// engine has cancelled it as a safety backstop. Advisory only —
    /// the authoritative completion signal still arrives via the
    /// follow-up engine_task_complete + engine_dead/idle events. See
    /// the Go-side RunStalledEvent doc for the watchdog contract.
    case engineRunStalled(tabId: String, instanceId: String?, stalledDuration: Double, lastActivity: String?)
    /// Engine drained a mid-turn steer message into the conversation as
    /// a user turn before the next LLM call. The desktop renders a
    /// "Steer applied" divider into the engineMessages scrollback; iOS
    /// mirrors the same divider so the user sees confirmation across
    /// both clients. The body is not carried over the wire — the steer
    /// message is already part of the conversation. See the Go-side
    /// SteerInjectedEvent and the TS engine_steer_injected variant.
    case engineSteerInjected(tabId: String, instanceId: String?, messageLength: Int)
    case engineScheduleFired(tabId: String, instanceId: String?)
    case engineLlmCall(tabId: String, instanceId: String?)
    case engineDispatchStart(tabId: String, instanceId: String?)
    case engineError(tabId: String, instanceId: String?, message: String)
    case engineNotify(tabId: String, instanceId: String?, message: String, level: String, metadata: [String: AnyCodable]?)
    case engineDialog(tabId: String, instanceId: String?, dialogId: String, method: String, title: String, options: [String]?, defaultValue: String?)
    case engineDialogResolved(tabId: String, instanceId: String?, dialogId: String)
    case engineTextDelta(tabId: String, instanceId: String?, text: String)
    case engineMessageEnd(tabId: String, instanceId: String?, inputTokens: Int, outputTokens: Int, contextPercent: Double, cost: Double)
    case engineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String])
    case engineInstanceAdded(tabId: String, instanceId: String, label: String)
    case engineInstanceRemoved(tabId: String, instanceId: String)
    case engineInstanceMoved(sourceTabId: String, instanceId: String, targetTabId: String)
    /// `metadata` is an opaque harness-defined hints map the engine forwards
    /// verbatim. iOS does not yet act on the field, but decoding it cleanly
    /// here means future iOS handlers (e.g. dedupKey-based rendering) can
    /// adopt the convention without a wire-protocol change. `AnyCodable`
    /// is the same pass-through JSON helper used by `desktopSettingsSnapshot`.
    case engineHarnessMessage(tabId: String, instanceId: String?, message: String, source: String?, metadata: [String: AnyCodable]?)
    case engineConversationHistory(tabId: String, instanceId: String?, messages: [Message])
    case agentConversationHistory(agentName: String, conversationId: String?, messages: [Message])
    case engineModelOverride(tabId: String, instanceId: String?, model: String)
    case engineProfiles(profiles: [EngineProfile])
    /// State event: the engine session has entered or exited plan mode.
    /// `planModeEnabled: true` is authoritative (model called EnterPlanMode
    /// and the session confirmed). iOS uses this to insert a "Plan created"
    /// lifecycle divider into the engine conversation. `planModeEnabled: false`
    /// is a proposal — the actual exit is gated by the user-approval
    /// chokepoint on the desktop (the "Implement" button).
    case enginePlanModeChanged(tabId: String, instanceId: String?, planModeEnabled: Bool, planFilePath: String?, planSlug: String?)
    /// Workflow event from the engine: the model has proposed a plan-mode
    /// transition (currently only kind="exit"). iOS uses this to render
    /// plan-proposal cards — the desktop is the authoritative consumer
    /// that gates approval. See
    /// docs/architecture/adr/003-state-events-vs-workflow-events.md.
    case enginePlanProposal(tabId: String, instanceId: String?, kind: String, planFilePath: String?, planSlug: String?)
    /// engine_plan_mode_auto_exit fires when the engine deterministically
    /// synthesizes an ExitPlanMode call at end-of-turn because the model
    /// ended a plan-mode run without invoking ExitPlanMode or
    /// AskUserQuestion (issue #187). Sibling to enginePlanProposal —
    /// both surface the plan-approval card, but this event additionally
    /// tells consumers the exit was engine-driven rather than
    /// model-driven, enabling telemetry on prompt quality and optional
    /// subtle UI hints. iOS does not act on this event today; the
    /// desktop is the authoritative consumer that gates approval. Wire
    /// protocol stays uniform by decoding cleanly here.
    case enginePlanModeAutoExit(tabId: String, instanceId: String?, stopReason: String, planFilePath: String?, planSlug: String?, reason: String?, sessionId: String?, runId: String?)
    /// Engine ↔ harness wire-protocol request emitted when the engine wants
    /// an external opinion on whether to nudge a model that has stopped
    /// below the configured output-token budget. The desktop is the
    /// authoritative responder (see desktop/src/main/early-stop-policy.ts)
    /// and replies via the `early_stop_decision_response` client command
    /// within a 100ms window. iOS decodes the event cleanly so the wire
    /// protocol stays uniform but does NOT respond — observing the event
    /// is purely diagnostic.
    ///
    /// Field semantics mirror `extension.EarlyStopDecisionInfo` verbatim;
    /// see engine/internal/types/types.go for the canonical comments.
    /// All numeric fields are kept as `Int` (no Double widening) because
    /// the engine emits whole-number counters; tab/instance/request IDs
    /// are stable correlators useful for log-line pairing.
    case engineEarlyStopDecisionRequest(
        tabId: String,
        instanceId: String?,
        requestId: String,
        runId: String,
        model: String,
        turnNumber: Int,
        stopReason: String,
        cumulativeOutput: Int,
        budget: Int,
        thresholdPct: Int,
        continuationCount: Int,
        maxContinuations: Int,
        lastContinuationDelta: Int,
        wouldContinue: Bool,
        isSubagent: Bool
    )
    /// Complete snapshot of extension-registered slash commands for a
    /// session. Emitted at session start and on every subsequent mutation
    /// (RegisterCommand inside a hook, extension hot reload, etc.).
    ///
    /// Snapshot semantics: REPLACE the cached set with the payload; never
    /// merge. Empty `commands: []` is the authoritative "no extension
    /// commands live" signal. See docs/architecture/agent-state.md for
    /// the canonical snapshot-replace pattern; the field comment on
    /// types.EngineEvent.Commands and the file-level comment on
    /// engine/internal/session/command_registry.go are the source of
    /// truth on the engine side.
    ///
    /// The desktop's prompt pipeline consumes this for routing-hint
    /// caching (engine-command names take precedence over local .md
    /// template lookups). iOS does not yet act on the snapshot — the
    /// unified slash-pipeline plan intentionally left the iOS UI out
    /// of scope — but iOS decodes the variant cleanly so the wire stays
    /// uniform across consumers.
    case engineCommandRegistry(
        tabId: String,
        instanceId: String?,
        commands: [EngineCommandListing]
    )
    /// Result of an engine SendCommand dispatch — success, extension
    /// command failure, or unknown command. `message` carries any
    /// human-readable note the engine emits; `command` is the bare
    /// command name the engine resolved (e.g. "clear",
    /// "ion--review-changes") so consumers can switch on it without
    /// reparsing message prose; `commandError` is set when the dispatch
    /// failed (extension threw, or "unknown_command" when the engine
    /// disclaims the name).
    ///
    /// The desktop's prompt pipeline awaits this event to decide between
    /// "dispatch landed, draw the divider" and "engine disclaims, fall
    /// through to .md expansion". The desktop also uses the specific
    /// success case (command == "clear" && commandError == nil) to relay
    /// an iOS-renderable divider via engine_harness_message /
    /// message_added — iOS receives the divider via those existing
    /// event types and does not need to interpret engine_command_result
    /// directly. Decoding the event here keeps the wire uniform; future
    /// iOS features that want to react to command results have a clean
    /// place to do so.
    case engineCommandResult(
        tabId: String,
        instanceId: String?,
        message: String?,
        command: String?,
        commandError: String?
    )
    /// Engine has finished rendering a /export command's output. The
    /// payload string carries the entire rendered export. `exportFormat`
    /// is the engine-resolved format ("markdown" | "json" | "html" |
    /// "jsonl"; "markdown" by default), so the share sheet can attach a
    /// correctly-typed file rather than an untyped string. Nil when the
    /// engine predates the exportFormat field. Emitted BEFORE the
    /// matching engineCommandResult; iOS opens a share sheet so the
    /// user can save, AirDrop, or copy. See engine/internal/session/
    /// command_dispatch.go's EngineEventExport constant for the wire
    /// type string declaration.
    case engineExport(
        tabId: String,
        instanceId: String?,
        message: String,
        exportFormat: String?
    )
    /// Resource snapshot: emitted when a client subscribes to a resource kind.
    /// Consumers replace their local collection with the items payload.
    /// iOS observes this event but does not act on it in Phase 1 — decoding
    /// keeps the wire uniform across consumers.
    case engineResourceSnapshot(
        tabId: String,
        instanceId: String?,
        resourceKind: String,
        resourceSubId: String,
        resourceItems: [[String: AnyCodable]]
    )
    /// Resource delta: emitted when a producer publishes a change.
    /// iOS observes this event but does not act on it in Phase 1.
    case engineResourceDelta(
        tabId: String,
        instanceId: String?,
        resourceKind: String,
        resourceSubId: String,
        resourceDelta: [String: AnyCodable]
    )
    /// Notification from extension ctx.notify(). The relay handles APNs
    /// push delivery; iOS observes for diagnostic visibility.
    case engineNotification(
        tabId: String,
        instanceId: String?,
        notifyKind: String,
        notifyTitle: String,
        notifyBody: String,
        notifySound: String?,
        notifyScope: String?
    )
    /// Intercept event from an extension via ctx.intercept(). Emitted by the
    /// engine and routed to the target session's stream by the desktop.
    /// The desktop forwards this as a `RemoteEvent` of type `engine_intercept`
    /// after performing its own routing/redirect logic.
    ///
    /// Level hint semantics (same as desktop):
    ///   "banner"   — informational, non-disruptive inline display.
    ///   "redirect" — urgent; the desktop has already aborted + re-prompted;
    ///                iOS renders a visual "Conversation redirected" marker.
    ///
    /// iOS does not perform the abort or re-prompt — the desktop owns that
    /// orchestration. iOS renders the inline banner and (for redirect) relies
    /// on the natural abort + new user message arriving on the engine stream.
    case engineIntercept(
        tabId: String,
        instanceId: String?,
        level: String,
        title: String,
        message: String,
        source: String?,
        metadata: [String: AnyCodable]?
    )
    /// Desktop user-preferences projection. Emitted on initial pairing
    /// and on every subsequent change to a projectable setting (either
    /// from iOS via `setDesktopSetting` or from the desktop UI). Snapshot
    /// semantics — consumers REPLACE their cached view with the payload;
    /// never merge.
    ///
    /// The payload carries three things: the current values map (key →
    /// AnyCodable), the schema (per-key metadata for UI rendering), and
    /// the ordered group descriptors. The schema-on-the-wire design
    /// means iOS auto-renders any new desktop setting without a Swift
    /// code change — the allowlist on the desktop is the single source
    /// of truth. See `DesktopSettingsModel.swift` for the higher-level
    /// model the SettingsView consumes.
    case desktopSettingsSnapshot(
        settings: [String: AnyCodable],
        schema: [DesktopSettingSchemaEntry],
        groups: [DesktopSettingGroupDescriptor]
    )
    // Git events
    case gitChangesResponse(directory: String, response: GitChangesResponse)
    case gitGraphResponse(directory: String, response: GitGraphResponse)
    case gitDiffResponse(response: GitDiffResponse)
    case gitCommitResult(GitMutationResult)
    case gitStageResult(GitMutationResult)
    case gitUnstageResult(GitMutationResult)
    case gitCommitFilesResponse(GitCommitFilesResponse)
    case gitCommitFileDiffResponse(GitCommitFileDiffResponse)
    // File explorer events
    case fsDirListing(directory: String, response: FsDirListingResponse)
    case fsFileContent(filePath: String, response: FsFileContentResponse)
    case fsImageContent(filePath: String, dataUrl: String?, error: String?)
    case fsWriteResult(filePath: String, response: FsWriteResultResponse)
    /// Result of an `fsRename` command. iOS handles this by refreshing
    /// the parent directory listing on success (so the new name appears
    /// and the old entry disappears) and surfacing the error via
    /// `fileRenameResult` on failure.
    case fsRenameResult(oldPath: String, newPath: String, response: FsRenameResultResponse)
    // Command discovery events
    case discoverCommandsResponse(directory: String, commands: [DiscoveredSlashCommand])
    // Upload attachment result
    case uploadAttachmentResult(id: String, name: String, path: String, correlationId: String?, error: String?)
    // Tab attachments response
    case tabAttachments(tabId: String, attachments: [TabAttachmentEntry])
    // Diagnostic log request from desktop
    case requestDiagnosticLogs

    /// Full content for a single resource item, fetched on demand.
    /// Sent by the desktop in response to a `request_resource_content`
    /// command when the user taps a briefing card to expand it. iOS
    /// calls `ResourceStore.updateContent` to populate the item's body.
    case resourceContent(resourceId: String, kind: String, content: String)

    // MARK: - Codable keys

    enum TypeKey: String, Codable {
        case snapshot
        case tabCreated = "tab_created"
        case tabClosed = "tab_closed"
        case tabStatus = "tab_status"
        case textChunk = "text_chunk"
        case toolCall = "tool_call"
        case toolResult = "tool_result"
        case taskComplete = "task_complete"
        case permissionRequest = "permission_request"
        case permissionResolved = "permission_resolved"
        case conversationHistory = "conversation_history"
        case messageAdded = "message_added"
        case messageUpdated = "message_updated"
        case queueUpdate = "queue_update"
        case unpair
        case relayConfig = "relay_config"
        case remoteDisplay = "remote_display"
        case peerDisconnected = "peer_disconnected"
        case transportReconnecting = "transport_reconnecting"
        case heartbeat
        case error
        case inputPrefill = "input_prefill"
        case terminalOutput = "terminal_output"
        case terminalExit = "terminal_exit"
        case terminalInstanceAdded = "terminal_instance_added"
        case terminalInstanceRemoved = "terminal_instance_removed"
        case terminalSnapshot = "terminal_snapshot"
        case engineAgentState = "engine_agent_state"
        case engineStatus = "engine_status"
        case engineSessionStatus = "engine_session_status"
        case engineWorkingMessage = "engine_working_message"
        case engineToolStart = "engine_tool_start"
        case engineToolEnd = "engine_tool_end"
        case engineToolUpdate = "engine_tool_update"
        case engineToolComplete = "engine_tool_complete"
        case engineToolStalled = "engine_tool_stalled"
        case engineRunStalled = "engine_run_stalled"
        case engineSteerInjected = "engine_steer_injected"
        case engineScheduleFired = "engine_schedule_fired"
        case engineLlmCall = "engine_llm_call"
        case engineDispatchStart = "engine_dispatch_start"
        case engineError = "engine_error"
        case engineNotify = "engine_notify"
        case engineDialog = "engine_dialog"
        case engineDialogResolved = "engine_dialog_resolved"
        case engineTextDelta = "engine_text_delta"
        case engineMessageEnd = "engine_message_end"
        case engineDead = "engine_dead"
        case engineInstanceAdded = "engine_instance_added"
        case engineInstanceRemoved = "engine_instance_removed"
        case engineInstanceMoved = "engine_instance_moved"
        case engineHarnessMessage = "engine_harness_message"
        case engineConversationHistory = "engine_conversation_history"
        case agentConversationHistory = "agent_conversation_history"
        case engineModelOverride = "engine_model_override"
        case engineProfiles = "engine_profiles"
        case enginePlanModeChanged = "engine_plan_mode_changed"
        case enginePlanProposal = "engine_plan_proposal"
        case enginePlanModeAutoExit = "engine_plan_mode_auto_exit"
        case engineEarlyStopDecisionRequest = "engine_early_stop_decision_request"
        case engineCommandRegistry = "engine_command_registry"
        case engineCommandResult = "engine_command_result"
        case engineExport = "engine_export"
        case engineResourceSnapshot = "engine_resource_snapshot"
        case engineResourceDelta = "engine_resource_delta"
        case engineNotification = "engine_notification"
        case engineIntercept = "engine_intercept"
        case desktopSettingsSnapshot = "desktop_settings_snapshot"
        case gitChangesResponse = "git_changes_response"
        case gitGraphResponse = "git_graph_response"
        case gitDiffResponse = "git_diff_response"
        case gitCommitResult = "git_commit_result"
        case gitStageResult = "git_stage_result"
        case gitUnstageResult = "git_unstage_result"
        case gitCommitFilesResponse = "git_commit_files_response"
        case gitCommitFileDiffResponse = "git_commit_file_diff_response"
        case fsDirListing = "fs_dir_listing"
        case fsFileContent = "fs_file_content"
        case fsImageContent = "fs_image_content"
        case fsWriteResult = "fs_write_result"
        case fsRenameResult = "fs_rename_result"
        case discoverCommandsResponse = "discover_commands_response"
        case uploadAttachmentResult = "upload_attachment_result"
        case tabAttachments = "tab_attachments"
        case requestDiagnosticLogs = "request_diagnostic_logs"
        case resourceContent = "resource_content"
    }

    // CodingKeys and the init(from:)/encode(to:) requirements must live in
    // this file with the `: Codable` conformance on the primary declaration:
    // both are referenced by bare name from the per-family extension helpers
    // (NormalizedEvent+<Family>.swift), and Swift only resolves the nested
    // CodingKeys / TypeKey types when they are members of the primary type's
    // own file. (RemoteTabGroup was extracted to its own file for headroom;
    // see RemoteTabGroup.swift.)
    enum CodingKeys: String, CodingKey {
        case type
        case tabs, tab, tabId, status, text, toolName, toolId
        case content, isError, result, costUsd
        case questionId, toolInput, options, message
        case messages, hasMore, cursor, messageId, prompts, relayUrl, relayApiKey
        case toolStatus, source, recentDirectories
        case switchTo
        case instanceId, data, exitCode, instance, instances, activeInstanceId, buffers
        case level, dialogId, method, title, defaultValue
        case agents, fields, inputTokens, outputTokens, contextPercent
        // Phase 3 of the state-management overhaul: engine_session_status
        // carries a typed SessionStatus payload under the `sessionStatus`
        // wire key (mirrors EngineEvent.SessionStatus in Go).
        case sessionStatus
        case signal, stderrTail, label, profiles, elapsed, usage, model
        case tabGroupMode, tabGroups, preferredModel, engineDefaultModel, availableModels
        case directory, files, branch, isGitRepo, ahead, behind, stagedCount, unstagedCount
        case commits, totalCount, diff, fileName, graphLayout, hash, stats
        case entries, filePath, ok, error
        // fs_rename_result payload — the command carries `oldPath`/`newPath`
        // and the result echoes them so the iOS handler can refresh the
        // parent directory listing without re-correlating with the
        // outbound command.
        case oldPath, newPath
        case commands
        case ts, buffered
        case id, name, path
        case correlationId
        case dataUrl
        case attachments
        case sourceTabId, targetTabId
        case customName, customIcon, updatedAt, remoteDisplayUpdatedAt
        // engine_plan_mode_changed — state event for plan-mode entry/exit.
        case planModeEnabled
        // engine_steer_injected — mid-turn steer drain confirmation.
        // Mirrors EngineEvent.SteerMessageLength's JSON tag.
        case steerMessageLength
        // engine_run_stalled — engine progress watchdog tripped. Mirrors
        // EngineEvent.RunStalledDuration / RunStalledLastActivity JSON tags.
        // See the Go-side RunStalledEvent doc for the watchdog contract;
        // iOS observes only and may render the advisory event as a
        // diagnostic indicator separate from a generic engine_error.
        case runStalledDuration, runStalledLastActivity
        // engine_plan_proposal — workflow event for plan-mode proposals.
        // The engine emits these field names (no instanceId; the proposal
        // is always at the tab level, not per-instance).
        // planFilePath and planSlug are shared with engine_plan_mode_changed.
        case planProposalKind, planFilePath, planSlug
        // engine_plan_mode_auto_exit — sibling to engine_plan_proposal,
        // fires when the engine deterministically synthesizes an
        // ExitPlanMode call at end-of-turn (issue #187). Field names
        // mirror the Go-side EngineEvent json tags verbatim
        // (planModeAutoExit* prefix to avoid colliding with other
        // event variants that share field name primitives — StopReason
        // in particular collides with early-stop, which already uses
        // earlyStopStopReason). planFilePath and planSlug are reused
        // from above since the shape is identical.
        case planModeAutoExitStopReason, planModeAutoExitReason
        case planModeAutoExitSessionId, planModeAutoExitRunId
        // engine_early_stop_decision_request — wire-protocol request the
        // engine emits when it wants an external opinion on continuation.
        // The desktop responds; iOS only decodes for diagnostic visibility.
        // Field names mirror the Go-side json tags on EngineEvent verbatim
        // so the JSONDecoder picks them up without any custom mapping.
        case earlyStopRequestId, earlyStopRunId, earlyStopModel
        case earlyStopTurnNumber, earlyStopStopReason
        case earlyStopCumulativeOutput, earlyStopBudget, earlyStopThresholdPct
        case earlyStopContinuationCount, earlyStopMaxContinuations
        case earlyStopLastContinuationDelta
        case earlyStopWouldContinue, earlyStopIsSubagent
        // engine_command_registry / engine_command_result — slash-pipeline
        // wire events. `commands` already declared above (used by the
        // RegistryView and other generic listings); `message` already
        // declared above (shared with engine_working_message,
        // engine_notify, engine_error, engine_harness_message). `command`
        // is the bare resolved name (e.g. "clear"), and `commandError`
        // is the failure reason or "unknown_command" when the engine
        // disclaims the name.
        case command, commandError
        // engine_export — `exportFormat` is the engine-resolved format
        // ("markdown" | "json" | "html" | "jsonl") that drives the share
        // sheet's file extension. Mirrors EngineEvent.ExportFormat's JSON
        // tag. The rendered payload rides on the shared `message` key.
        case exportFormat
        // engine_resource_snapshot / engine_resource_delta — resource
        // subsystem events (D-007). iOS observes but does not act on
        // these in Phase 1. Field names mirror the Go-side json tags.
        case resourceKind, resourceSubId, resourceItems, resourceDelta
        // engine_notification — notification pipeline event (D-009).
        // The relay handles APNs push; iOS decodes for diagnostic visibility.
        case notifyKind, notifyTitle, notifyBody, notifySound, notifyScope
        // desktop_settings_snapshot — Part 7 wire event.
        // `settings` is the value map; `schema` carries per-key
        // metadata (type, group, label, description, defaultValue);
        // `groups` is the ordered list of section descriptors.
        case settings, schema, groups
        // Pass-through harness-defined hint map carried on the four
        // user-visible engine events (status, working_message, notify,
        // harness_message). iOS does not act on the field yet but
        // decodes it cleanly so future handlers can adopt conventions
        // like `metadata.dedupKey` without a wire change. See
        // docs/protocol/server-events.md for well-known keys.
        case metadata
        case agentName
        case conversationId
        // resource_content — lazy-loaded full body for a single resource item.
        // Sent by desktop in response to request_resource_content.
        // `resourceId` and `kind` are the desktop wire keys; `resourceKind` is
        // the engine-side key used by engine_resource_snapshot / engine_resource_delta.
        // Do NOT conflate them — resource_content uses "kind", not "resourceKind".
        case resourceId
        case kind
        // resources — workspace-scoped resource manifest in snapshot.
        // Carries metadata-only items (id, kind, title, createdAt, read).
        // Full content is fetched on demand via request_resource_content.
        case resources
    }
}


