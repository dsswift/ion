import Foundation
import CryptoKit

// MARK: - Lifecycle

extension SessionViewModel {

    /// Connect to the active paired device over the Studio wire.
    func connect() {
        tearDownTransport()

        guard let device = activeDevice else {
            DiagnosticLog.log("CONNECT: no paired devices")
            return
        }
        connectOverStudioWire(device: device, state: .connecting)
    }

    // MARK: - Reconnect Strategies

    /// Soft reconnect: tears down and rebuilds the transport without wiping
    /// transient state. Used for transient disconnects and app resume.
    func softReconnect() {
        tearDownTransport()
        guard let device = activeDevice else { return }
        connectOverStudioWire(device: device, state: .reconnecting)
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
            transport?.revalidateAfterResume()
            send(.sync, intent: .automaticEssential)
        }
    }

    // MARK: - Multi-Desktop Switching

    /// Switch to a different paired desktop.
    func switchToDevice(id: String) {
        // The load shown belongs to the Environment being left.
        clearEnvironmentLoad()
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
        // in-memory pair still holds the PREVIOUS server's values and the
        // new pairing would dial the old one's relay.
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
            // Only CancellationError can surface; the guard below re-checks connectionState before failing over.
            // swiftlint:disable:next silent_try_optional
            try? await Task.sleep(for: .seconds(10))
            guard let self, self.connectionState != .connected else { return }
            // Try other devices in order
            let activeId = self.activeDevice?.id
            for device in self.pairedDevices where device.id != activeId {
                self.switchToDevice(id: device.id)
                // Only CancellationError can surface; the connectionState check below decides whether to keep failing over.
                // swiftlint:disable:next silent_try_optional
                try? await Task.sleep(for: .seconds(10))
                if self.connectionState == .connected { return }
            }
        }
    }

    // MARK: - Disconnect

    /// Disconnect from the current transport and wipe all transient state.
    func disconnect() {
        DiagnosticLog.log("tearing down", tag: "session", level: .info)
        // Clear the session/conversation correlation IDs — we are leaving
        // that context. Omitted-when-nil per schema. The pairing stamp is not
        // cleared here: it follows the selected pairing (`activeDeviceId`), and
        // a reset that unselects the pairing clears it there.
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
        cancelPendingBenchConversation(reason: "session disconnect")
        Task { @MainActor [weak self] in
            self?.cancelTranscriptCopy()
        }
        tearDownTransport()
        wipeTransientState()
    }

    /// Tear down transport and event tasks without wiping state.
    func tearDownTransport() {
        eventTask?.cancel()
        eventTask = nil
        flushTask?.cancel()
        flushTask = nil
        transport?.stop()
        transport = nil
        // The next connection is a new listener for the voice configuration.
        lastSentVoiceConfig = nil
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
            while !Task.isCancelled {
                // Only CancellationError can surface; the guard below re-checks cancellation.
                // swiftlint:disable:next silent_try_optional
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled, let self else { return }
                if self.connectionState == .reconnecting || self.connectionState == .disconnected {
                    self.softReconnect()
                }
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
        cancelPendingBenchConversation(reason: "transient state reset")
        connectionState = .disconnected
        tabs = []
        tabIds = []
        transcriptStreams = [:]
        transcriptResyncing = []
        transcriptOlderInFlight = []
        pendingPrompts = [:]
        agentConversationMessages = [:]
        agentConversationLoading = []
        dispatchStreams = [:]
        dispatchResyncing = []
        dispatchTabs = [:]
        agentConversationGroups = [:]
        loadingConversation = []
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
        serverSettings = nil
        enterpriseNewConversationPolicy = nil
        pendingCloseTabIds = []
        // Hard reset only (switch desktop / unpair): drop in-flight creates so a
        // stale create never spawns a tab against a different pairing. Survives
        // soft reconnect because that path never calls wipeTransientState.
        clearPendingCreates()
        activeTools = [:]
        // RC-19/RC-28: special-card dismissal sets are per-pairing; a switch/unpair
        // must not carry a prior desktop's dismissals into the new pairing.
        dismissedLiveSpecialTabs = []
        dismissedRestoredCards = []
        // Snapshot-confirmation is per-pairing: a switch/unpair must not carry a
        // prior desktop's confirmed card ids into the new pairing's snapshots.
        snapshotConfirmedSpecialIds = []
        connectionQuality.reset()
        connectionQuality.transportState = .disconnected
        connectionHealth.reset()
        // Wipe resource store so stale items from the old desktop don't
        // bleed into the new pairing. Persistence files are deleted so the
        // next launch also starts clean for this device.
        resourceStore.wipe()
        // Guided Questions are pairing-scoped: a different desktop owns a
        // different coordinator, so its workflows must not survive here.
        questionsStore.clearAll()
        // Worktrees, benches, and settled history are the previous server's.
        // A snapshot replaces them only when it carries them, and the
        // refreshes that follow merge by repository, so nothing else would
        // ever remove the old server's projects.
        resetWorktreeUI()
        // Recent directories are too. The next pairing's cached layout
        // restores its own right after this wipe.
        recentDirectories = []
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
        // How old the cache is, not how long the restore took: a number a
        // dashboard reads as the staleness of what the person first sees.
        let ageSeconds = Date().timeIntervalSince(cached.cachedAt).rounded(.down)
        DiagnosticLog.log("restore cached layout hit", tag: "session.cache", fields: [
            "device": String(deviceId.prefix(8)),
            "count": String(cached.tabs.count)
        ], numbers: ["age_s": ageSeconds])
        tabs = cached.tabs
        tabIds = Set(cached.tabs.map(\.id))
        if !cached.recentDirectories.isEmpty {
            recentDirectories = cached.recentDirectories
        }
        connectionHealth.recordCacheRestore(cachedAt: cached.cachedAt)
    }

}
