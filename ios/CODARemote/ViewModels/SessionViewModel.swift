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
    private var conversationLoadRetryCount: [String: Int] = [:]
    private var conversationLoadTimers: [String: Task<Void, Never>] = [:]
    /// Tracks dismissed restored special cards (ExitPlanMode/AskUserQuestion from history)
    var dismissedRestoredCards: Set<String> = []
    /// Tracks tabs where a live special card was dismissed (prevents restoredSpecialCard re-trigger)
    var dismissedLiveSpecialTabs: Set<String> = []
    // Terminal state (per terminal tab)
    var terminalInstances: [String: [TerminalInstanceInfo]] = [:]  // tabId -> instances
    var activeTerminalInstance: [String: String] = [:]              // tabId -> active instanceId
    /// Local display name overrides for terminal instances (keyed by "tabId:instanceId").
    var terminalInstanceLabels: [String: String] = [:]
    /// Tab IDs that iOS has requested to close but hasn't received tab_closed confirmation for.
    private var pendingCloseTabIds: Set<String> = []

    var pairedDevices: [PairedDevice] = []
    var connectionState: ConnectionState = .disconnected
    var pairingState: PairingState = .idle
    /// Recent base directories from the desktop, updated via snapshot events.
    var recentDirectories: [String] = []
    /// Tab ID to auto-navigate to after remote creation.
    var pendingNavigationTabId: String? = nil
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

    // MARK: - Private

    var transportState: TransportState { transport?.state ?? .disconnected }

    private var transport: TransportManager?
    private var eventTask: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    private let eventBatcher = EventBatcher()
    /// Standalone browser for pairing discovery (before a transport exists).
    private(set) var pairingBrowser = BonjourBrowser()

    // MARK: - Computed

    func tab(for id: String) -> RemoteTabState? {
        tabs.first { $0.id == id }
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

    // MARK: - Init

    init() {
        loadPairedDevices()
    }

    // MARK: - Lifecycle

    /// Connect to the first paired device using its relay configuration.
    func connect() {
        guard let device = pairedDevices.first else {
            print("[CODA] connect: no paired devices")
            return
        }
        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)

        let effectiveRelayURL = device.relayURL ?? relayURL
        let effectiveAPIKey = device.relayAPIKey ?? relayAPIKey

        print("[CODA] connect: relayURL=\(effectiveRelayURL) apiKey=\(effectiveAPIKey.prefix(8))... channelId=\(channelId.prefix(8))...")

        guard !effectiveRelayURL.isEmpty,
              let url = URL(string: effectiveRelayURL) else {
            print("[CODA] connect: invalid or empty relay URL, aborting")
            return
        }

        let tm = TransportManager(
            relayURL: url,
            apiKey: effectiveAPIKey,
            channelId: channelId,
            sharedKey: sharedKey
        )
        self.transport = tm
        connectionState = .connecting

        Task {
            await tm.start()
            // Relay connected -- send sync so the desktop knows we're here
            // and replies with a snapshot. The relay server may not send a
            // peer-reconnected control frame to the desktop on its own.
            do {
                try await tm.send(.sync)
                print("[CODA] connect: sent sync after relay connect")
            } catch {
                print("[CODA] connect: failed to send sync: \(error)")
            }
        }
        startListening()
    }

    /// Connect directly to a CODA LAN server (no relay).
    /// Uses TransportManager with LAN auth handshake.
    func connectLAN(host: String, port: UInt16) {
        guard let device = pairedDevices.first else { return }

        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let tm = TransportManager(sharedKey: sharedKey, deviceId: device.id)
        self.transport = tm
        connectionState = .connecting

        Task {
            let authed = await tm.startLANWithAuth(host: host, port: port)
            if authed {
                await MainActor.run {
                    self.connectionState = .connected
                    self.send(.sync)
                }
            } else {
                await MainActor.run {
                    self.connectionState = .authFailed
                    self.transport?.stop()
                    self.transport = nil
                }
            }
        }
        startListening()
    }

    /// Reconnect using relay with automatic LAN upgrade via Bonjour.
    func reconnect() {
        connect()
    }

    /// Disconnect from the current transport and wipe all transient state.
    func disconnect() {
        eventTask?.cancel()
        eventTask = nil
        flushTask?.cancel()
        flushTask = nil
        transport?.stop()
        transport = nil
        wipeTransientState()
    }

    /// Clear all transient state (tabs, messages, etc.) to prevent stale data.
    private func wipeTransientState() {
        connectionState = .disconnected
        tabs = []
        tabIds = []
        liveText = [:]
        messages = [:]
        messageCountByTab = [:]
        loadingConversation = []
        conversationLoaded = []
        conversationHasMore = [:]
        conversationCursor = [:]
        conversationLoadFailed = []
        for (_, timer) in conversationLoadTimers { timer.cancel() }
        conversationLoadTimers = [:]
        conversationLoadRetryCount = [:]
        terminalInstances = [:]
        activeTerminalInstance = [:]
        terminalInstanceLabels = [:]
        pendingCloseTabIds = []
        pendingInputByTab = [:]
    }

    // MARK: - Commands

    func sync() {
        send(.sync)
    }

    func sendSync() {
        send(.sync)
    }

    func sendPrompt(tabId: String, text: String) {
        send(.prompt(tabId: tabId, text: text))
    }

    func cancel(tabId: String) {
        send(.cancel(tabId: tabId))
    }

    func rewindConversation(tabId: String, messageId: String) {
        send(.rewind(tabId: tabId, messageId: messageId))
    }

    func forkFromMessage(tabId: String, messageId: String) {
        send(.forkFromMessage(tabId: tabId, messageId: messageId))
    }

    func respondPermission(tabId: String, questionId: String, optionId: String) {
        send(.respondPermission(tabId: tabId, questionId: questionId, optionId: optionId))
    }

    /// Dismiss a special permission card (AskUserQuestion/ExitPlanMode) without
    /// sending respond_permission -- the tool was already auto-allowed on desktop.
    func dismissSpecialPermission(tabId: String, questionId: String) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].permissionQueue.removeAll { $0.questionId == questionId }
        }
        if questionId.hasPrefix("restored-") {
            dismissedRestoredCards.insert(questionId)
        } else {
            // Live card dismissed -- block restoredSpecialCard from re-triggering
            dismissedLiveSpecialTabs.insert(tabId)
        }
    }

    func loadConversation(tabId: String) {
        guard !loadingConversation.contains(tabId) else { return }
        messages.removeValue(forKey: tabId)
        messageCountByTab.removeValue(forKey: tabId)
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
        conversationLoadFailed.remove(tabId)
        loadingConversation.insert(tabId)
        send(.loadConversation(tabId: tabId, before: nil))
        startLoadTimer(tabId: tabId)
    }

    func clearConversation(tabId: String) {
        messages.removeValue(forKey: tabId)
        messageCountByTab.removeValue(forKey: tabId)
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
        dismissedRestoredCards = dismissedRestoredCards.filter { !$0.hasPrefix("restored-") }
    }

    func loadMoreMessages(tabId: String) {
        guard !loadingConversation.contains(tabId),
              conversationHasMore[tabId] == true,
              let cursor = conversationCursor[tabId] else { return }
        loadingConversation.insert(tabId)
        send(.loadConversation(tabId: tabId, before: cursor))
        startLoadTimer(tabId: tabId)
    }

    private func startLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers[tabId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self else { return }
            guard self.loadingConversation.contains(tabId) else { return }
            let retries = self.conversationLoadRetryCount[tabId] ?? 0
            if retries < 1 {
                // First timeout -- retry once
                self.conversationLoadRetryCount[tabId] = retries + 1
                let cursor = self.conversationCursor[tabId]
                self.send(.loadConversation(tabId: tabId, before: cursor))
                self.startLoadTimer(tabId: tabId)
            } else {
                // Second timeout -- give up
                self.loadingConversation.remove(tabId)
                self.conversationLoadFailed.insert(tabId)
                self.conversationLoadTimers.removeValue(forKey: tabId)
                self.conversationLoadRetryCount.removeValue(forKey: tabId)
            }
        }
    }

    private func cancelLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers.removeValue(forKey: tabId)
        conversationLoadRetryCount.removeValue(forKey: tabId)
    }

    func createTab(workingDirectory: String? = nil) {
        let dir = workingDirectory ?? defaultBaseDirectory
        send(.createTab(workingDirectory: dir))
    }

    func closeTab(_ tabId: String) {
        pendingCloseTabIds.insert(tabId)
        send(.closeTab(tabId: tabId))
        tabs.removeAll { $0.id == tabId }
        liveText.removeValue(forKey: tabId)
        messages.removeValue(forKey: tabId)
        loadingConversation.remove(tabId)
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
    }

    func setPermissionMode(tabId: String, mode: PermissionMode) {
        // Optimistic local update for responsive UI
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].permissionMode = mode
        }
        send(.setPermissionMode(tabId: tabId, mode: mode))
    }

    // MARK: - Terminal Commands

    func createTerminalTab(workingDirectory: String? = nil) {
        let dir = workingDirectory ?? defaultBaseDirectory
        send(.createTerminalTab(workingDirectory: dir))
    }

    func sendTerminalInput(tabId: String, instanceId: String, data: String) {
        send(.terminalInput(tabId: tabId, instanceId: instanceId, data: data))
    }

    func sendTerminalResize(tabId: String, instanceId: String, cols: Int, rows: Int) {
        send(.terminalResize(tabId: tabId, instanceId: instanceId, cols: cols, rows: rows))
    }

    func addTerminalInstance(tabId: String) {
        send(.terminalAddInstance(tabId: tabId))
    }

    func removeTerminalInstance(tabId: String, instanceId: String) {
        send(.terminalRemoveInstance(tabId: tabId, instanceId: instanceId))
    }

    func selectTerminalInstance(tabId: String, instanceId: String) {
        activeTerminalInstance[tabId] = instanceId
        send(.terminalSelectInstance(tabId: tabId, instanceId: instanceId))
    }

    func requestTerminalSnapshot(tabId: String) {
        send(.requestTerminalSnapshot(tabId: tabId))
    }

    func renameTab(tabId: String, customTitle: String?) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].customTitle = customTitle
        }
        send(.renameTab(tabId: tabId, customTitle: customTitle))
    }

    func renameTerminalInstance(tabId: String, instanceId: String, label: String) {
        terminalInstanceLabels["\(tabId):\(instanceId)"] = label
        send(.renameTerminalInstance(tabId: tabId, instanceId: instanceId, label: label))
    }

    func terminalInstanceLabel(tabId: String, instanceId: String, fallback: String) -> String {
        terminalInstanceLabels["\(tabId):\(instanceId)"] ?? fallback
    }

    // MARK: - Device Management

    func unpairDevice(_ device: PairedDevice) {
        // Notify desktop before disconnecting so it removes the device.
        Task {
            try? await transport?.send(.unpair)
            await MainActor.run {
                self.pairedDevices.removeAll { $0.id == device.id }
                self.savePairedDevices()
                if self.pairedDevices.isEmpty {
                    self.disconnect()
                }
            }
        }
    }

    func resetAll() {
        // Notify desktop before disconnecting so it removes the device.
        Task {
            try? await transport?.send(.unpair)
            await MainActor.run {
                self.disconnect()
                self.pairedDevices = []
                self.liveText = [:]
                self.messages = [:]
                self.loadingConversation = []
                self.conversationLoaded = []
                self.conversationHasMore = [:]
                self.conversationCursor = [:]
                self.tabs = []
                self.relayURL = ""
                self.relayAPIKey = ""
                self.pairingState = .idle
                try? KeychainStore.deleteAll()
            }
        }
    }

    func saveRelayConfig() {
        guard !pairedDevices.isEmpty else { return }
        pairedDevices[0].relayURL = relayURL
        pairedDevices[0].relayAPIKey = relayAPIKey
        savePairedDevices()
    }

    // MARK: - Pairing

    func startPairing() {
        pairingState = .discovering
        pairingBrowser.startBrowsing()
    }

    func pairWithHost(_ host: DiscoveredHost) {
        pairingState = .connecting(hostName: host.name)

        Task {
            _ = E2ECrypto.generateKeyPair()
            await MainActor.run {
                self.pairingState = .exchangingKeys
            }
            await MainActor.run {
                self.pairingState = .configuringRelay
            }
        }
    }

    func completePairing(relayURL: String, relayAPIKey: String) {
        self.relayURL = relayURL
        self.relayAPIKey = relayAPIKey

        if !pairedDevices.isEmpty {
            pairedDevices[0].relayURL = relayURL
            pairedDevices[0].relayAPIKey = relayAPIKey
            savePairedDevices()
        }

        pairingState = .paired
        connect()
    }

    /// Pair directly with a CODA instance over LAN using a 6-digit pairing code.
    func pairWithCode(host: String, port: UInt16, name: String, code: String) {
        pairingState = .connecting(hostName: name)

        Task {
            do {
                guard let url = URL(string: "ws://\(host):\(port)/pair") else {
                    throw PairingError.invalidResponse
                }
                var request = URLRequest(url: url)
                request.timeoutInterval = 10

                let session = URLSession(configuration: .default)
                let ws = session.webSocketTask(with: request)
                ws.resume()

                let keyPair = E2ECrypto.generateKeyPair()
                let publicKeyB64 = keyPair.publicKey.rawRepresentation.base64EncodedString()

                let deviceName = await UIDevice.current.name
                let pairingRequest: [String: String] = [
                    "type": "pair_request",
                    "code": code,
                    "publicKey": publicKeyB64,
                    "deviceName": deviceName,
                ]
                let requestData = try JSONSerialization.data(withJSONObject: pairingRequest)
                try await ws.send(.string(String(data: requestData, encoding: .utf8)!))

                await MainActor.run {
                    self.pairingState = .exchangingKeys
                }

                let response = try await ws.receive()
                let responseData: Data
                switch response {
                case .string(let text):
                    responseData = text.data(using: .utf8) ?? Data()
                case .data(let data):
                    responseData = data
                @unknown default:
                    throw PairingError.invalidResponse
                }

                guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                      let peerPublicKeyB64 = json["publicKey"] as? String,
                      let peerPublicKeyData = Data(base64Encoded: peerPublicKeyB64) else {
                    throw PairingError.invalidResponse
                }

                let peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKeyData)
                let sharedKey = try E2ECrypto.deriveSharedSecret(privateKey: keyPair, peerPublicKey: peerPublicKey)
                let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)
                let sharedKeyData = sharedKey.withUnsafeBytes { Data($0) }

                let relayUrl = (json["relayUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? "ws://\(host):\(port)"
                let relayApiKey = (json["relayApiKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? "lan-direct"

                let device = PairedDevice(
                    id: channelId.prefix(16).description,
                    name: name,
                    pairedAt: Date(),
                    lastSeen: nil,
                    channelId: channelId,
                    sharedSecret: sharedKeyData,
                    relayURL: relayUrl,
                    relayAPIKey: relayApiKey
                )

                ws.cancel(with: .normalClosure, reason: nil)

                await MainActor.run {
                    self.pairedDevices = [device]
                    self.relayURL = relayUrl
                    self.relayAPIKey = relayApiKey
                    self.savePairedDevices()
                    self.pairingState = .paired
                    self.connectLAN(host: host, port: port)
                }
            } catch {
                await MainActor.run {
                    self.pairingState = .failed(error)
                }
            }
        }
    }

    /// Attempt a codeless recovery re-pair with a CODA instance that already
    /// has this device in its paired list (e.g. after a simulator reinstall
    /// wiped the Keychain). Returns true if the desktop accepted the recovery.
    func recoveryPair(host: String, port: UInt16, name: String) async -> Bool {
        await MainActor.run { pairingState = .connecting(hostName: name) }

        do {
            guard let url = URL(string: "ws://\(host):\(port)/pair") else { return false }
            var request = URLRequest(url: url)
            request.timeoutInterval = 5

            let session = URLSession(configuration: .default)
            let ws = session.webSocketTask(with: request)
            ws.resume()

            let keyPair = E2ECrypto.generateKeyPair()
            let publicKeyB64 = keyPair.publicKey.rawRepresentation.base64EncodedString()

            let deviceName = await UIDevice.current.name
            let pairingRequest: [String: Any] = [
                "type": "pair_request",
                "code": "",
                "publicKey": publicKeyB64,
                "deviceName": deviceName,
                "recovery": true,
            ]
            let requestData = try JSONSerialization.data(withJSONObject: pairingRequest)
            try await ws.send(.string(String(data: requestData, encoding: .utf8)!))

            await MainActor.run { self.pairingState = .exchangingKeys }

            let response = try await ws.receive()
            let responseData: Data
            switch response {
            case .string(let text):
                responseData = text.data(using: .utf8) ?? Data()
            case .data(let data):
                responseData = data
            @unknown default:
                return false
            }

            guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                  let peerPublicKeyB64 = json["publicKey"] as? String,
                  let peerPublicKeyData = Data(base64Encoded: peerPublicKeyB64) else {
                // Desktop rejected recovery (pair_error response) -- not a known device.
                ws.cancel(with: .normalClosure, reason: nil)
                return false
            }

            let peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKeyData)
            let sharedKey = try E2ECrypto.deriveSharedSecret(privateKey: keyPair, peerPublicKey: peerPublicKey)
            let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)
            let sharedKeyData = sharedKey.withUnsafeBytes { Data($0) }

            let relayUrl = (json["relayUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? "ws://\(host):\(port)"
            let relayApiKey = (json["relayApiKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? "lan-direct"

            let device = PairedDevice(
                id: channelId.prefix(16).description,
                name: name,
                pairedAt: Date(),
                lastSeen: nil,
                channelId: channelId,
                sharedSecret: sharedKeyData,
                relayURL: relayUrl,
                relayAPIKey: relayApiKey
            )

            ws.cancel(with: .normalClosure, reason: nil)

            await MainActor.run {
                self.pairedDevices = [device]
                self.relayURL = relayUrl
                self.relayAPIKey = relayApiKey
                self.savePairedDevices()
                self.pairingState = .paired
                self.connectLAN(host: host, port: port)
            }
            return true
        } catch {
            return false
        }
    }

    func cancelPairing() {
        pairingBrowser.stopBrowsing()
        pairingState = .idle
    }

    // MARK: - Send

    private func send(_ command: RemoteCommand) {
        guard let transport else { return }
        Task {
            try? await transport.send(command)
        }
    }

    // MARK: - Event Listening

    private func startListening() {
        eventTask?.cancel()
        flushTask?.cancel()

        // Collector: read events from transport and enqueue into batcher
        eventTask = Task { [weak self] in
            guard let self, let transport = self.transport else { return }

            for await event in transport.events {
                guard !Task.isCancelled else { break }
                await self.eventBatcher.enqueue(event)
            }

            // Stream ended -- flush any remaining events then wipe state
            let remaining = await self.eventBatcher.drain()
            await MainActor.run {
                for event in remaining {
                    self.handleEvent(event)
                }
                self.wipeTransientState()
            }
        }

        // Flusher: drain batched events every ~16ms and process on MainActor
        flushTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                guard !Task.isCancelled, let self else { break }

                let batch = await self.eventBatcher.drain()
                if !batch.isEmpty {
                    await MainActor.run {
                        for event in batch {
                            self.handleEvent(event)
                        }
                    }
                }
            }
        }
    }

    @MainActor
    private func handleEvent(_ event: RemoteEvent) {
        print("[CODA] handleEvent: \(event)")
        switch event {
        case .unpair:
            // Desktop revoked our pairing -- clear everything and return to discovery.
            // Clear pairedDevices BEFORE disconnect so SwiftUI doesn't briefly show
            // the disconnected view (which auto-triggers reconnect while devices exist).
            pairedDevices = []
            try? KeychainStore.deleteAll()
            pairingState = .idle
            disconnect()

        case .relayConfig(let relayUrl, let relayApiKey):
            // Desktop pushed updated relay config -- persist it for roaming.
            self.relayURL = relayUrl
            self.relayAPIKey = relayApiKey
            if !pairedDevices.isEmpty {
                pairedDevices[0].relayURL = relayUrl
                pairedDevices[0].relayAPIKey = relayApiKey
                savePairedDevices()
            }

        case .transportReconnecting:
            if connectionState == .connected {
                connectionState = .reconnecting
            }

        case .peerDisconnected:
            // Tear down and let the auto-retry in CODARemoteApp reconnect.
            // connect() creates a relay-capable transport and starts Bonjour,
            // so LAN auto-upgrade still works when the desktop comes back.
            disconnect()

        case .snapshot(let snapshotTabs, let recentDirs):
            if connectionState != .connected {
                connectionState = .connected
            }
            if !recentDirs.isEmpty {
                recentDirectories = recentDirs
            }
            // Filter out tabs that iOS requested to close but hasn't received
            // tab_closed confirmation for yet. Without this, the snapshot
            // resurrects tabs that the user just swiped away.
            let filteredTabs = snapshotTabs.filter { !pendingCloseTabIds.contains($0.id) }
            // Preserve locally-injected permission queue entries that arrived
            // via permission_request events. Snapshots pull the queue from the
            // desktop renderer, which may have already auto-allowed tools like
            // AskUserQuestion/ExitPlanMode (empty queue), while iOS still needs
            // to show the card until the user taps an answer.
            var merged = filteredTabs
            for i in merged.indices {
                if let existing = tabs.first(where: { $0.id == merged[i].id }),
                   !existing.permissionQueue.isEmpty {
                    // Keep existing local queue entries that aren't in the snapshot
                    let snapshotIds = Set(merged[i].permissionQueue.map(\.questionId))
                    let localOnly = existing.permissionQueue.filter { !snapshotIds.contains($0.questionId) }
                    merged[i].permissionQueue.append(contentsOf: localOnly)
                }
            }
            tabs = merged
            tabIds = Set(merged.map(\.id))
            // Populate terminal state from snapshot tab data
            for tab in merged {
                if tab.isTerminalOnly == true, let instances = tab.terminalInstances {
                    terminalInstances[tab.id] = instances
                    activeTerminalInstance[tab.id] = tab.activeTerminalInstanceId ?? instances.first?.id
                }
            }

        case .tabCreated(let tab):
            if !tabs.contains(where: { $0.id == tab.id }) {
                tabs.append(tab)
                tabIds.insert(tab.id)
            }
            pendingNavigationTabId = tab.id

        case .tabClosed(let tabId):
            pendingCloseTabIds.remove(tabId)
            tabs.removeAll { $0.id == tabId }
            tabIds.remove(tabId)
            liveText.removeValue(forKey: tabId)

        case .tabStatus(let tabId, let status):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].status = status
                if status == .idle || status == .completed || status == .failed || status == .dead {
                    liveText.removeValue(forKey: tabId)
                    // Preserve ExitPlanMode/AskUserQuestion entries -- desktop auto-allows
                    // these but iOS needs them for plan card UI and status indicators
                    tabs[idx].permissionQueue.removeAll {
                        $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
                    }
                }
            }

        case .textChunk(let tabId, let text):
            liveText[tabId, default: ""] += text
            // Update tab preview for the tab list (shows most recent text)
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                let preview = liveText[tabId, default: ""]
                tabs[idx].lastMessage = String(preview.suffix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
            guard !conversationLoaded.contains(tabId) else { break }

        case .toolCall(let tabId, let toolName, _):
            guard !conversationLoaded.contains(tabId) else { break }
            liveText[tabId, default: ""] += "\n> \(toolName)\n"

        case .toolResult(let tabId, _, let content, let isError):
            guard !conversationLoaded.contains(tabId) else { break }
            let prefix = isError ? "[error]" : "[ok]"
            let truncated = content.prefix(200)
            liveText[tabId, default: ""] += "\(prefix) \(truncated)\n"

        case .taskComplete(let tabId, _, _):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].status = .completed
                // Preserve ExitPlanMode/AskUserQuestion entries for plan card UI
                tabs[idx].permissionQueue.removeAll {
                    $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
                }
                // Capture final preview from accumulated live text before it's cleared
                if let text = liveText[tabId], !text.isEmpty {
                    tabs[idx].lastMessage = String(text.suffix(64))
                        .replacingOccurrences(of: "\n", with: " ")
                }
            }
            liveText.removeValue(forKey: tabId)

        case .permissionRequest(let tabId, let questionId, let toolName, let toolInput, let options):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                // Normalize AnyCodable toolInput to Foundation types so the
                // card views can parse with simple `as?` casts. The Codable
                // decoder wraps nested values as [AnyCodable]/[String: AnyCodable],
                // but the card views expect Foundation types (NSArray/NSDictionary)
                // which is what JSONSerialization produces.
                var normalizedInput = toolInput
                if let input = toolInput,
                   let data = try? JSONEncoder().encode(input),
                   let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    normalizedInput = dict.mapValues { AnyCodable($0) }
                }
                let request = PermissionRequest(
                    questionId: questionId,
                    toolName: toolName,
                    toolInput: normalizedInput,
                    options: options
                )
                tabs[idx].permissionQueue.append(request)
            }

        case .permissionResolved(let tabId, let questionId):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].permissionQueue.removeAll { $0.questionId == questionId }
            }

        case .conversationHistory(let tabId, let newMessages, let hasMore, let cursor):
            cancelLoadTimer(tabId: tabId)
            conversationLoadFailed.remove(tabId)
            loadingConversation.remove(tabId)
            conversationLoaded.insert(tabId)
            conversationHasMore[tabId] = hasMore
            conversationCursor[tabId] = cursor
            if cursor != nil {
                messages[tabId] = newMessages + (messages[tabId] ?? [])
            } else {
                messages[tabId] = newMessages
            }
            messageCountByTab[tabId] = messages[tabId]?.count ?? 0

        case .messageAdded(let tabId, let message):
            // Always update tab preview for user/assistant messages (even if conversation isn't loaded)
            if message.role == .user || message.role == .assistant {
                if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                    tabs[idx].lastMessage = String(message.content.prefix(64))
                        .replacingOccurrences(of: "\n", with: " ")
                }
            }
            guard conversationLoaded.contains(tabId) else { break }
            if messages[tabId] != nil {
                if messages[tabId]!.contains(where: { $0.id == message.id }) { break }
                messages[tabId]!.append(message)
            } else {
                messages[tabId] = [message]
            }
            messageCountByTab[tabId] = messages[tabId]?.count ?? 0

        case .messageUpdated(let tabId, let messageId, let content, let toolStatus, let toolInput):
            guard conversationLoaded.contains(tabId) else { break }
            if let idx = messages[tabId]?.firstIndex(where: { $0.id == messageId }) {
                if let content {
                    messages[tabId]![idx].content = content
                }
                if let toolStatus {
                    // Meta-tools report as errors but should show as completed (not error, not stuck running)
                    let toolName = messages[tabId]![idx].toolName
                    if toolName == "ExitPlanMode" || toolName == "AskUserQuestion" {
                        messages[tabId]![idx].toolStatus = .completed
                    } else {
                        messages[tabId]![idx].toolStatus = toolStatus
                    }
                }
                if let toolInput {
                    messages[tabId]![idx].toolInput = toolInput
                }
            }

        case .queueUpdate(let tabId, let prompts):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].queuedPrompts = prompts
            }

        case .error(let tabId, let message):
            guard !conversationLoaded.contains(tabId) else { break }
            liveText[tabId, default: ""] += "\n[error] \(message)\n"

        case .inputPrefill(let tabId, let text, let switchTo):
            pendingInputByTab[tabId] = text
            if switchTo {
                pendingNavigationTabId = tabId
            } else {
                // Rewind: reload the conversation for this tab
                conversationLoaded.remove(tabId)
                messages.removeValue(forKey: tabId)
                messageCountByTab.removeValue(forKey: tabId)
                conversationLoadFailed.remove(tabId)
                loadConversation(tabId: tabId)
            }

        // Terminal events
        case .terminalOutput(let tabId, let instanceId, let data):
            TerminalOutputRouter.shared.route(tabId: tabId, instanceId: instanceId, data: data)

        case .terminalExit(let tabId, let instanceId, let exitCode):
            TerminalOutputRouter.shared.routeExit(tabId: tabId, instanceId: instanceId, exitCode: exitCode)

        case .terminalInstanceAdded(let tabId, let instance):
            terminalInstances[tabId, default: []].append(instance)

        case .terminalInstanceRemoved(let tabId, let instanceId):
            terminalInstances[tabId]?.removeAll { $0.id == instanceId }
            if activeTerminalInstance[tabId] == instanceId {
                activeTerminalInstance[tabId] = terminalInstances[tabId]?.first?.id
            }

        case .terminalSnapshot(let tabId, let instances, let activeInstanceId, let buffers):
            terminalInstances[tabId] = instances
            activeTerminalInstance[tabId] = activeInstanceId ?? instances.first?.id
            // Feed buffered scrollback to registered terminal views
            if let buffers {
                for (instanceId, data) in buffers {
                    TerminalOutputRouter.shared.feedBuffer(tabId: tabId, instanceId: instanceId, data: data)
                }
            }
        }
    }

    // MARK: - Persistence

    private func loadPairedDevices() {
        pairedDevices = (try? KeychainStore.loadPairedDevices()) ?? []
    }

    private func savePairedDevices() {
        try? KeychainStore.savePairedDevices(pairedDevices)
    }
}

// MARK: - EventBatcher

/// Collects remote events off the main thread so they can be drained
/// in a single batch and processed in one MainActor block per frame.
private actor EventBatcher {
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
