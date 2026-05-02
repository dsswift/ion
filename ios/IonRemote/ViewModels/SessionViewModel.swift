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
    var engineMessages: [String: [EngineMessage]] = [:]         // compoundKey -> messages
    var engineConversationLoaded: Set<String> = []               // compoundKeys that have loaded history
    // Engine instance state (per engine tab)
    var engineInstances: [String: [EngineInstanceInfo]] = [:]   // tabId -> instances
    var activeEngineInstance: [String: String] = [:]              // tabId -> active instanceId
    /// Engine profiles synced from the desktop settings.
    var engineProfiles: [EngineProfile] = []
    /// Active tool calls per tab, keyed by toolId.
    var activeTools: [String: [String: ActiveToolInfo]] = [:]
    /// Tab IDs that iOS has requested to close but hasn't received tab_closed confirmation for.
    var pendingCloseTabIds: Set<String> = []

    /// Tab group mode synced from the desktop: "off", "auto", or "manual".
    var tabGroupMode: String = "auto"
    /// Manual tab group definitions from the desktop (only meaningful when tabGroupMode == "manual").
    var tabGroups: [RemoteTabGroup] = []

    var pairedDevices: [PairedDevice] = []
    var connectionState: ConnectionState = .disconnected
    var pairingState: PairingState = .idle
    /// Recent base directories from the desktop, updated via snapshot events.
    var recentDirectories: [String] = []
    /// Tab ID to auto-navigate to after remote creation.
    var pendingNavigationTabId: String? = nil
    /// Set `true` before sending a create-tab command so the `tabCreated`
    /// handler knows the creation was locally initiated and should navigate.
    var awaitingLocalTabCreation = false
    /// Text to prefill into the input bar (set by rewind/fork responses).
    var pendingInputByTab: [String: String] = [:]
    /// Default directory for new tabs on iOS (independent of desktop setting).
    var defaultBaseDirectory: String? {
        get { UserDefaults.standard.string(forKey: "defaultBaseDirectory") }
        set { UserDefaults.standard.set(newValue, forKey: "defaultBaseDirectory") }
    }

    // MARK: - Settings (persisted via paired device)

    var relayURL: String = ""
    var relayAPIKey: String = ""

    // MARK: - Transport

    var transportState: TransportState { transport?.state ?? .disconnected }

    var transport: TransportManager?
    var eventTask: Task<Void, Never>?
    var flushTask: Task<Void, Never>?
    let eventBatcher = EventBatcher()
    /// Standalone browser for pairing discovery (before a transport exists).
    private(set) var pairingBrowser = BonjourBrowser()

    // MARK: - Computed

    func tab(for id: String) -> RemoteTabState? {
        tabs.first { $0.id == id }
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
        // Build ordered groups preserving tab order
        var order: [String] = []
        var groups: [String: [RemoteTabState]] = [:]
        for tab in tabs {
            let key = tab.workingDirectory
            if groups[key] == nil {
                order.append(key)
            }
            groups[key, default: []].append(tab)
        }

        // Count how many distinct full paths share each basename
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

    // MARK: - Init

    init() {
        loadPairedDevices()
    }
}
