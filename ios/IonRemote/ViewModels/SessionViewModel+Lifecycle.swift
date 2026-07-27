import Foundation
import CryptoKit

// MARK: - Lifecycle

extension SessionViewModel {

    /// Connect to the active paired device using its relay configuration.
    /// Falls back to LAN-only mode when no real relay is configured.
    func connect() {
        tearDownTransport()

        guard let device = activeDevice else {
            DiagnosticLog.log("CONNECT: no paired devices")
            return
        }

        // Initialize OIDC token manager from stored device fields before the
        // first connection attempt. Without this, the manager is nil until
        // desktop pushes a fresh relay_config — which requires a successful
        // connection first (chicken-and-egg on restart with a stale token).
        ensureOIDCTokenManager(for: device)

        let effectiveRelayURL = device.relayURL ?? relayURL
        let effectiveAPIKey = device.relayAPIKey ?? relayAPIKey

        // When the device was paired over LAN without a relay, the stored
        // relay URL is actually the LAN address (ws://host:port) with
        // apiKey "lan-direct". Use LAN-only mode in that case.
        if effectiveAPIKey == "lan-direct",
           let url = URL(string: effectiveRelayURL),
           let host = url.host(percentEncoded: false),
           let port = url.port {
            DiagnosticLog.log("connect lan-direct", tag: "session.lifecycle", fields: [
                "reason": device.name,
                "path": "\(host):\(port)",
                "device": String(device.id.prefix(8))
            ])
            restoreCachedLayout(for: device.id)
            connectLAN(host: host, port: UInt16(port))
            return
        }

        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)

        DiagnosticLog.log("connect relay", tag: "session.lifecycle", fields: [
            "reason": device.name,
            "path": effectiveRelayURL,
            "count": String(channelId.prefix(8))
        ])

        guard let url = usableRelayURL(effectiveRelayURL) else {
            fallBackToLANOnly(device: device, reason: effectiveRelayURL.isEmpty
                              ? "connect: no relay URL configured"
                              : "connect: relay URL is unusable")
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
            apnsToken: apnsToken,
            getCredential: oidcTokenManager != nil ? { [weak self] in
                guard let manager = self?.oidcTokenManager else {
                    throw OIDCTokenError.managerUnavailable
                }
                return try await manager.accessToken()
            } : nil,
            onTokenRejected: oidcTokenManager != nil ? { [weak self] in
                guard let manager = self?.oidcTokenManager else { return }
                Task { await manager.invalidateAccessToken() }
            } : nil
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

        DiagnosticLog.log("lan connect", tag: "session.lifecycle", fields: [
            "reason": device.name,
            "path": "\(host):\(port)",
            "device": String(device.id.prefix(8))
        ])

        // Restore the cached layout, exactly as both connect() paths do. This
        // path needs it most: the relay is unusable and the user is waiting on
        // a Bonjour discovery tick, so without the cache a cold start renders
        // an empty tab list — the readiness failure the view-readiness
        // principle forbids, on the one path least able to recover quickly.
        restoreCachedLayout(for: device.id)

        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let tm = TransportManager(sharedKey: sharedKey, deviceId: device.id)
        tm.deviceName = device.name
        self.transport = tm
        connectionState = .connecting

        Task {
            var outcome = await tm.startLANWithAuth(host: host, port: port)

            // Transient failures (socket error, auth-cooldown close 1008,
            // timeout, stream ended without a verdict) get bounded in-place
            // retries before handing off to the reconnect machinery. A
            // definitive rejection (auth_result success=false, close 4000-4999)
            // never retries — the desktop refused this identity.
            var attempt = 0
            while outcome == .transient, attempt < self.lanAuthRetryDelays.count {
                let delay = self.lanAuthRetryDelays[attempt]
                attempt += 1
                DiagnosticLog.log("lan connect transient failure, retrying", tag: "session.lifecycle", level: .warn, fields: [
                    "reason": device.name,
                    "count": String(attempt),
                    "max": String(self.lanAuthRetryDelays.count)
                ])
                try? await Task.sleep(for: delay)
                // Bail if this connect attempt was superseded (user switched
                // desktop, softReconnect built a new transport, teardown).
                let stillCurrent = await MainActor.run { self.transport === tm }
                guard !Task.isCancelled, stillCurrent else { return }
                outcome = await tm.startLANWithAuth(host: host, port: port)
            }

            switch outcome {
            case .success:
                DiagnosticLog.log("lan connect auth ok", tag: "session.lifecycle", fields: [
                    "reason": device.name
                ])
                await MainActor.run {
                    self.connectionState = .connected
                    self.send(.sync, intent: .automaticEssential)
                }
            case .rejected:
                DiagnosticLog.log("lan connect auth rejected", tag: "session.lifecycle", level: .warn, fields: [
                    "reason": device.name
                ])
                await MainActor.run {
                    self.connectionState = .authFailed
                    self.transport?.stop()
                    self.transport = nil
                }
            case .transient:
                // NOT .authFailed: the desktop never rejected this identity —
                // the socket dropped without a verdict (auth cooldown, network
                // blip, desktop restarting). Surfacing .authFailed here would
                // bounce the user to the pairing screen over a valid pairing.
                // Tear down and let the reconnect machinery (safety timer +
                // disconnected-view auto-retry) keep trying.
                DiagnosticLog.log("lan connect transient, deferring to reconnect", tag: "session.lifecycle", level: .warn, fields: [
                    "reason": device.name,
                    "count": String(attempt)
                ])
                await MainActor.run {
                    self.transport?.stop()
                    self.transport = nil
                    self.connectionState = .disconnected
                    self.startReconnectSafetyTimer()
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

        // Same startup-initialization guard as connect(): ensure the OIDC token
        // manager exists from stored device fields before rebuilding transport.
        ensureOIDCTokenManager(for: device)

        let effectiveRelayURL = device.relayURL ?? relayURL
        let effectiveAPIKey = device.relayAPIKey ?? relayAPIKey

        DiagnosticLog.log("soft reconnect", tag: "session.lifecycle", fields: [
            "reason": device.name,
            "count": String(effectiveAPIKey.prefix(8)),
            "path": effectiveRelayURL
        ])

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

        guard let url = usableRelayURL(effectiveRelayURL) else {
            fallBackToLANOnly(device: device, reason: effectiveRelayURL.isEmpty
                              ? "softReconnect: no relay URL configured"
                              : "softReconnect: relay URL is unusable")
            return
        }

        connectionState = .reconnecting
        DiagnosticLog.log("soft reconnect relay path", tag: "session.lifecycle", fields: [
            "path": effectiveRelayURL
        ])

        let tm = TransportManager(
            relayURL: url,
            apiKey: effectiveAPIKey,
            channelId: channelId,
            sharedKey: sharedKey,
            apnsToken: apnsToken,
            getCredential: oidcTokenManager != nil ? { [weak self] in
                guard let manager = self?.oidcTokenManager else {
                    throw OIDCTokenError.managerUnavailable
                }
                return try await manager.accessToken()
            } : nil,
            onTokenRejected: oidcTokenManager != nil ? { [weak self] in
                guard let manager = self?.oidcTokenManager else { return }
                Task { await manager.invalidateAccessToken() }
            } : nil
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

    // MARK: - LAN-only Fallback

    /// Parse a stored relay URL into one that can actually be connected to,
    /// or nil when it cannot.
    ///
    /// A bare `URL(string:)` check is NOT sufficient. Modern Foundation
    /// percent-encodes rather than rejecting, so `URL(string: "not a url")`
    /// succeeds and yields a host-less URL. `RelayClient.doConnect` builds its
    /// endpoint from `relayURL.host(percentEncoded:)`, so a host-less URL
    /// produces an unconnectable endpoint and every attempt fails at the
    /// socket. Requiring a host is what makes the guard mean "usable".
    func usableRelayURL(_ raw: String) -> URL? {
        guard !raw.isEmpty,
              let url = URL(string: raw),
              let host = url.host(percentEncoded: false),
              !host.isEmpty else {
            return nil
        }
        return url
    }

    /// Build a relay-less transport when the relay cannot be used.
    ///
    /// Both `connect()` and `softReconnect()` reach a point where the stored
    /// relay URL is empty or unparseable. Previously each simply returned —
    /// and because `tearDownTransport()` had already run while
    /// `connectionState` still read `.connected`, that left the app in a state
    /// nothing could recover from: `transport == nil` so every command was
    /// deferred forever, and `ContentView`'s auto-retry only fires on
    /// `.disconnected` / `.connecting`, so it never engaged. The user saw a
    /// normal-looking UI that silently accepted input and did nothing.
    ///
    /// A missing relay URL is not a reason to have no transport at all. The
    /// LAN path is fully independent of the relay: `TransportManager`'s
    /// relay-less initializer plus `start()` brings up Bonjour browsing, the
    /// auto-reconnect observation loop, LAN state observation, and the network
    /// monitor. On the user's own network that reconnects on its own within a
    /// discovery tick, and the desktop pushes a fresh `relay_config` on peer
    /// connect, which repairs the stored relay config for next time.
    ///
    /// `connectionState` is set to `.disconnected` (not left stale) so the
    /// disconnected view's 5-second auto-retry re-arms as a second recovery
    /// path when LAN is unavailable too.
    func fallBackToLANOnly(device: PairedDevice, reason: String) {
        DiagnosticLog.log("relay unavailable, falling back to LAN-only transport", tag: "session.lifecycle", level: .warn, fields: [
            "reason": reason,
            "device": String(device.id.prefix(8)),
            "status": device.name
        ])

        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let tm = TransportManager(sharedKey: sharedKey, deviceId: device.id)
        tm.deviceName = device.name
        self.transport = tm
        // NOT .connecting: there is no relay handshake to await, and a
        // lingering .connecting state suppresses the disconnected view's
        // auto-retry. Bonjour flips this to .lanPreferred on a successful LAN
        // auth; until then the app is honestly disconnected.
        connectionState = .disconnected

        Task { await tm.start() }
        startListening()
        startReconnectSafetyTimer()
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
        DiagnosticLog.log("resume transport", tag: "session.lifecycle", fields: [
            "status": transport == nil ? "nil" : "exists"
        ])
        if transport == nil {
            softReconnect()
        } else {
            // Transport survived backgrounding. Two things can be stale:
            // (1) the LAN socket may be a zombie (wedged during suspension while
            //     still reading connected) — revalidate it so sends don't vanish
            //     into a dead socket; and (2) a delta may have been missed, so
            //     proactively resync to reconcile state.
            DiagnosticLog.log("RESUME: transport alive, revalidating LAN + proactive sync")
            transport?.revalidateLANAfterResume()
            send(.sync, intent: .automaticEssential)
        }
    }

    // MARK: - Multi-Desktop Switching

    /// Switch to a different paired desktop.
    func switchToDevice(id: String) {
        guard id != activeDevice?.id else { return }
        let fromName = activeDevice?.name ?? "nil"
        let toName = pairedDevices.first(where: { $0.id == id })?.name ?? "unknown"
        DiagnosticLog.log("switch device", tag: "session.lifecycle", fields: [
            "reason": fromName,
            "status": toName,
            "device": String(id.prefix(8))
        ])
        disconnect()
        activeDeviceId = id
        // relayURL / relayAPIKey are per-device. Without re-hydrating, the
        // in-memory pair still holds the PREVIOUS desktop's values and
        // handleRelayConfig would fall back onto them for the new pairing.
        hydrateRelayConfig()
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
        DiagnosticLog.log("tearing down", tag: "session", level: .info)
        // Clear correlation IDs — we are leaving the current pairing's
        // session/conversation context. Omitted-when-nil per schema.
        DiagnosticLog.setSessionId(nil)
        DiagnosticLog.setConversationId(nil)
        reconnectSafetyTask?.cancel()
        reconnectSafetyTask = nil
        // Clear any commands deferred via `runWhenConnected` — a hard
        // reset means the user is intentionally walking away from the
        // current pairing's state (switch desktop, unpair), so resume
        // commands waiting for the previous transport must not fire
        // against the next one.
        clearPendingOnConnected()
        clearPendingEssential()
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
    /// in `.reconnecting` (relay can't reach the peer) or `.disconnected`
    /// (a transient LAN auth failure exhausted its in-place retries and
    /// handed off here) for too long. Cancelled on `.connected` and by
    /// `disconnect()`, so it never fires against a healthy or intentionally
    /// torn-down session.
    func startReconnectSafetyTimer() {
        reconnectSafetyTask?.cancel()
        reconnectSafetyTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled, let self else { return }
            if self.connectionState == .reconnecting || self.connectionState == .disconnected {
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
        engineDialogs = [:]
        enginePinnedPrompt = [:]
        conversationInstances = [:]
        activeEngineInstance = [:]
        engineProfiles = []
        // Clear the cached per-desktop projection so a transport swap
        // doesn't briefly render the previous desktop's settings while
        // the new pairing's initial snapshot is in flight.
        desktopSettings = nil
        enterpriseNewConversationPolicy = nil
        pendingCloseTabIds = []
        pendingInputByTab = [:]
        // Hard reset only (switch desktop / unpair): drop in-flight creates so a
        // stale create never spawns a tab against a different pairing. Survives
        // soft reconnect because that path never calls wipeTransientState.
        clearPendingCreates()
        activeTools = [:]
        // RC-19/RC-28: special-card dismissal sets are per-pairing; a switch/unpair
        // must not carry a prior desktop's dismissals into the new pairing.
        dismissedLiveSpecialTabs = []
        dismissedRestoredCards = []
        tabGroupMode = "auto"
        tabGroups = []
        connectionQuality.reset()
        connectionQuality.transportState = .disconnected
        // Wipe resource store so stale items from the old desktop don't
        // bleed into the new pairing. Persistence files are deleted so the
        // next launch also starts clean for this device.
        resourceStore.wipe()
    }

    // MARK: - Layout Cache

    /// Restore cached layout for a device so the UI shows last-known state.
    func restoreCachedLayout(for deviceId: String?) {
        guard let deviceId else {
            DiagnosticLog.log("CACHE: restoreCachedLayout skipped — no deviceId")
            return
        }
        guard let cached = LayoutCache.load(deviceId: deviceId) else {
            DiagnosticLog.log("restore cached layout miss", tag: "session.cache", fields: [
                "device": String(deviceId.prefix(8))
            ])
            return
        }
        let ageSeconds = Int(Date().timeIntervalSince(cached.cachedAt))
        DiagnosticLog.log("restore cached layout hit", tag: "session.cache", fields: [
            "device": String(deviceId.prefix(8)),
            "count": String(cached.tabs.count),
            "max": String(cached.tabGroups.count),
            "status": cached.tabGroupMode,
            "duration_ms": String(ageSeconds)
        ])
        tabs = cached.tabs
        tabIds = Set(cached.tabs.map(\.id))
        tabGroupMode = cached.tabGroupMode
        tabGroups = cached.tabGroups
        if !cached.recentDirectories.isEmpty {
            recentDirectories = cached.recentDirectories
        }
    }

}
