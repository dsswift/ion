import Foundation
import CryptoKit

// MARK: - Lifecycle

extension SessionViewModel {

    /// Connect to the first paired device using its relay configuration.
    func connect() {
        // Tear down any existing transport before creating a new one.
        // This prevents stale reconnect timers from fighting the new connection.
        if transport != nil {
            eventTask?.cancel()
            eventTask = nil
            flushTask?.cancel()
            flushTask = nil
            transport?.stop()
            transport = nil
        }

        guard let device = pairedDevices.first else {
            print("[Ion] connect: no paired devices")
            return
        }
        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)

        let effectiveRelayURL = device.relayURL ?? relayURL
        let effectiveAPIKey = device.relayAPIKey ?? relayAPIKey

        print("[Ion] connect: relayURL=\(effectiveRelayURL) apiKey=\(effectiveAPIKey.prefix(8))... channelId=\(channelId.prefix(8))...")

        guard !effectiveRelayURL.isEmpty,
              let url = URL(string: effectiveRelayURL) else {
            print("[Ion] connect: invalid or empty relay URL, aborting")
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
        }
        startListening()
    }

    /// Connect directly to an Ion LAN server (no relay).
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
    /// Tears down the old transport first to prevent stale reconnect
    /// timers from fighting the new connection on the same relay channel.
    func reconnect() {
        disconnect()
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
    func wipeTransientState() {
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
        engineAgentStates = [:]
        engineStatusFields = [:]
        engineWorkingMessages = [:]
        engineDialogs = [:]
        enginePinnedPrompt = [:]
        engineMessages = [:]
        engineConversationLoaded = []
        engineInstances = [:]
        activeEngineInstance = [:]
        engineProfiles = []
        pendingCloseTabIds = []
        pendingInputByTab = [:]
        activeTools = [:]
        tabGroupMode = "auto"
        tabGroups = []
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

    // MARK: - Persistence

    func loadPairedDevices() {
        pairedDevices = (try? KeychainStore.loadPairedDevices()) ?? []
    }

    func savePairedDevices() {
        try? KeychainStore.savePairedDevices(pairedDevices)
    }
}
