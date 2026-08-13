import Foundation

// MARK: - Transport lifecycle

extension TransportManager {

    /// Start all transports: relay connection, Bonjour discovery, and network monitoring.
    func start() async {
        guard !isStopped else {
            DiagnosticLog.log("transport start skipped after stop", tag: "transport", fields: [:])
            return
        }

        await MainActor.run { self.bonjour.startBrowsing() }
        startBonjourObservation()

        if let relay {
            DiagnosticLog.log("start: connecting relay", tag: "transport")
            await relay.connect()
            guard !isStopped else {
                DiagnosticLog.log("transport start abandoned after relay connect", tag: "transport", fields: [:])
                relay.disconnect()
                return
            }
            DiagnosticLog.log("start: relay connect returned", tag: "transport", fields: [
                "connected": String(relay.isConnected)
            ])
            startRelayListener()
            startRelayStateObservation()
        }
        guard !isStopped else {
            DiagnosticLog.log("transport start abandoned before observers", tag: "transport", fields: [:])
            return
        }
        startLANStateObservation()
        DiagnosticLog.log("start: starting network monitor", tag: "transport", fields: [
            "relay_connected": String(relay?.isConnected ?? false)
        ])
        startNetworkMonitor()
    }

    /// Disconnect all transports and stop discovery.
    func stop() {
        DiagnosticLog.log("transport stop starting", tag: "transport", fields: [
            "state": state.rawValue,
            "sync_active": String(syncHandshakeTask != nil)
        ])
        let syncTask = lifecycleLock.withLock { lifecycle -> Task<Void, Never>? in
            lifecycle.stopped = true
            lifecycle.syncGeneration &+= 1
            let task = lifecycle.syncTask
            lifecycle.syncTask = nil
            return task
        }
        syncTask?.cancel()
        relayListenTask?.cancel()
        relayListenTask = nil
        lanListenTask?.cancel()
        lanListenTask = nil
        bonjourObservationTask?.cancel()
        bonjourObservationTask = nil
        relayStateTask?.cancel()
        relayStateTask = nil
        lanStateTask?.cancel()
        lanStateTask = nil
        pathMonitor?.cancel()
        pathMonitor = nil
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
        resendCoalesceTask?.cancel()
        resendCoalesceTask = nil
        stopLANHeartbeatWatchdog()

        relay?.disconnect()
        lan.disconnect()
        bonjour.stopBrowsing()
        currentLANHost = nil
        setState(.disconnected)
        DiagnosticLog.log("transport stop completed", tag: "transport", fields: [:])
    }
}
