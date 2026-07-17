import Foundation

// MARK: - Bonjour observation + LAN auto-reconnect policy

// Extracted from TransportManager.swift (allowlisted "don't extend; extract")
// when the auto-reconnect loop gained definitive-rejection handling and
// escalating backoff. The loop itself is untestable (real Bonjour, real
// sockets), so the policy transitions live in the `applyLANAuthOutcome` /
// `shouldAttemptLANConnect` seam, which unit tests drive directly.

extension TransportManager {

    /// Whether the auto-reconnect loop may attempt a LAN connect right now.
    ///
    /// `false` while a definitive identity rejection stands (the desktop does
    /// not know this device — retrying the same dead pairing can never
    /// succeed), or while the escalating backoff window from the last failed
    /// attempt is still open.
    func shouldAttemptLANConnect(now: Date = Date()) -> Bool {
        !lanAuthRejectedDefinitively && now >= nextLANAttemptAllowedAt
    }

    /// Apply the outcome of an auto-reconnect LAN auth attempt to the
    /// reconnect policy state.
    ///
    /// - `.success` clears the backoff ladder so the next disconnect starts
    ///   fresh at the shortest delay.
    /// - `.rejected` is a definitive identity refusal (explicit `auth_result
    ///   success=false`, or an application close 4000–4999 such as 4003
    ///   "unknown device"): stop the loop's connect attempts permanently for
    ///   this transport and yield `.lanAuthRejected` so the ViewModel routes
    ///   the user to the pairing screen. A desktop that doesn't know the
    ///   identity rejects it on every transport, so there is nothing for the
    ///   reconnect machinery to recover.
    /// - `.transient` (auth cooldown 1008, socket error, timeout, verdict-less
    ///   stream end) keeps retrying, but through the escalating backoff so the
    ///   ~500ms observation tick no longer hammers the desktop — pre-backoff,
    ///   that hammering repeatedly re-tripped the desktop's auth-failure
    ///   cooldown and the connection never recovered.
    func applyLANAuthOutcome(_ outcome: LANAuthOutcome, host: String, port: UInt16) {
        switch outcome {
        case .success:
            lanReconnectBackoff.reset()
            nextLANAttemptAllowedAt = .distantPast

        case .rejected:
            currentLANHost = nil
            lanAuthRejectedDefinitively = true
            DiagnosticLog.log("lan auth definitively rejected, stopping auto-reconnect", tag: "transport.auth", level: .warn, fields: [
                "host": host,
                "port": String(port),
                "device_id": deviceId.map { String($0.prefix(8)) } ?? "nil"
            ])
            eventContinuation.yield(.lanAuthRejected)

        case .transient:
            currentLANHost = nil
            let delay = lanReconnectBackoff.recordFailure()
            nextLANAttemptAllowedAt = Date().addingTimeInterval(delay)
            DiagnosticLog.log("lan auth transient failure, backing off", tag: "transport.auth", level: .warn, fields: [
                "host": host,
                "port": String(port),
                "count": String(lanReconnectBackoff.consecutiveFailures),
                "delay_s": String(Int(delay))
            ])
        }
    }

    // MARK: - Bonjour observation loop

    func startBonjourObservation() {
        bonjourObservationTask?.cancel()
        bonjourObservationTask = Task { [weak self] in
            var lastKnownCount = 0
            /// Tracks whether we've already restarted the browser after a
            /// disconnect. Reset once we reconnect so future disconnects also
            /// trigger a restart.
            var didRestartBrowser = false
            while !Task.isCancelled {
                guard let self else { break }

                let hosts = await MainActor.run { self.bonjour.discoveredHosts }
                let countChanged = hosts.count != lastKnownCount
                if countChanged {
                    lastKnownCount = hosts.count
                }

                // Detect LAN socket disconnect even if Bonjour hasn't noticed yet.
                if self.currentLANHost != nil, !self.lan.isConnected {
                    DiagnosticLog.log("BONJOUR: LAN socket lost, clearing host")
                    self.currentLANHost = nil
                    self.lanListenTask?.cancel()
                    self.lanListenTask = nil
                    self.updateState()
                }

                // A definitive identity rejection stops all further connect
                // attempts on this transport: see applyLANAuthOutcome.
                let needsConnect = self.currentLANHost == nil
                    && !self.lan.isConnected
                    && !self.lanAuthRejectedDefinitively
                if needsConnect { DiagnosticLog.log("BONJOUR: needsConnect=true") }

                // When disconnected with no hosts visible, restart the Bonjour
                // browser once to force NWBrowser to re-discover services.
                // NWBrowser can miss re-advertisements of a service with the
                // same name after the old one disappears.
                if needsConnect, self.matchingLANHost(hosts) == nil, !didRestartBrowser {
                    didRestartBrowser = true
                    lastKnownCount = 0
                    await MainActor.run { self.bonjour.startBrowsing() }
                }

                if countChanged || needsConnect {
                    if let host = self.matchingLANHost(hosts),
                       !self.lan.isConnected,
                       self.shouldAttemptLANConnect() {
                        DiagnosticLog.log("bonjour connecting to host", tag: "transport.bonjour", fields: [
                            "name": host.name,
                            "host": host.host,
                            "port": String(host.port)
                        ])
                        self.currentLANHost = host
                        let outcome = await self.startLANWithAuth(host: host.host, port: host.port)
                        self.applyLANAuthOutcome(outcome, host: host.host, port: host.port)
                        if outcome == .success {
                            didRestartBrowser = false
                            // Retryable handshake — a single failed sync used
                            // to leave the fresh LAN session snapshot-less.
                            // Detached so a slow handshake never blocks the
                            // Bonjour observation loop.
                            Task { [weak self] in
                                await self?.sendSyncWithRetry(reason: "bonjour-lan-auth")
                            }
                        }
                    } else if hosts.isEmpty, self.currentLANHost != nil {
                        // LAN host disappeared.
                        self.currentLANHost = nil
                        self.lan.disconnect()
                        self.lanListenTask?.cancel()
                        self.lanListenTask = nil
                        self.updateState()
                    }
                }

                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    /// Find the Bonjour host that matches the active paired device.
    /// When `deviceName` is set, only the host with a matching Bonjour service
    /// name is returned. This prevents connecting to the wrong desktop when
    /// multiple Ion instances are on the network.
    func matchingLANHost(_ hosts: [DiscoveredService]) -> DiscoveredService? {
        let ionHosts = hosts.filter { $0.kind == .ionDirect }
        if let name = deviceName {
            let match = ionHosts.first { $0.name == name }
            if match == nil && !ionHosts.isEmpty {
                DiagnosticLog.log("bonjour host filter no match", tag: "transport.bonjour", fields: [
                    "filter": name,
                    "available": String(describing: ionHosts.map(\.name))
                ])
            }
            return match
        }
        // Fallback: no name filter (single desktop / legacy).
        return ionHosts.first
    }
}
