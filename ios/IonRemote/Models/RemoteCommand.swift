import Foundation

/// Commands sent from iOS to Ion. Mirrors `RemoteCommand` in `src/main/remote/protocol.ts`.
enum RemoteCommand: Codable, Sendable {
    case sync
    /// Additive optional `pinToGroupId` extension. When non-nil and the
    /// desktop is in manual tab-group mode, the new tab lands inside that
    /// group with `groupPinned=true` so the very first prompt's auto-group
    /// movement skips it. Older Ion desktops that don't know the field
    /// simply ignore it; behavior degrades to the legacy default-group
    /// placement.
    case createTab(workingDirectory: String?, pinToGroupId: String? = nil)
    case createTerminalTab(workingDirectory: String?)
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
    case prompt(tabId: String, text: String, origin: String? = "remote", clientMsgId: String? = nil, attachments: [CommandAttachment]? = nil, implementationPhase: Bool? = nil)
    case cancel(tabId: String)
    case respondPermission(tabId: String, questionId: String, optionId: String)
    case setPermissionMode(tabId: String, mode: PermissionMode)
    case loadConversation(tabId: String, before: String?)
    case terminalInput(tabId: String, instanceId: String, data: String)
    case terminalResize(tabId: String, instanceId: String, cols: Int, rows: Int)
    case terminalAddInstance(tabId: String)
    case terminalRemoveInstance(tabId: String, instanceId: String)
    case terminalSelectInstance(tabId: String, instanceId: String)
    case requestTerminalSnapshot(tabId: String)
    case renameTab(tabId: String, customTitle: String?)
    case renameTerminalInstance(tabId: String, instanceId: String, label: String)
    case rewind(tabId: String, messageId: String)
    case forkFromMessage(tabId: String, messageId: String)
    /// Rewind an engine-tab instance's conversation to a chosen message.
    /// Mirrors the desktop `engine_rewind` remote command: the desktop
    /// stops the engine session, starts a fresh one, truncates the
    /// instance's messages, and replies with an `input_prefill` carrying
    /// the rewound user message. Distinct from `rewind` (CLI tabs) because
    /// engine tabs are per-instance — the instanceId selects which engine
    /// instance within the tab to rewind.
    ///
    /// `userTurnIndex` is the 0-based index of the target among role==.user
    /// messages. The desktop uses it to resolve the rewind point when its
    /// id lookup misses — which it always does for iOS, because iOS renders
    /// the just-typed turn from an optimistic UUID the desktop never minted.
    /// Nil only for callers that can guarantee a desktop-minted id.
    case engineRewind(tabId: String, instanceId: String, messageId: String, userTurnIndex: Int?)
    case unpair
    case createEngineTab(workingDirectory: String?, profileId: String?)
    case enginePrompt(tabId: String, text: String, instanceId: String? = nil, attachments: [CommandAttachment]? = nil, implementationPhase: Bool? = nil)
    case engineAbort(tabId: String, instanceId: String? = nil)
    case engineDialogResponse(tabId: String, dialogId: String, value: String, instanceId: String? = nil)
    case engineAddInstance(tabId: String)
    case engineRemoveInstance(tabId: String, instanceId: String)
    case engineRenameInstance(tabId: String, instanceId: String, label: String)
    case engineSelectInstance(tabId: String, instanceId: String)
    case engineMoveInstance(sourceTabId: String, instanceId: String, targetTabId: String)
    case loadEngineConversation(tabId: String, instanceId: String?)
    case loadAgentConversation(conversationIds: [String])
    case setTabGroupMode(mode: String)
    case moveTabToGroup(tabId: String, groupId: String)
    case toggleTabGroupPin(tabId: String)
    case reorderTabGroups(orderedIds: [String])
    case engineSetModel(tabId: String, model: String, instanceId: String? = nil)
    case setTabModel(tabId: String, model: String)
    case setPreferredModel(model: String)
    case setEngineDefaultModel(model: String)
    case gitChanges(directory: String)
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
    case fsListDir(directory: String, includeHidden: Bool = false)
    case fsReadFile(filePath: String)
    case fsReadImage(filePath: String)
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
    case voiceConfig(enabled: Bool, mode: String, systemPrompt: String?)
    case diagnosticLogsResponse(logs: String, deviceId: String, deviceName: String)
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
    /// Set the custom pill icon for a tab.
    /// `pillIcon` is an icon key (e.g. "diamond", "star") or nil to reset to the default dot.
    case setPillIcon(tabId: String, pillIcon: String?)
    /// Report iOS device focus to the desktop for intercept routing.
    /// Sent when the user switches tabs, the app foregrounds, or the
    /// intercept preference changes. `tabId: nil` means the app is
    /// backgrounded (no active tab). `interceptEnabled` carries the
    /// current value of the "Allow conversation intercepts" UserDefaults
    /// preference (default true). The desktop stores this in `deviceFocusMap`
    /// and uses it to decide whether to perform redirect-level intercepts
    /// on behalf of this device.
    case reportFocus(tabId: String?, interceptEnabled: Bool)
    /// Request the full content for a single resource item from the
    /// desktop's renderer store. Sent when the user taps a briefing card
    /// to expand it. The snapshot carries only metadata (id, kind, title,
    /// createdAt, read) to keep the payload small; content arrives via
    /// the `resource_content` event in response to this command.
    case requestResourceContent(kind: String, resourceId: String)

    /// Notify the desktop that the user read a resource on iOS. The desktop
    /// persists the read state and publishes a mark_read delta through the
    /// engine so all subscribers converge.
    case markResourceRead(kind: String, resourceId: String)

    /// Permanently remove a notification from the global resource broker.
    /// The desktop publishes a delete delta through the engine so all
    /// subscribers (desktop + iOS) remove the item from their collections.
    case deleteResource(kind: String, resourceId: String)

    // MARK: - Codable

    enum TypeKey: String, Codable {
        case sync
        case createTab = "create_tab"
        case createTerminalTab = "create_terminal_tab"
        case closeTab = "close_tab"
        case resetTabSession = "reset_tab_session"
        case resetEngineSession = "reset_engine_session"
        case prompt
        case cancel
        case respondPermission = "respond_permission"
        case setPermissionMode = "set_permission_mode"
        case loadConversation = "load_conversation"
        case terminalInput = "terminal_input"
        case terminalResize = "terminal_resize"
        case terminalAddInstance = "terminal_add_instance"
        case terminalRemoveInstance = "terminal_remove_instance"
        case terminalSelectInstance = "terminal_select_instance"
        case requestTerminalSnapshot = "request_terminal_snapshot"
        case renameTab = "rename_tab"
        case renameTerminalInstance = "rename_terminal_instance"
        case rewind
        case forkFromMessage = "fork_from_message"
        case engineRewind = "engine_rewind"
        case unpair
        case createEngineTab = "create_engine_tab"
        case enginePrompt = "engine_prompt"
        case engineAbort = "engine_abort"
        case engineDialogResponse = "engine_dialog_response"
        case engineAddInstance = "engine_add_instance"
        case engineRemoveInstance = "engine_remove_instance"
        case engineRenameInstance = "engine_rename_instance"
        case engineSelectInstance = "engine_select_instance"
        case engineMoveInstance = "engine_move_instance"
        case loadEngineConversation = "load_engine_conversation"
        case loadAgentConversation = "load_agent_conversation"
        case setTabGroupMode = "set_tab_group_mode"
        case moveTabToGroup = "move_tab_to_group"
        case toggleTabGroupPin = "toggle_tab_group_pin"
        case reorderTabGroups = "reorder_tab_groups"
        case engineSetModel = "engine_set_model"
        case setTabModel = "set_tab_model"
        case setPreferredModel = "set_preferred_model"
        case setEngineDefaultModel = "set_engine_default_model"
        case gitChanges = "git_changes"
        case gitGraph = "git_graph"
        case gitDiff = "git_diff"
        case gitStage = "git_stage"
        case gitUnstage = "git_unstage"
        case gitCommit = "git_commit"
        case gitDiscard = "git_discard"
        case gitFetch = "git_fetch"
        case gitPull = "git_pull"
        case gitPush = "git_push"
        case gitCommitFiles = "git_commit_files"
        case gitCommitFileDiff = "git_commit_file_diff"
        case fsListDir = "fs_list_dir"
        case fsReadFile = "fs_read_file"
        case fsReadImage = "fs_read_image"
        case fsWriteFile = "fs_write_file"
        case fsRename = "fs_rename"
        case discoverCommands = "discover_commands"
        case uploadAttachment = "upload_attachment"
        case loadAttachments = "load_attachments"
        case voiceConfig = "voice_config"
        case diagnosticLogsResponse = "diagnostic_logs_response"
        case setRemoteDisplay = "set_remote_display"
        case setDesktopSetting = "set_desktop_setting"
        case setPillColor = "set_pill_color"
        case setPillIcon = "set_pill_icon"
        case reportFocus = "report_focus"
        case requestResourceContent = "request_resource_content"
        case markResourceRead = "mark_resource_read"
        case deleteResource = "delete_resource"
    }

    enum CodingKeys: String, CodingKey {
        case type
        case workingDirectory, tabId, text, questionId, optionId, mode, before, origin
        case instanceId, data, cols, rows, customTitle, label, messageId, clientMsgId
        case dialogId, value, profileId, model, groupId
        // `pinToGroupId` is the distinct wire-level key for the optional
        // create_tab extension. We deliberately do NOT reuse `groupId` here
        // — `groupId` already names the destination on move_tab_to_group,
        // and conflating the two would invite type confusion if a future
        // command needs both (e.g. a hypothetical "create_tab_in_group_and_send"
        // that names a target group AND a separate pin source).
        case pinToGroupId
        case directory, path, staged, paths, skip, limit, message, filePath, content, includeHidden, hash
        // fs_rename payload — both paths are absolute and live under a
        // project root. New CodingKeys (no collision with existing entries);
        // checked against the full enum above before adding.
        case oldPath, newPath
        case attachments, dataUrl, name, correlationId, orderedIds, implementationPhase
        case enabled, systemPrompt
        case logs, deviceId, deviceName
        case sourceTabId, targetTabId
        case customName, customIcon, updatedAt
        // setDesktopSetting payload. `key` is unique to this command;
        // `value` is shared with engineDialogResponse (both carry a
        // type-erased payload, both use the same wire field name) so
        // we declare only `key` here and reuse the existing `value`
        // CodingKey above.
        case key
        case conversationIds
        // setPillColor / setPillIcon payloads.
        case pillColor, pillIcon
        // reportFocus payload. `interceptEnabled` is the iOS-local
        // "Allow conversation intercepts" preference. `tabId` is already
        // declared above (shared with many commands); `interceptEnabled`
        // is new and unique to this command.
        case interceptEnabled
        // requestResourceContent payload. `kind` identifies the resource
        // type (e.g. "briefing"); `resourceId` is the item ID. These
        // share no wire key with any existing command field.
        case resourceId
        case kind
        // engine_rewind payload. `tabId`/`instanceId`/`messageId` are shared
        // with other commands above; `userTurnIndex` is unique to this command
        // — the 0-based ordinal among user messages the desktop uses to resolve
        // the rewind point when its id lookup misses.
        case userTurnIndex
    }

    // `init(from decoder:)` is in RemoteCommand+Decode.swift to keep this
    // file under the 600-line Swift cap. The encode counterpart lives in
    // RemoteCommand+Encode.swift.

}

/// Attachment metadata sent with prompt and engine_prompt commands.
struct CommandAttachment: Codable, Sendable {
    let type: String   // "image" or "file"
    let name: String
    let path: String
}
