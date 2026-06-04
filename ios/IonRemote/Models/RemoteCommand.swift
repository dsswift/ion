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
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(TypeKey.self, forKey: .type)

        switch type {
        case .sync:
            self = .sync

        case .createTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            // Decode the optional `pinToGroupId` extension. Older desktops
            // do not emit this field on iOS-bound replays, but the decoder
            // path is reused for round-trip tests where iOS encodes a
            // createTab and decodes it back — having the field flow through
            // both directions keeps the wire model symmetrical.
            let pinToGroupId = try container.decodeIfPresent(String.self, forKey: .pinToGroupId)
            self = .createTab(workingDirectory: workingDirectory, pinToGroupId: pinToGroupId)

        case .closeTab:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .closeTab(tabId: tabId)

        case .resetTabSession:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .resetTabSession(tabId: tabId)

        case .resetEngineSession:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .resetEngineSession(tabId: tabId, instanceId: instanceId)

        case .prompt:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let origin = try container.decodeIfPresent(String.self, forKey: .origin)
            let clientMsgId = try container.decodeIfPresent(String.self, forKey: .clientMsgId)
            let attachments = try container.decodeIfPresent([CommandAttachment].self, forKey: .attachments)
            self = .prompt(tabId: tabId, text: text, origin: origin, clientMsgId: clientMsgId, attachments: attachments)

        case .cancel:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .cancel(tabId: tabId)

        case .respondPermission:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            let optionId = try container.decode(String.self, forKey: .optionId)
            self = .respondPermission(tabId: tabId, questionId: questionId, optionId: optionId)

        case .setPermissionMode:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let mode = try container.decode(PermissionMode.self, forKey: .mode)
            self = .setPermissionMode(tabId: tabId, mode: mode)

        case .loadConversation:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let before = try container.decodeIfPresent(String.self, forKey: .before)
            self = .loadConversation(tabId: tabId, before: before)

        case .createTerminalTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            self = .createTerminalTab(workingDirectory: workingDirectory)

        case .terminalInput:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let data = try container.decode(String.self, forKey: .data)
            self = .terminalInput(tabId: tabId, instanceId: instanceId, data: data)

        case .terminalResize:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let cols = try container.decode(Int.self, forKey: .cols)
            let rows = try container.decode(Int.self, forKey: .rows)
            self = .terminalResize(tabId: tabId, instanceId: instanceId, cols: cols, rows: rows)

        case .terminalAddInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .terminalAddInstance(tabId: tabId)

        case .terminalRemoveInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .terminalRemoveInstance(tabId: tabId, instanceId: instanceId)

        case .terminalSelectInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .terminalSelectInstance(tabId: tabId, instanceId: instanceId)

        case .requestTerminalSnapshot:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .requestTerminalSnapshot(tabId: tabId)

        case .renameTab:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let customTitle = try container.decodeIfPresent(String.self, forKey: .customTitle)
            self = .renameTab(tabId: tabId, customTitle: customTitle)

        case .renameTerminalInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let label = try container.decode(String.self, forKey: .label)
            self = .renameTerminalInstance(tabId: tabId, instanceId: instanceId, label: label)

        case .rewind:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            self = .rewind(tabId: tabId, messageId: messageId)

        case .forkFromMessage:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            self = .forkFromMessage(tabId: tabId, messageId: messageId)

        case .unpair:
            self = .unpair

        case .createEngineTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            let profileId = try container.decodeIfPresent(String.self, forKey: .profileId)
            self = .createEngineTab(workingDirectory: workingDirectory, profileId: profileId)

        case .enginePrompt:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let attachments = try container.decodeIfPresent([CommandAttachment].self, forKey: .attachments)
            self = .enginePrompt(tabId: tabId, text: text, instanceId: instanceId, attachments: attachments)

        case .engineAbort:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .engineAbort(tabId: tabId, instanceId: instanceId)

        case .engineDialogResponse:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            let value = try container.decode(String.self, forKey: .value)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .engineDialogResponse(tabId: tabId, dialogId: dialogId, value: value, instanceId: instanceId)

        case .engineAddInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .engineAddInstance(tabId: tabId)

        case .engineRemoveInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .engineRemoveInstance(tabId: tabId, instanceId: instanceId)

        case .engineRenameInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let label = try container.decode(String.self, forKey: .label)
            self = .engineRenameInstance(tabId: tabId, instanceId: instanceId, label: label)

        case .engineSelectInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .engineSelectInstance(tabId: tabId, instanceId: instanceId)

        case .engineMoveInstance:
            let sourceTabId = try container.decode(String.self, forKey: .sourceTabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let targetTabId = try container.decode(String.self, forKey: .targetTabId)
            self = .engineMoveInstance(sourceTabId: sourceTabId, instanceId: instanceId, targetTabId: targetTabId)

        case .loadEngineConversation:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .loadEngineConversation(tabId: tabId, instanceId: instanceId)

        case .loadAgentConversation:
            let conversationIds = try container.decode([String].self, forKey: .conversationIds)
            self = .loadAgentConversation(conversationIds: conversationIds)

        case .setTabGroupMode:
            let mode = try container.decode(String.self, forKey: .mode)
            self = .setTabGroupMode(mode: mode)

        case .moveTabToGroup:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let groupId = try container.decode(String.self, forKey: .groupId)
            self = .moveTabToGroup(tabId: tabId, groupId: groupId)

        case .toggleTabGroupPin:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .toggleTabGroupPin(tabId: tabId)

        case .reorderTabGroups:
            let orderedIds = try container.decode([String].self, forKey: .orderedIds)
            self = .reorderTabGroups(orderedIds: orderedIds)

        case .engineSetModel:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let model = try container.decode(String.self, forKey: .model)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .engineSetModel(tabId: tabId, model: model, instanceId: instanceId)

        case .setTabModel:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let model = try container.decode(String.self, forKey: .model)
            self = .setTabModel(tabId: tabId, model: model)

        case .setPreferredModel:
            let model = try container.decode(String.self, forKey: .model)
            self = .setPreferredModel(model: model)

        case .setEngineDefaultModel:
            let model = try container.decode(String.self, forKey: .model)
            self = .setEngineDefaultModel(model: model)

        case .gitChanges:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitChanges(directory: directory)

        case .gitGraph:
            let directory = try container.decode(String.self, forKey: .directory)
            let skip = try container.decodeIfPresent(Int.self, forKey: .skip)
            let limit = try container.decodeIfPresent(Int.self, forKey: .limit)
            self = .gitGraph(directory: directory, skip: skip, limit: limit)

        case .gitDiff:
            let directory = try container.decode(String.self, forKey: .directory)
            let path = try container.decode(String.self, forKey: .path)
            let staged = try container.decode(Bool.self, forKey: .staged)
            self = .gitDiff(directory: directory, path: path, staged: staged)

        case .gitStage:
            let directory = try container.decode(String.self, forKey: .directory)
            let paths = try container.decode([String].self, forKey: .paths)
            self = .gitStage(directory: directory, paths: paths)

        case .gitUnstage:
            let directory = try container.decode(String.self, forKey: .directory)
            let paths = try container.decode([String].self, forKey: .paths)
            self = .gitUnstage(directory: directory, paths: paths)

        case .gitCommit:
            let directory = try container.decode(String.self, forKey: .directory)
            let message = try container.decode(String.self, forKey: .message)
            self = .gitCommit(directory: directory, message: message)

        case .gitDiscard:
            let directory = try container.decode(String.self, forKey: .directory)
            let paths = try container.decode([String].self, forKey: .paths)
            self = .gitDiscard(directory: directory, paths: paths)

        case .gitFetch:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitFetch(directory: directory)

        case .gitPull:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitPull(directory: directory)

        case .gitPush:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitPush(directory: directory)

        case .gitCommitFiles:
            let directory = try container.decode(String.self, forKey: .directory)
            let hash = try container.decode(String.self, forKey: .hash)
            self = .gitCommitFiles(directory: directory, hash: hash)

        case .gitCommitFileDiff:
            let directory = try container.decode(String.self, forKey: .directory)
            let hash = try container.decode(String.self, forKey: .hash)
            let path = try container.decode(String.self, forKey: .path)
            self = .gitCommitFileDiff(directory: directory, hash: hash, path: path)

        case .fsListDir:
            let directory = try container.decode(String.self, forKey: .directory)
            let includeHidden = try container.decodeIfPresent(Bool.self, forKey: .includeHidden) ?? false
            self = .fsListDir(directory: directory, includeHidden: includeHidden)

        case .fsReadFile:
            let filePath = try container.decode(String.self, forKey: .filePath)
            self = .fsReadFile(filePath: filePath)

        case .fsReadImage:
            let filePath = try container.decode(String.self, forKey: .filePath)
            self = .fsReadImage(filePath: filePath)

        case .fsWriteFile:
            let filePath = try container.decode(String.self, forKey: .filePath)
            let content = try container.decode(String.self, forKey: .content)
            self = .fsWriteFile(filePath: filePath, content: content)

        case .fsRename:
            let oldPath = try container.decode(String.self, forKey: .oldPath)
            let newPath = try container.decode(String.self, forKey: .newPath)
            self = .fsRename(oldPath: oldPath, newPath: newPath)

        case .discoverCommands:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .discoverCommands(directory: directory)

        case .uploadAttachment:
            let dataUrl = try container.decode(String.self, forKey: .dataUrl)
            let name = try container.decode(String.self, forKey: .name)
            let correlationId = try container.decode(String.self, forKey: .correlationId)
            self = .uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)

        case .loadAttachments:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .loadAttachments(tabId: tabId)

        case .voiceConfig:
            let enabled = try container.decode(Bool.self, forKey: .enabled)
            let mode = try container.decode(String.self, forKey: .mode)
            let systemPrompt = try container.decodeIfPresent(String.self, forKey: .systemPrompt)
            self = .voiceConfig(enabled: enabled, mode: mode, systemPrompt: systemPrompt)

        case .diagnosticLogsResponse:
            let logs = try container.decode(String.self, forKey: .logs)
            let deviceId = try container.decode(String.self, forKey: .deviceId)
            let deviceName = try container.decode(String.self, forKey: .deviceName)
            self = .diagnosticLogsResponse(logs: logs, deviceId: deviceId, deviceName: deviceName)

        case .setRemoteDisplay:
            // Both fields are nullable on the wire; treat absent OR explicit
            // null identically so old desktops can omit them.
            let customName = try container.decodeIfPresent(String.self, forKey: .customName)
            let customIcon = try container.decodeIfPresent(String.self, forKey: .customIcon)
            let updatedAtMs = try container.decode(Double.self, forKey: .updatedAt)
            self = .setRemoteDisplay(
                customName: customName,
                customIcon: customIcon,
                updatedAt: Date(timeIntervalSince1970: updatedAtMs / 1000.0),
            )

        case .setDesktopSetting:
            // Round-trip decode for tests + diagnostic dumps. iOS
            // typically only encodes this command (never decodes it
            // from the wire), but the Codable conformance requires
            // the path to exist.
            let key = try container.decode(String.self, forKey: .key)
            let value = try container.decode(AnyCodable.self, forKey: .value)
            self = .setDesktopSetting(key: key, value: value)

        case .setPillColor:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let pillColor = try container.decodeIfPresent(String.self, forKey: .pillColor)
            self = .setPillColor(tabId: tabId, pillColor: pillColor)

        case .setPillIcon:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let pillIcon = try container.decodeIfPresent(String.self, forKey: .pillIcon)
            self = .setPillIcon(tabId: tabId, pillIcon: pillIcon)
        }
    }

}

/// Attachment metadata sent with prompt and engine_prompt commands.
struct CommandAttachment: Codable, Sendable {
    let type: String   // "image" or "file"
    let name: String
    let path: String
}
