import Foundation
import SwiftUI
import CryptoKit
import Observation

enum PairingError: Error, LocalizedError {
    case invalidResponse
    case rejected(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "Invalid pairing response"
        case .rejected(let reason): return "Pairing rejected: \(reason)"
        }
    }
}

// MARK: - ConnectionState

/// UI-level connection state for displaying transport status in views.
enum ConnectionState: String, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    /// Auth handshake was rejected -- the pairing is no longer valid.
    case authFailed

    var label: String {
        switch self {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .reconnecting: "Reconnecting"
        case .authFailed: "Authentication Failed"
        }
    }

    var color: Color {
        switch self {
        case .disconnected: .red
        case .connecting: .yellow
        case .connected: .green
        case .reconnecting: .orange
        case .authFailed: .red
        }
    }
}

// MARK: - PairingState

enum PairingState: Sendable {
    case idle
    case discovering
    case connecting(hostName: String)
    case exchangingKeys
    case configuringRelay
    case paired
    case failed(Error)

    var isIdle: Bool {
        if case .idle = self { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    var isConnecting: Bool {
        switch self {
        case .connecting, .exchangingKeys, .configuringRelay: return true
        default: return false
        }
    }
}

// MARK: - EngineDialogInfo

struct EngineDialogInfo: Identifiable {
    let id: String
    let method: String
    let title: String
    let options: [String]?
    let defaultValue: String?

    init(dialogId: String, method: String, title: String, options: [String]?, defaultValue: String?) {
        self.id = dialogId
        self.method = method
        self.title = title
        self.options = options
        self.defaultValue = defaultValue
    }
}

// MARK: - EventBatcher

/// Collects remote events off the main thread so they can be drained
/// in a single batch and processed in one MainActor block per frame.
actor EventBatcher {
    private var buffer: [RemoteEvent] = []

    func enqueue(_ event: RemoteEvent) {
        buffer.append(event)
    }

    func drain() -> [RemoteEvent] {
        let batch = buffer
        buffer.removeAll(keepingCapacity: true)
        return batch
    }
}

// MARK: - SessionViewModel

@Observable
final class SessionViewModel {

    // MARK: - State

    var tabs: [RemoteTabState] = []
    var tabIds: Set<String> = []
    var liveText: [String: String] = [:]
    var messages: [String: [Message]] = [:]
    var messageCountByTab: [String: Int] = [:]
    var loadingConversation: Set<String> = []
    var conversationLoaded: Set<String> = []
    var conversationHasMore: [String: Bool] = [:]
    var conversationCursor: [String: String] = [:]
    var conversationLoadFailed: Set<String> = []
    var suppressScrollToBottom = false
    var conversationLoadRetryCount: [String: Int] = [:]
    var conversationLoadTimers: [String: Task<Void, Never>] = [:]
    /// Tracks dismissed restored special cards (ExitPlanMode/AskUserQuestion from history)
    var dismissedRestoredCards: Set<String> = []
    /// Tracks tabs where a live special card was dismissed (prevents restoredSpecialCard re-trigger)
    var dismissedLiveSpecialTabs: Set<String> = []
    // Terminal state (per terminal tab)
    var terminalInstances: [String: [TerminalInstanceInfo]] = [:]  // tabId -> instances
    var activeTerminalInstance: [String: String] = [:]              // tabId -> active instanceId
    /// Local display name overrides for terminal instances (keyed by "tabId:instanceId").
    var terminalInstanceLabels: [String: String] = [:]
    // Engine state (per engine tab)
    var engineAgentStates: [String: [AgentStateUpdate]] = [:]  // compoundKey -> agents
    var engineStatusFields: [String: StatusFields] = [:]        // compoundKey -> status fields
    var engineWorkingMessages: [String: String] = [:]           // compoundKey -> working message
    var engineDialogs: [String: EngineDialogInfo?] = [:]
    var enginePinnedPrompt: [String: String] = [:]
    var engineModelOverrides: [String: String] = [:]             // compoundKey -> model override
    // Engine conversation messages (per compound key)
    var engineMessages: [String: [Message]] = [:]         // compoundKey -> messages
    var engineConversationLoaded: Set<String> = []               // compoundKeys that have loaded history
    var engineTurnHasText: Set<String> = []                      // compoundKeys where current LLM sub-turn produced text
    // Agent dispatch conversation history (per conversationId for dispatch pager)
    var agentConversationMessages: [String: [Message]] = [:]     // conversationId -> messages
    var agentConversationLoading: Set<String> = []               // conversationIds currently loading
    // Engine instance state (per engine tab)
    var engineInstances: [String: [EngineInstanceInfo]] = [:]   // tabId -> instances
    var activeEngineInstance: [String: String] = [:]              // tabId -> active instanceId
    /// Engine profiles synced from the desktop settings.
    var engineProfiles: [EngineProfile] = []
    /// Preferred model default for new tabs (synced from desktop settings).
    var preferredModel: String = "claude-sonnet-4-6"
    /// Engine default model (synced from desktop settings).
    var engineDefaultModel: String = ""
    /// Available models from the desktop (dynamic list from engine).
    /// Falls back to default Claude models until the first snapshot with model data arrives.
    var availableModels: [RemoteModelEntry] = SessionViewModel.defaultModels

    /// Currently-connected desktop's projectable user preferences,
    /// surfaced in the Settings UI under "Desktop Settings". Replaced
    /// wholesale on every `desktopSettingsSnapshot` event (snapshot
    /// semantics — never merge). `nil` while no desktop is paired or
    /// during the brief window before the first snapshot arrives on a
    /// new pairing.
    ///
    /// Per-desktop scoping: the field tracks only the currently-active
    /// pairing's settings. Switching to a different paired desktop
    /// clears the field via `switchToDevice`, and the new desktop's
    /// initial snapshot repopulates it.
    var desktopSettings: DesktopSettingsState? = nil

    /// Default model list used before the desktop sends a dynamic list.
    static let defaultModels: [RemoteModelEntry] = [
        RemoteModelEntry(id: "claude-opus-4-7", providerId: "anthropic", label: "Opus 4.7", contextWindow: 1_000_000, hasAuth: true),
        RemoteModelEntry(id: "claude-opus-4-6", providerId: "anthropic", label: "Opus 4.6", contextWindow: 1_000_000, hasAuth: true),
        RemoteModelEntry(id: "claude-sonnet-4-6", providerId: "anthropic", label: "Sonnet 4.6", contextWindow: 200_000, hasAuth: true),
        RemoteModelEntry(id: "claude-haiku-4-5-20251001", providerId: "anthropic", label: "Haiku 4.5", contextWindow: 200_000, hasAuth: true),
    ]
    /// Active tool calls per tab, keyed by toolId.
    var activeTools: [String: [String: ActiveToolInfo]] = [:]
    /// Tab IDs that iOS has requested to close but hasn't received tab_closed confirmation for.
    var pendingCloseTabIds: Set<String> = []
    /// Timestamps when tabs transitioned to an idle/completed/failed/dead state (for "idle since" display).
    var tabIdleSince: [String: Date] = [:]

    // Git state (per working directory)
    var gitChanges: [String: GitChangesResponse] = [:]     // directory -> changes
    var gitGraph: [String: GitGraphResponse] = [:]          // directory -> graph
    var gitDiffResult: GitDiffResponse? = nil
    var gitDiffLoading = false
    var gitCommitFiles: [String: GitCommitFilesResponse] = [:]  // keyed by hash
    var gitCommitFileDiff: [String: GitCommitFileDiffResponse] = [:]  // keyed by "hash:path"
    var gitToast: GitToast? = nil

    // File explorer state (per directory/path)
    var fileListings: [String: FsDirListingResponse] = [:]   // directory -> listing
    var fileContent: [String: FsFileContentResponse] = [:]    // filePath -> content
    var fileWriteResult: FsWriteResultResponse? = nil
    /// Latest result of an `fsRename` command. Observed by
    /// `FileExplorerRowView` to surface error alerts (the success path
    /// is handled by the event handler triggering a fresh
    /// `requestFsListDir` on the parent directory; the view doesn't
    /// need to read this for the happy path).
    var fileRenameResult: FsRenameResultResponse? = nil
    var fileListingLoading: Set<String> = []
    var fileContentLoading: Set<String> = []

    // Tab attachment cache (from load_attachments command)
    var tabAttachmentCache: [String: [TabAttachmentEntry]] = [:]  // tabId -> attachments

    // Discovered slash commands (per working directory)
    var discoveredCommands: [String: [DiscoveredSlashCommand]] = [:]

    /// Extension-registered slash commands from engine_command_registry events.
    /// Keyed by engine session key (tabId or "tabId:instanceId") — mirrors the
    /// desktop's `extensionCommandsByKey` in engine-event-slice.ts.
    /// Snapshot semantics: every event REPLACES the prior entry for that key.
    var extensionCommands: [String: [EngineCommandListing]] = [:]

    // Upload attachment results (consumed by InputBar / EngineView)
    var pendingUploadResults: [UploadAttachmentResult] = []

    // MARK: - Toast Messages
    var toastMessages: [ToastMessage] = []

    /// Tab group mode synced from the desktop: "off", "auto", or "manual".
    var tabGroupMode: String = "auto"
    /// Manual tab group definitions from the desktop (only meaningful when tabGroupMode == "manual").
    var tabGroups: [RemoteTabGroup] = []

    var pairedDevices: [PairedDevice] = []
    var connectionState: ConnectionState = .disconnected
    var pairingState: PairingState = .idle

    /// Which desktop is currently selected (persisted in UserDefaults).
    var activeDeviceId: String? {
        get { UserDefaults.standard.string(forKey: "activeDeviceId") }
        set { UserDefaults.standard.set(newValue, forKey: "activeDeviceId") }
    }

    /// The currently active paired device, falling back to the first device.
    var activeDevice: PairedDevice? {
        if let id = activeDeviceId {
            return pairedDevices.first { $0.id == id } ?? pairedDevices.first
        }
        return pairedDevices.first
    }

    /// True once we've received at least one snapshot (enables cached layout restoration).
    var hasConnectedBefore: Bool = false

    /// Online status of non-active paired devices (from relay polling).
    /// Key: device ID. Value: true=online, false=offline, nil=unknown/error.
    var deviceOnlineStatus: [String: Bool?] = [:]
    /// Background task for periodic device status polling.
    var deviceStatusTask: Task<Void, Never>?

    /// Recent base directories from the desktop, updated via snapshot events.
    var recentDirectories: [String] = []
    /// Tab ID to auto-navigate to after remote creation.
    var pendingNavigationTabId: String? = nil
    /// Tab ID to auto-open the Git pane for (set by tapping the branch badge in tab list).
    /// Observed by ConversationView and EngineView; cleared after the pane is presented.
    var pendingGitPaneTabId: String? = nil
    /// Set `true` before sending a create-tab command so the `tabCreated`
    /// handler knows the creation was locally initiated and should navigate.
    var awaitingLocalTabCreation = false
    /// Text to prefill into the input bar (set by rewind/fork responses).
    var pendingInputByTab: [String: String] = [:]
    /// Per-tab unsent input text. Persisted to UserDefaults across launches.
    /// Keyed by `tabId`. Updated on every keystroke via the InputBar binding.
    var draftInputByTab: [String: String] = [:]
    /// Per-engine-instance unsent input text. Persisted to UserDefaults.
    /// Key format: `"\(tabId):\(instanceId)"` (matches desktop's engineDraftInputs).
    var engineDraftInputByKey: [String: String] = [:]
    /// Default directory for new tabs on iOS (independent of desktop setting).
    var defaultBaseDirectory: String? {
        get { UserDefaults.standard.string(forKey: "defaultBaseDirectory") }
        set { UserDefaults.standard.set(newValue, forKey: "defaultBaseDirectory") }
    }

    /// Whether to show the branch/ahead/behind row in the tab list (off by default).
    var showGitInfoInTabList: Bool {
        get { UserDefaults.standard.bool(forKey: "showGitInfoInTabList") }
        set { UserDefaults.standard.set(newValue, forKey: "showGitInfoInTabList") }
    }

    /// Whether tapping an agent row opens a full-screen popup (on by default).
    var agentPanelFullScreenPopup: Bool {
        get { UserDefaults.standard.object(forKey: "agentPanelFullScreenPopup") == nil
              ? true
              : UserDefaults.standard.bool(forKey: "agentPanelFullScreenPopup") }
        set { UserDefaults.standard.set(newValue, forKey: "agentPanelFullScreenPopup") }
    }

    /// APNs device token (set by AppDelegate on registration success).
    var apnsToken: String?

    // MARK: - Settings (persisted via paired device)

    var relayURL: String = ""
    var relayAPIKey: String = ""

    // MARK: - Connection Quality

    let connectionQuality = ConnectionQuality()

    // MARK: - Transport

    var transportState: TransportState { transport?.state ?? .disconnected }

    var transport: TransportManager?
    var eventTask: Task<Void, Never>?
    var flushTask: Task<Void, Never>?
    /// Safety timer: if `.reconnecting` lingers too long, force a full reconnect.
    var reconnectSafetyTask: Task<Void, Never>?
    let eventBatcher = EventBatcher()
    /// Standalone browser for pairing discovery (before a transport exists).
    private(set) var pairingBrowser = BonjourBrowser()

    // MARK: - Computed

    func tab(for id: String) -> RemoteTabState? {
        tabs.first { $0.id == id }
    }

    /// Navigate to a specific tab (e.g. from a push notification tap).
    func navigateToTab(_ tabId: String) {
        pendingNavigationTabId = tabId
    }

    /// Poll relay channel status for all non-active paired devices.
    func pollDeviceStatus() {
        let activeId = activeDevice?.id
        let devices = pairedDevices.filter { $0.id != activeId }
        guard !devices.isEmpty else { return }
        Task {
            for device in devices {
                let relayUrl = device.relayURL ?? relayURL
                let apiKey = device.relayAPIKey ?? relayAPIKey
                let channelId = E2ECrypto.deriveChannelId(
                    sharedSecret: SymmetricKey(data: device.sharedSecret)
                )
                let online = await PeerStatusPoller.checkDesktopOnline(
                    relayURL: relayUrl, apiKey: apiKey, channelId: channelId
                )
                await MainActor.run {
                    self.deviceOnlineStatus[device.id] = online
                }
            }
        }
    }

    /// Compute the compound key for the active engine instance.
    /// Returns `"tabId:instanceId"` when an instance is active, or just `tabId` as fallback.
    func engineCompoundKey(tabId: String) -> String {
        let instanceId = activeEngineInstance[tabId] ?? engineInstances[tabId]?.first?.id ?? ""
        return instanceId.isEmpty ? tabId : "\(tabId):\(instanceId)"
    }

    /// Tabs grouped by working directory basename, preserving original order within each group.
    /// Duplicate basenames are disambiguated with the parent directory name.
    var tabsByDirectory: [(directory: String, fullPath: String, tabs: [RemoteTabState])] {
        var order: [String] = []
        var groups: [String: [RemoteTabState]] = [:]
        for tab in tabs {
            let key = tab.workingDirectory
            if groups[key] == nil {
                order.append(key)
            }
            groups[key, default: []].append(tab)
        }

        var basenameCounts: [String: Int] = [:]
        for path in order {
            let base = (path as NSString).lastPathComponent
            basenameCounts[base, default: 0] += 1
        }

        return order.map { fullPath in
            let base = (fullPath as NSString).lastPathComponent
            let label: String
            if base.isEmpty || fullPath == "/" || fullPath == "~" {
                label = "Home"
            } else if basenameCounts[base, default: 0] > 1 {
                let parent = ((fullPath as NSString).deletingLastPathComponent as NSString).lastPathComponent
                label = "\(base) (\(parent))"
            } else {
                label = base
            }
            return (directory: label, fullPath: fullPath, tabs: groups[fullPath]!)
        }
    }

    /// Groups for display: manual groups when desktop is in manual mode,
    /// otherwise auto-grouped by working directory.
    /// Each tuple: (label, identifier for ForEach, icon name, directory for new-tab, tabs).
    var displayGroups: [(label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])] {
        if tabGroupMode == "manual", !tabGroups.isEmpty {
            return tabsByManualGroup
        }
        return tabsByDirectory.map { group in
            (label: group.directory, id: group.fullPath, icon: "folder", directory: group.fullPath, tabs: group.tabs)
        }
    }

    /// Tabs grouped by manual group definitions from the desktop.
    private var tabsByManualGroup: [(label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])] {
        let sorted = tabGroups.sorted { $0.order < $1.order }
        let defaultGroup = sorted.first(where: \.isDefault) ?? sorted.first
        var groupMap: [String: [RemoteTabState]] = [:]
        for g in sorted { groupMap[g.id] = [] }
        for tab in tabs {
            if let gid = tab.groupId, groupMap[gid] != nil {
                groupMap[gid]!.append(tab)
            } else if let dg = defaultGroup {
                groupMap[dg.id, default: []].append(tab)
            }
        }
        return sorted.compactMap { g in
            let gTabs = groupMap[g.id] ?? []
            guard !gTabs.isEmpty else { return nil }
            let dir = gTabs.first?.workingDirectory
            return (label: g.label, id: g.id, icon: "tray.2.fill", directory: dir, tabs: gTabs)
        }
    }

    // MARK: - Voice

    let voiceService = VoiceService()
    let speechService = SpeechRecognitionService()

    // MARK: - Toast

    @MainActor
    func showToast(_ message: ToastMessage) {
        toastMessages.append(message)
        // Cap at 2 visible; drop oldest if exceeded.
        if toastMessages.count > 2 {
            toastMessages.removeFirst(toastMessages.count - 2)
        }
        let id = message.id
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(message.duration))
            self?.dismissToast(id: id)
        }
    }

    @MainActor
    func dismissToast(id: UUID) {
        toastMessages.removeAll { $0.id == id }
    }

    // MARK: - Input Drafts

    /// UserDefaults keys for draft persistence.
    private static let draftInputByTabKey = "draftInputByTab"
    private static let engineDraftInputByKeyKey = "engineDraftInputByKey"

    /// Returns the persisted draft for a tab, or "" if none.
    func tabDraft(_ tabId: String) -> String {
        draftInputByTab[tabId] ?? ""
    }

    /// Writes (or clears) a per-tab draft and persists to UserDefaults.
    /// Empty strings remove the key to avoid bloating storage.
    func setTabDraft(_ tabId: String, _ text: String) {
        if text.isEmpty {
            if draftInputByTab.removeValue(forKey: tabId) != nil {
                DiagnosticLog.log("DRAFT: tab \(tabId.prefix(8)) cleared")
                persistDrafts()
            }
        } else {
            let prev = draftInputByTab[tabId]
            draftInputByTab[tabId] = text
            if prev != text {
                DiagnosticLog.log("DRAFT: tab \(tabId.prefix(8)) updated len=\(text.count)")
                persistDrafts()
            }
        }
    }

    /// Removes a per-tab draft (used when tab is closed on the desktop).
    func clearTabDraft(_ tabId: String) {
        if draftInputByTab.removeValue(forKey: tabId) != nil {
            DiagnosticLog.log("DRAFT: tab \(tabId.prefix(8)) removed (tab closed)")
            persistDrafts()
        }
    }

    /// Returns the persisted draft for a tab+instance, or "" if none.
    func engineDraft(tabId: String, instanceId: String) -> String {
        engineDraftInputByKey["\(tabId):\(instanceId)"] ?? ""
    }

    /// Writes (or clears) a per-engine-instance draft and persists.
    func setEngineDraft(tabId: String, instanceId: String, _ text: String) {
        let key = "\(tabId):\(instanceId)"
        if text.isEmpty {
            if engineDraftInputByKey.removeValue(forKey: key) != nil {
                DiagnosticLog.log("DRAFT: engine \(tabId.prefix(8)):\(instanceId.prefix(8)) cleared")
                persistDrafts()
            }
        } else {
            let prev = engineDraftInputByKey[key]
            engineDraftInputByKey[key] = text
            if prev != text {
                DiagnosticLog.log("DRAFT: engine \(tabId.prefix(8)):\(instanceId.prefix(8)) updated len=\(text.count)")
                persistDrafts()
            }
        }
    }

    /// Removes all engine-instance drafts for a tab (used when tab is closed).
    func clearEngineDrafts(forTab tabId: String) {
        let prefix = "\(tabId):"
        let removed = engineDraftInputByKey.keys.filter { $0.hasPrefix(prefix) }
        guard !removed.isEmpty else { return }
        for k in removed { engineDraftInputByKey.removeValue(forKey: k) }
        DiagnosticLog.log("DRAFT: engine drafts removed for tab \(tabId.prefix(8)) count=\(removed.count)")
        persistDrafts()
    }

    /// Writes both draft dictionaries to UserDefaults.
    private func persistDrafts() {
        UserDefaults.standard.set(draftInputByTab, forKey: Self.draftInputByTabKey)
        UserDefaults.standard.set(engineDraftInputByKey, forKey: Self.engineDraftInputByKeyKey)
    }

    /// Hydrates draft dictionaries from UserDefaults. Called once in `init`.
    private func hydrateDrafts() {
        if let tabMap = UserDefaults.standard.dictionary(forKey: Self.draftInputByTabKey) as? [String: String] {
            draftInputByTab = tabMap
        }
        if let engineMap = UserDefaults.standard.dictionary(forKey: Self.engineDraftInputByKeyKey) as? [String: String] {
            engineDraftInputByKey = engineMap
        }
        DiagnosticLog.log("DRAFT: hydrated tabDrafts=\(draftInputByTab.count) engineDrafts=\(engineDraftInputByKey.count)")
    }

    // MARK: - Init

    init() {
        loadPairedDevices()
        // Restore hasConnectedBefore from UserDefaults
        hasConnectedBefore = UserDefaults.standard.bool(forKey: "hasConnectedBefore")
        hydrateDrafts()
    }
}
