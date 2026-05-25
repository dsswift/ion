import Foundation
import CryptoKit
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "lifecycle")

// MARK: - Lifecycle

extension SessionViewModel {

    /// Connect to the active paired device using its relay configuration.
    /// Falls back to LAN-only mode when no real relay is configured.
    func connect() {
        tearDownTransport()

        guard let device = activeDevice else {
            ionLog.warning("connect: no paired devices")
            DiagnosticLog.log("CONNECT: no paired devices")
            return
        }

        let effectiveRelayURL = device.relayURL ?? relayURL
        let effectiveAPIKey = device.relayAPIKey ?? relayAPIKey

        // When the device was paired over LAN without a relay, the stored
        // relay URL is actually the LAN address (ws://host:port) with
        // apiKey "lan-direct". Use LAN-only mode in that case.
        if effectiveAPIKey == "lan-direct",
           let url = URL(string: effectiveRelayURL),
           let host = url.host(percentEncoded: false),
           let port = url.port {
            ionLog.info("connect: device=\(device.name) via LAN-only (\(host):\(port))")
            DiagnosticLog.log("CONNECT: LAN-direct \(device.name) \(host):\(port) id=\(device.id.prefix(8))")
            restoreCachedLayout(for: device.id)
            connectLAN(host: host, port: UInt16(port))
            return
        }

        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)

        ionLog.info("connect: device=\(device.name) relayURL=\(effectiveRelayURL) channelId=\(channelId.prefix(8))...")
        DiagnosticLog.log("CONNECT: relay \(device.name) url=\(effectiveRelayURL) ch=\(channelId.prefix(8))")

        guard !effectiveRelayURL.isEmpty,
              let url = URL(string: effectiveRelayURL) else {
            ionLog.error("connect: invalid or empty relay URL for device=\(device.name) apiKey=\(effectiveAPIKey), aborting")
            return
        }

        // Restore cached layout before transport connects so the UI
        // shows the last-known tab/group layout immediately.
        restoreCachedLayout(for: device.id)

        let tm = TransportManager(
            relayURL: url,
            apiKey: effectiveAPIKey,
            channelId: channelId,
            sharedKey: sharedKey,
            apnsToken: apnsToken
        )
        tm.deviceId = device.id
        tm.deviceName = device.name
        self.transport = tm
        connectionState = .connecting

        Task { await tm.start() }
        startListening()
    }

    /// Connect directly to an Ion LAN server (no relay).
    func connectLAN(host: String, port: UInt16) {
        tearDownTransport()

        guard let device = activeDevice else { return }

        ionLog.info("connectLAN: device=\(device.name) host=\(host):\(port)")
        DiagnosticLog.log("LAN-CONNECT: \(device.name) \(host):\(port) id=\(device.id.prefix(8))")

        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let tm = TransportManager(sharedKey: sharedKey, deviceId: device.id)
        tm.deviceName = device.name
        self.transport = tm
        connectionState = .connecting

        Task {
            let authed = await tm.startLANWithAuth(host: host, port: port)
            if authed {
                ionLog.info("connectLAN: auth succeeded for \(device.name)")
                DiagnosticLog.log("LAN-CONNECT: auth OK \(device.name)")
                await MainActor.run {
                    self.connectionState = .connected
                    self.send(.sync)
                }
            } else {
                ionLog.error("connectLAN: auth FAILED for \(device.name)")
                DiagnosticLog.log("LAN-CONNECT: auth FAILED \(device.name)")
                await MainActor.run {
                    self.connectionState = .authFailed
                    self.transport?.stop()
                    self.transport = nil
                }
            }
        }
        startListening()
    }

    // MARK: - Reconnect Strategies

    /// Soft reconnect: tears down and rebuilds the transport without wiping
    /// transient state. Used for transient disconnects and app resume.
    func softReconnect() {
        tearDownTransport()
        guard let device = activeDevice else { return }

        let effectiveRelayURL = device.relayURL ?? relayURL
        let effectiveAPIKey = device.relayAPIKey ?? relayAPIKey

        ionLog.info("softReconnect: device=\(device.name) apiKey=\(effectiveAPIKey) relayURL=\(effectiveRelayURL)")
        DiagnosticLog.log("SOFT-RECONN: \(device.name) key=\(effectiveAPIKey.prefix(8)) url=\(effectiveRelayURL)")

        // LAN-only device: reconnect directly without a relay.
        if effectiveAPIKey == "lan-direct",
           let url = URL(string: effectiveRelayURL),
           let host = url.host(percentEncoded: false),
           let port = url.port {
            connectionState = .reconnecting
            connectLAN(host: host, port: UInt16(port))
            startReconnectSafetyTimer()
            return
        }

        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)

        guard !effectiveRelayURL.isEmpty,
              let url = URL(string: effectiveRelayURL) else { return }

        connectionState = .reconnecting
        DiagnosticLog.log("SOFT-RECONN: relay path \(effectiveRelayURL)")

        let tm = TransportManager(
            relayURL: url,
            apiKey: effectiveAPIKey,
            channelId: channelId,
            sharedKey: sharedKey,
            apnsToken: apnsToken
        )
        tm.deviceId = device.id
        tm.deviceName = device.name
        self.transport = tm
        Task { await tm.start() }
        startListening()
        startReconnectSafetyTimer()
    }

    /// Hard reconnect: full disconnect + state wipe + reconnect.
    /// Used only for explicit user actions (switch desktop, unpair).
    func reconnect() {
        disconnect()
        connect()
    }

    // MARK: - Suspend/Resume (background/foreground)

    /// Stop the transport without wiping state. Called when the app backgrounds.
    func suspendTransport() {
        DiagnosticLog.log("SUSPEND: tearing down transport")
        tearDownTransport()
        // Keep connectionState as-is (not .disconnected) so the view
        // hierarchy stays intact and doesn't flash the pairing screen.
    }

    /// Rebuild the transport after suspend. Called when the app foregrounds.
    func resumeTransport() {
        guard !pairedDevices.isEmpty else { return }
        DiagnosticLog.log("RESUME: transport=\(transport == nil ? "nil" : "exists")")
        if transport == nil {
            softReconnect()
        }
    }

    // MARK: - Multi-Desktop Switching

    /// Switch to a different paired desktop.
    func switchToDevice(id: String) {
        guard id != activeDevice?.id else { return }
        let fromName = activeDevice?.name ?? "nil"
        let toName = pairedDevices.first(where: { $0.id == id })?.name ?? "unknown"
        ionLog.info("switchToDevice: \(id)")
        DiagnosticLog.log("USER: switch-device from=\(fromName) to=\(toName) id=\(id.prefix(8))")
        disconnect()
        activeDeviceId = id
        restoreCachedLayout(for: id)
        connect()
    }

    /// Connect with fallback: try the active device, then fall back to others.
    func connectWithFallback() {
        guard !pairedDevices.isEmpty else { return }
        restoreCachedLayout(for: activeDevice?.id)
        connect()
        // If the connection doesn't succeed within 10s, try the next device.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, self.connectionState != .connected else { return }
            // Try other devices in order
            let activeId = self.activeDevice?.id
            for device in self.pairedDevices where device.id != activeId {
                self.switchToDevice(id: device.id)
                try? await Task.sleep(for: .seconds(10))
                if self.connectionState == .connected { return }
            }
        }
    }

    // MARK: - Disconnect

    /// Disconnect from the current transport and wipe all transient state.
    func disconnect() {
        DiagnosticLog.log("DISCONNECT: tearing down")
        reconnectSafetyTask?.cancel()
        reconnectSafetyTask = nil
        tearDownTransport()
        wipeTransientState()
    }

    /// Tear down transport and event tasks without wiping state.
    private func tearDownTransport() {
        eventTask?.cancel()
        eventTask = nil
        flushTask?.cancel()
        flushTask = nil
        transport?.stop()
        transport = nil
    }

    // MARK: - Reconnect Safety Timer

    /// Start a safety timer that forces a soft reconnect if the app stays
    /// in `.reconnecting` for too long (e.g. the relay can't reach the peer).
    func startReconnectSafetyTimer() {
        reconnectSafetyTask?.cancel()
        reconnectSafetyTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled, let self else { return }
            if self.connectionState == .reconnecting {
                self.softReconnect()
            }
        }
    }

    /// Cancel the reconnect safety timer (called when we reach `.connected`).
    func cancelReconnectSafetyTimer() {
        reconnectSafetyTask?.cancel()
        reconnectSafetyTask = nil
    }

    // MARK: - State Wipe

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
        // Clear the cached per-desktop projection so a transport swap
        // doesn't briefly render the previous desktop's settings while
        // the new pairing's initial snapshot is in flight.
        desktopSettings = nil
        pendingCloseTabIds = []
        pendingInputByTab = [:]
        awaitingLocalTabCreation = false
        activeTools = [:]
        tabGroupMode = "auto"
        tabGroups = []
        connectionQuality.reset()
        connectionQuality.transportState = .disconnected
    }

    // MARK: - Layout Cache

    /// Restore cached layout for a device so the UI shows last-known state.
    func restoreCachedLayout(for deviceId: String?) {
        guard let deviceId, let cached = LayoutCache.load(deviceId: deviceId) else { return }
        tabs = cached.tabs
        tabIds = Set(cached.tabs.map(\.id))
        tabGroupMode = cached.tabGroupMode
        tabGroups = cached.tabGroups
        if !cached.recentDirectories.isEmpty {
            recentDirectories = cached.recentDirectories
        }
    }

    // MARK: - Device Management

    func unpairDevice(_ device: PairedDevice) {
        let isActive = device.id == activeDevice?.id
        // Only send unpair to the desktop if this device is the active connection.
        if isActive {
            Task { try? await transport?.send(.unpair) }
        }
        pairedDevices.removeAll { $0.id == device.id }
        savePairedDevices()
        LayoutCache.delete(deviceId: device.id)
        deviceOnlineStatus.removeValue(forKey: device.id)

        if pairedDevices.isEmpty {
            activeDeviceId = nil
            disconnect()
        } else if isActive {
            // Auto-switch to the next device.
            let nextId = pairedDevices.first!.id
            switchToDevice(id: nextId)
        }
    }

    /// Push a customization (name / icon override) to the given desktop.
    ///
    /// - For the **active** desktop: reuse the existing live transport and
    ///   `send(.setRemoteDisplay(...))`. The desktop's broadcast comes back
    ///   on the same transport and is reconciled by `handleRemoteDisplay`.
    /// - For an **inactive** desktop: open a transient sidecar transport via
    ///   `OneShotDisplayCommand.send`, await the ack, then tear it down.
    ///   The active session is untouched. If the inactive desktop is
    ///   unreachable the call throws and the caller (the customization
    ///   sheet) reverts the optimistic local update.
    ///
    /// Both paths optimistically write the new values into `pairedDevices`
    /// before sending so the UI updates immediately; LWW reconciliation
    /// happens automatically when the server ack arrives.
    @MainActor
    func updateRemoteDisplay(device: PairedDevice, customName: String?, customIcon: String?) async throws {
        let updatedAt = Date()
        let updatedAtMs = Int(updatedAt.timeIntervalSince1970 * 1000)
        let isActive = device.id == activeDevice?.id
        DiagnosticLog.log("DISPLAY-SEND: device=\(device.id.prefix(8)) active=\(isActive) name=\(customName == nil ? "cleared" : "set") icon=\(customIcon ?? "cleared") ts=\(updatedAtMs)")

        // Optimistic local write — gives the UI an instant response while
        // the round-trip is in flight. Reconciliation overrides this on ack
        // if the desktop applies LWW differently.
        let prevName: String?
        let prevIcon: String?
        let prevTs: Date?
        if let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            prevName = pairedDevices[idx].customName
            prevIcon = pairedDevices[idx].customIcon
            prevTs = pairedDevices[idx].remoteDisplayUpdatedAt
            pairedDevices[idx].customName = customName
            pairedDevices[idx].customIcon = customIcon
            pairedDevices[idx].remoteDisplayUpdatedAt = updatedAt
            savePairedDevices()
        } else {
            prevName = nil
            prevIcon = nil
            prevTs = nil
            DiagnosticLog.log("DISPLAY-SEND: device=\(device.id.prefix(8)) not in pairedDevices — skipping optimistic write")
        }

        do {
            if isActive, let transport {
                DiagnosticLog.log("DISPLAY-SEND: using active transport")
                try await transport.send(.setRemoteDisplay(customName: customName, customIcon: customIcon, updatedAt: updatedAt))
                // Active transport: the desktop broadcasts back on this same
                // pipe, picked up by handleRemoteDisplay via the snapshot/
                // .remoteDisplay routing in EventHandlers.swift. Nothing
                // more to do here.
                return
            }

            DiagnosticLog.log("DISPLAY-SEND: using one-shot transport (inactive device)")
            let ack = try await OneShotDisplayCommand.send(
                device: device,
                customName: customName,
                customIcon: customIcon,
                updatedAt: updatedAt,
            )
            // Reconcile by applying the server's authoritative value.
            await MainActor.run {
                self.handleRemoteDisplay(
                    deviceId: device.id,
                    customName: ack.customName,
                    customIcon: ack.customIcon,
                    updatedAt: ack.updatedAt,
                )
            }
        } catch {
            // Rollback optimistic write on failure.
            DiagnosticLog.log("DISPLAY-SEND: failed device=\(device.id.prefix(8)) err=\(error.localizedDescription) — rolling back")
            if let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
                pairedDevices[idx].customName = prevName
                pairedDevices[idx].customIcon = prevIcon
                pairedDevices[idx].remoteDisplayUpdatedAt = prevTs
                savePairedDevices()
            }
            throw error
        }
    }

    func resetAll() {
        Task {
            try? await transport?.send(.unpair)
            await MainActor.run {
                self.disconnect()
                self.pairedDevices = []
                self.activeDeviceId = nil
                self.hasConnectedBefore = false
                UserDefaults.standard.set(false, forKey: "hasConnectedBefore")
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
                self.deviceOnlineStatus = [:]
                try? KeychainStore.deleteAll()
                LayoutCache.deleteAll()
            }
        }
    }

    func saveRelayConfig() {
        guard let device = activeDevice,
              let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) else { return }
        pairedDevices[idx].relayURL = relayURL
        pairedDevices[idx].relayAPIKey = relayAPIKey
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
