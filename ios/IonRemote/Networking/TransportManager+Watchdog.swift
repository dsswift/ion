import Foundation

// MARK: - LAN heartbeat watchdog

// Extracted from TransportManager.swift (allowlisted "don't extend; extract")
// when the watchdog gained re-arm + teardown behavior.

extension TransportManager {

    /// Start the LAN heartbeat liveness watchdog.
    ///
    /// The desktop emits a heartbeat every `HEARTBEAT_INTERVAL_MS` (15s). A
    /// healthy LAN connection therefore refreshes `lastHeartbeatAt` at least
    /// that often (the receive path updates it only for LAN-delivered
    /// heartbeats — a relay-delivered heartbeat proves the relay works, not
    /// the LAN socket). If two full intervals (`intervalSeconds`, default 30s)
    /// elapse with no LAN heartbeat while LAN is the active transport, the
    /// socket is silently dead — TCP can wedge without delivering a FIN, so
    /// the receive loop never ends and no disconnect is ever observed.
    ///
    /// Armed by `setState` the moment LAN becomes the active transport (so a
    /// LAN death before the first heartbeat is still detected) and re-armed by
    /// each LAN heartbeat as a backstop. Arming baselines `lastHeartbeatAt` to
    /// now so a stale timestamp from a previous LAN session cannot fire the
    /// watchdog instantly.
    ///
    /// On fire the watchdog nils its own task (so a later LAN connection can
    /// re-arm — the one-shot task previously left itself in place, permanently
    /// blocking every restart) and tears the dead LAN connection down via
    /// `handleLANWatchdogFire()` so relay takes over immediately.
    ///
    /// Idempotent: an already-running watchdog is left in place (its loop
    /// re-reads `lastHeartbeatAt`, so a fresh heartbeat effectively resets the
    /// timer without needing a restart). `intervalSeconds` is injectable so
    /// unit tests can drive the loop on a short cadence.
    func startLANHeartbeatWatchdog(intervalSeconds: Double = 30.0) {
        guard lanHeartbeatWatchdogTask == nil else { return }
        lastHeartbeatAt = Date()
        DiagnosticLog.log("lan heartbeat watchdog starting", tag: "transport", fields: [
            "interval_s": String(intervalSeconds)
        ])
        lanHeartbeatWatchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(intervalSeconds))
                guard !Task.isCancelled, let self else { return }
                let elapsed = Date().timeIntervalSince(self.lastHeartbeatAt)
                if elapsed > intervalSeconds {
                    DiagnosticLog.log("lan heartbeat starved, tearing down lan", tag: "transport", level: .warn, fields: [
                        "elapsed_s": String(Int(elapsed)),
                        "interval_s": String(intervalSeconds)
                    ])
                    // Nil the task BEFORE recovery so the teardown path (and
                    // any state transition it triggers) can re-arm a fresh
                    // watchdog for the next LAN connection.
                    self.lanHeartbeatWatchdogTask = nil
                    self.handleLANWatchdogFire()
                    return
                }
            }
        }
    }

    /// Stop the LAN heartbeat watchdog (called on stop(), on leaving
    /// `.lanPreferred`, and on teardown).
    func stopLANHeartbeatWatchdog() {
        lanHeartbeatWatchdogTask?.cancel()
        lanHeartbeatWatchdogTask = nil
    }

    /// Re-prove the LAN socket right after an app resume.
    ///
    /// A LAN connection that was `.lanPreferred` before the app suspended can
    /// come back a zombie: the OS froze the process, the TCP socket wedged
    /// without ever delivering a FIN, and `lan.isConnected` still reads true.
    /// Outbound sends then vanish into that dead socket — `lan.send` succeeds
    /// locally and nothing throws — for up to a full steady-state watchdog
    /// interval (30s). That is the exact window where user actions (e.g. a tab
    /// create) get silently lost after a background/resume cycle.
    ///
    /// This fires a short one-shot probe: baseline `lastHeartbeatAt` to now, and
    /// 3s later, if no LAN heartbeat has arrived (which would advance
    /// `lastHeartbeatAt` past the baseline), tear the LAN down so relay takes
    /// over immediately. The steady-state watchdog is left untouched — this only
    /// tightens detection for the resume moment. Confirm-or-resend on the client
    /// still guarantees create delivery; this reduces how often the hole opens
    /// for every other command too.
    func revalidateLANAfterResume() {
        guard state == .lanPreferred else { return }
        let baseline = Date()
        lastHeartbeatAt = baseline
        DiagnosticLog.log("lan revalidate after resume: 3s probe armed", tag: "transport", fields: [:])
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled else { return }
            // A genuine LAN heartbeat since resume advances lastHeartbeatAt past
            // the baseline; if it hasn't moved, the LAN socket is not delivering.
            guard self.state == .lanPreferred, self.lastHeartbeatAt <= baseline else { return }
            DiagnosticLog.log("lan revalidate: no heartbeat 3s after resume, tearing down lan", tag: "transport", level: .warn, fields: [:])
            self.stopLANHeartbeatWatchdog()
            self.handleLANWatchdogFire()
        }
    }

    /// Recover from a starved LAN socket: tear the dead NWConnection down and
    /// recompute the transport state so relay takes over immediately.
    ///
    /// The previous behavior only yielded `.peerDisconnected`, which the
    /// ViewModel deliberately does not treat as a transport teardown — so the
    /// dead LAN connection persisted, state stayed `.lanPreferred`, outbound
    /// sends kept preferring the wedged socket, and (before the relay-drop fix)
    /// inbound relay data was discarded. Now the dead socket is actually
    /// cancelled.
    func handleLANWatchdogFire() {
        currentLANHost = nil
        lanListenTask?.cancel()
        lanListenTask = nil
        lan.disconnect()
        // Recompute state: relay up -> .relayOnly (relay takes over
        // immediately); nothing up -> .disconnected + grace period.
        updateState()
        if relay?.isConnected == true {
            // Frames may have been lost while the LAN socket was wedged;
            // re-sync so a fresh snapshot reconciles state. Retryable — see
            // TransportManager+Sync.swift.
            DiagnosticLog.log("lan watchdog fired, relay takes over", tag: "transport", fields: [:])
            Task { [weak self] in
                await self?.sendSyncWithRetry(reason: "lan-watchdog")
            }
        } else {
            // No fallback transport. Signal the ViewModel the same way the
            // LAN stream-ended path does so it enters reconnecting.
            DiagnosticLog.log("lan watchdog fired, no relay fallback", tag: "transport", level: .warn, fields: [:])
            eventContinuation.yield(.peerDisconnected)
        }
    }
}
