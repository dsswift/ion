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

// MARK: - SessionViewModel

@Observable
final class SessionViewModel {

    // MARK: - State

    /// Workspace-level resource accumulator (D-007). Populated by
    /// engineResourceSnapshot and engineResourceDelta events.
    let resourceStore = ResourceStore()

    /// Paged plan content assembler (plan gentle-perching-lemon). Populated
    /// by plan_content events in response to requestPlanContent commands.
    let planContentStore = PlanContentStore()

    var tabs: [RemoteTabState] = []
    var tabIds: Set<String> = []
    /// Mirror of each tab's conversation message count. Kept in sync by the
    /// unified conversation accessors (SessionViewModel+Conversation.swift) and
    /// mutateEngineInstance. Views observe this for scroll-to-bottom triggers.
    /// The messages themselves live on the single per-tab ConversationInstanceInfo
    /// (post-#256 unification) — read via `conversationMessages(_:)`.
    var loadingConversation: Set<String> = []
    var conversationLoaded: Set<String> = []
    var conversationHasMore: [String: Bool] = [:]
    var conversationCursor: [String: String] = [:]
    var conversationLoadFailed: Set<String> = []
    /// Per-tab debounce clock for the snapshot staleness reconcile. When the
    /// desktop snapshot's authoritative last-activity timestamp is newer than
    /// the newest local message (dropped live deltas — e.g. a LAN↔relay
    /// transport switch), the snapshot handler re-issues loadConversation to
    /// heal the gap. This map throttles that heal per tab so a burst of
    /// snapshots during a legitimately-streaming run does not thrash the
    /// re-fetch. See SessionViewModel+Snapshot.swift.
    var lastConversationReconcileAt: [String: Date] = [:]
    /// Timestamp of the last reconnect allowed to bypass the per-tab reconcile
    /// debounce. A flapping transport would otherwise re-trigger a full reload of
    /// every diverged tab on every reconnect, flooding the desktop with
    /// load_conversation requests; the bypass is granted at most once per
    /// reconnectReloadDebounce window. See SessionViewModel+Snapshot.swift.
    var lastReconnectReconcileAt: Date?
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
    var engineDialogs: [String: EngineDialogInfo?] = [:]
    var enginePinnedPrompt: [String: String] = [:]
    var engineTurnHasText: Set<String> = []                      // compoundKeys where current LLM sub-turn produced text
    // Agent dispatch conversation history (per conversationId for dispatch pager)
    var agentConversationMessages: [String: [Message]] = [:]     // conversationId -> messages (merged: snapshot + live push)
    var agentConversationLoading: Set<String> = []               // conversationIds currently loading
    // Live dispatched-agent transcript (architecture C — push + reconcile).
    // agentSnapshotByConvId holds the last file-backed snapshot (the authority);
    // agentDispatchActivity holds the in-flight push entries folded from
    // engine_dispatch_activity. recomputeDispatchTranscript merges them into
    // agentConversationMessages (what the popup reads). See
    // SessionViewModel+EngineEvents.swift.
    var agentSnapshotByConvId: [String: [Message]] = [:]         // conversationId -> last file snapshot
    var agentDispatchActivity: [String: [Message]] = [:]         // dispatchAgentId -> folded push entries (ordered)
    /// Parallel seq storage for sort tiebreaking. Indexed in lockstep with
    /// agentDispatchActivity: agentDispatchSeqs[dispatchId][i] is the seq for
    /// agentDispatchActivity[dispatchId][i]. Cleared with agentDispatchActivity.
    var agentDispatchSeqs: [String: [Int]] = [:]                 // dispatchAgentId -> per-entry seq values
    /// Maps conversationId -> most recent dispatchAgentId. Used by
    /// recomputeDispatchTranscript when invoked from handleAgentConversationHistory
    /// (which knows the convId but not the dispatchAgentId). Updated each time
    /// handleDispatchActivity receives an event for a given dispatchAgentId.
    var activeDispatchIdByConvId: [String: String] = [:]
    /// Tracks dispatchAgentIds whose push cache has already been cleared on the
    /// terminal edge. clearTerminalDispatchCaches is level-triggered (fires every
    /// engineAgentState tick) so this set gates the clear to run exactly once
    /// per dispatch, preventing repeated recomputeDispatchTranscript calls on
    /// every tick after a dispatch finishes.
    var terminalClearedDispatches: Set<String> = []
    /// Last-seen StatusFields.sessionId per tabId. Used by
    /// handleEngineSessionIdChange (SessionViewModel+DispatchCacheInvalidation.swift)
    /// to detect when the engine process restarts — a changed sessionId means
    /// all cached dispatch snapshots may be stale and must be re-fetched.
    var lastKnownEngineSessionId: [String: String] = [:]
    // Engine instance state (per engine tab)
    var conversationInstances: [String: [ConversationInstanceInfo]] = [:]   // tabId -> instances
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

    /// Enterprise new-conversation policy projected from the desktop via
    /// `desktop_settings_snapshot.newConversationPolicy`. Non-nil + locked=true
    /// means `resolveNewConversationAction` must return `.locked` and iOS
    /// must skip all pickers. Nil means no enterprise config (or pre-#256
    /// desktop build — treat as unlocked).
    var enterpriseNewConversationPolicy: RemoteNewConversationPolicy? = nil

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

    // Upload attachment results (consumed by InputBar / ConversationView)
    var pendingUploadResults: [UploadAttachmentResult] = []

    /// Pending /export payload waiting to be presented via the iOS share
    /// sheet. Populated by handleEngineExport on engine_export receipt;
    /// cleared by the view layer after the sheet is dismissed.
    ///
    /// Nil when no export is awaiting presentation. The view layer
    /// observes this property and presents the share sheet whenever it
    /// flips non-nil; the dismissal sets it back to nil.
    var pendingExport: PendingExport? = nil

    // MARK: - Toast Messages
    var toastMessages: [ToastMessage] = []

    /// Tab group mode synced from the desktop: "off", "auto", or "manual".
    var tabGroupMode: String = "auto"
    /// Manual tab group definitions from the desktop (only meaningful when tabGroupMode == "manual").
    var tabGroups: [RemoteTabGroup] = []

    var pairedDevices: [PairedDevice] = []
    var connectionState: ConnectionState = .disconnected
    var pairingState: PairingState = .idle

    /// Blocks deferred until the transport reaches `.connected` (i.e. the
    /// first snapshot has arrived and confirmed the round-trip works).
    /// Populated by `runWhenConnected(_:)` and drained inside
    /// `handleSnapshot` when `connectionState` flips to `.connected`. Also
    /// cleared by `disconnect()` so a hard reset wipes pending work.
    ///
    /// Exists to fix the iOS resume race: scene `.active` fires
    /// auto-resume commands (`requestAllGitChanges`, `sendReportFocus`)
    /// before the LAN/relay handshake completes, which otherwise produces
    /// spurious "Not connected" / "Send failed" toasts. See
    /// `SessionViewModel+OnConnected.swift` for the helper and
    /// `IonRemoteApp.swift`'s `.active` handler for the call sites.
    var pendingOnConnected: [() -> Void] = []

    /// True for the duration of the single snapshot handler invocation that
    /// corresponds to the first snapshot received after a (re)connect transition.
    /// Set to `true` inside `handleSnapshot` when `connectionState` flips from
    /// non-connected to `.connected`, and reset to `false` at the end of the
    /// same tab-processing loop. Read by `maybeReconcileStaleConversation` to
    /// bypass the running-status suppression guard: on a reconnect iOS has no
    /// in-flight stream — it missed all events during the gap — so a diverged
    /// fingerprint means genuinely stale content and must trigger an immediate
    /// reload rather than waiting for the post-run heal.
    var isReconnectSnapshot = false

    /// Keyed deferred queue for `.automaticEssential` sends that arrive
    /// while the transport is not yet `.connected`.
    ///
    /// Keys are stable command-identity strings (e.g. `"loadConversation:<tabId>"`,
    /// `"requestTerminalSnapshot:<tabId>"`, `"sync"`, `"gitChanges:<dir>"`).
    /// Last-write-wins: enqueueing the same key again supersedes the prior
    /// entry so a stale load intent from a tab the user navigated away from
    /// does not replay against the next transport.
    ///
    /// Drained once per `.connected` transition by `drainPendingEssential()`
    /// (called from `handleSnapshot`, next to `drainPendingOnConnected()`).
    /// Cleared by `clearPendingEssential()` on hard disconnect so stale
    /// intent from one desktop does not fire against a different pairing.
    ///
    /// Separate from `pendingOnConnected` (the closure-run-all queue) so
    /// the dedup semantics are explicit and the two queues can evolve
    /// independently. See `SessionViewModel+OnConnected.swift`.
    var pendingEssentialQueue: [(key: String, command: RemoteCommand)] = []

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
    /// Observed by ConversationView; cleared after the pane is presented.
    var pendingGitPaneTabId: String? = nil
    /// Dispatch ID to auto-open in AgentDetailFullScreenView after the conversation view
    /// appears. Mirrors the pendingNavigationTabId deep-link pattern. Set by
    /// StatusDrawerView when the user taps a running dispatch row; cleared after the
    /// fullScreenCover is presented. ConversationView observes via .onChange and opens
    /// AgentDetailFullScreenView for the specific dispatchId, reconstructing the ancestor
    /// breadcrumb chain before presenting (plan modest-leaping-waffle §9a).
    var pendingDispatchId: String? = nil
    /// The currently focused tab ID — the tab the user is viewing right now.
    /// Updated by TabListView whenever the selected/navigated tab changes and
    /// cleared when the app backgrounds. The desktop reads this via `report_focus`
    /// commands to route engine_intercept events to the correct device+tab.
    var focusedTabId: String? = nil
    /// Set `true` before sending a create-tab command so the `tabCreated`
    /// handler knows the creation was locally initiated and should navigate.
    var awaitingLocalTabCreation = false
    /// Text to prefill into the input bar (set by rewind/fork responses).
    var pendingInputByTab: [String: String] = [:]
    /// Per-tab unsent input text. Persisted to UserDefaults across launches.
    /// Keyed by bare `tabId` for both plain and engine tabs (the single unified
    /// draft store, post-#256). Updated on every keystroke via the InputBar
    /// binding. See SessionViewModel+Drafts.swift.
    var draftInputByTab: [String: String] = [:]
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

    /// Whether to tint tab rows with their configured pill color (on by default).
    /// iOS-only preference — does not affect desktop. When disabled the tab list
    /// renders without any color tinting regardless of what the desktop has set.
    var showTabColorInTabList: Bool {
        get { UserDefaults.standard.object(forKey: "showTabColorInTabList") == nil
              ? true
              : UserDefaults.standard.bool(forKey: "showTabColorInTabList") }
        set { UserDefaults.standard.set(newValue, forKey: "showTabColorInTabList") }
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
    /// Delays between in-place retries of a *transient* LAN auth failure in
    /// `connectLAN` (socket dropped / cooldown close / timeout — the desktop
    /// delivered no verdict). Instance-configurable so tests can shrink the
    /// waits; production keeps 2s then 5s. Definitive rejections never retry.
    var lanAuthRetryDelays: [Duration] = [.seconds(2), .seconds(5)]
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

    /// The desktop's `defaultEngineProfileId` preference, projected via
    /// `desktopSettingsSnapshot`. Non-empty means the user has chosen a
    /// default engine profile; empty means "unset" (show the picker).
    /// Matches how `resolveNewConversationAction` reads `defaultId`.
    var defaultEngineProfileId: String {
        (desktopSettings?.currentValue(for: "defaultEngineProfileId")?.value as? String) ?? ""
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

    // MARK: - Init
    // Draft persistence methods live in SessionViewModel+Drafts.swift.

    init() {
        loadPairedDevices()
        // Restore hasConnectedBefore from UserDefaults
        hasConnectedBefore = UserDefaults.standard.bool(forKey: "hasConnectedBefore")
        hydrateDrafts()
    }
}
