import Foundation

// MARK: - LAN liveness watchdog

// Extracted from TransportManager.swift (allowlisted "don't extend; extract")
// when the watchdog gained re-arm + teardown behavior.

extension TransportManager {

    /// Start the LAN liveness watchdog.
    ///
    /// The desktop emits a heartbeat every `HEARTBEAT_INTERVAL_MS` (15s), so a
    /// healthy LAN connection refreshes `lastLANFrameAt` at least that often —
    /// and usually much more often, because EVERY successfully decrypted
    /// LAN-delivered frame (snapshot, delta, resend replay) advances the mark,
    /// not just heartbeats (the receive path updates it only for LAN-delivered
    /// frames — relay-delivered traffic proves the relay works, not the LAN
    /// socket). If two full heartbeat intervals (`intervalSeconds`, default
    /// 30s) elapse with no LAN frame while LAN is the active transport, the
    /// socket is silently dead — TCP can wedge without delivering a FIN, so
    /// the receive loop never ends and no disconnect is ever observed.
    ///
    /// Armed by `setState` the moment LAN becomes the active transport (so a
    /// LAN death before the first frame is still detected) and re-armed by
    /// each LAN frame as a backstop. Arming baselines `lastLANFrameAt` to
    /// now so a stale timestamp from a previous LAN session cannot fire the
    /// watchdog instantly.
    ///
    /// On fire the watchdog nils its own task (so a later LAN connection can
    /// re-arm — the one-shot task previously left itself in place, permanently
    /// blocking every restart) and tears the dead LAN connection down via
    /// `handleLANWatchdogFire()` so relay takes over immediately.
    ///
    /// Idempotent: an already-running watchdog is left in place (its loop
    /// re-reads `lastLANFrameAt`, so a fresh frame effectively resets the
    /// timer without needing a restart). `intervalSeconds` is injectable so
    /// unit tests can drive the loop on a short cadence.
    func startLANHeartbeatWatchdog(intervalSeconds: Double = 30.0) {
        guard lanHeartbeatWatchdogTask == nil else { return }
        lastLANFrameAt = Date()
        DiagnosticLog.log("lan liveness watchdog starting", tag: "transport", fields: [
            "interval_s": String(intervalSeconds)
        ])
        lanHeartbeatWatchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(intervalSeconds))
                guard !Task.isCancelled, let self else { return }
                let elapsed = Date().timeIntervalSince(self.lastLANFrameAt)
                if elapsed > intervalSeconds {
                    DiagnosticLog.log("lan liveness starved, tearing down lan", tag: "transport", level: .warn, fields: [
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

    /// Stop the LAN liveness watchdog (called on stop(), on leaving
    /// `.lanPreferred`, and on teardown).
    func stopLANHeartbeatWatchdog() {
        lanHeartbeatWatchdogTask?.cancel()
        lanHeartbeatWatchdogTask = nil
    }

    /// How long the post-resume probe waits for proof of LAN life before
    /// tearing the socket down. Must comfortably cover one full desktop
    /// heartbeat interval (15s): the desktop's heartbeat timer phase is
    /// arbitrary relative to our resume moment, so the worst-case wait for a
    /// heartbeat on an otherwise-idle-inbound connection is a full interval.
    /// The old 3s window could only see a heartbeat that happened to land in
    /// a 3s slice of a 15s cadence — it condemned healthy sockets on an ~80%
    /// coin flip and caused the repeating resume→teardown→re-auth flap that
    /// surfaced as "not connected" on tab create. 18s = one interval + 3s
    /// jitter/delivery margin. In practice the probe usually resolves in
    /// well under a second: the resume path fires a sync, and the snapshot
    /// response (any decrypted LAN frame) advances `lastLANFrameAt`.
    static let resumeProbeWindowSeconds: Double = 18.0

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
    /// This fires a one-shot probe: baseline `lastLANFrameAt` to now, and
    /// `resumeProbeWindowSeconds` later, if no LAN frame has arrived (which
    /// would advance `lastLANFrameAt` past the baseline), tear the LAN down so
    /// relay takes over. Because the resume path also sends a sync, a healthy
    /// socket almost always proves itself within a second via the snapshot
    /// response — the window length only bounds how long a genuine zombie can
    /// linger, it does not delay recovery of a healthy socket. The steady-state
    /// watchdog is left untouched. Confirm-or-resend on the client still
    /// guarantees create delivery; this reduces how often the hole opens for
    /// every other command too. `windowSeconds` is injectable for tests.
    func revalidateLANAfterResume(windowSeconds: Double = TransportManager.resumeProbeWindowSeconds) {
        guard state == .lanPreferred else { return }
        let baseline = Date()
        lastLANFrameAt = baseline
        DiagnosticLog.log("lan revalidate after resume: probe armed", tag: "transport", fields: [
            "window_s": String(windowSeconds)
        ])
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(windowSeconds))
            guard let self, !Task.isCancelled else { return }
            // A genuine LAN frame since resume advances lastLANFrameAt past
            // the baseline; if it hasn't moved, the LAN socket is not delivering.
            guard self.state == .lanPreferred, self.lastLANFrameAt <= baseline else { return }
            DiagnosticLog.log("lan revalidate: no frame after resume, tearing down lan", tag: "transport", level: .warn, fields: [
                "window_s": String(windowSeconds)
            ])
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
