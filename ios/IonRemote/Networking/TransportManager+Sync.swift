import Foundation

// MARK: - Reconnect sync handshake (retryable)

extension TransportManager {

    /// Replace the current snapshot-sync handshake atomically. Relay, Bonjour,
    /// watchdog, and teardown callbacks run on independent tasks, so ownership
    /// is decided under the lifecycle lock rather than by a racy task property.
    func startSyncHandshake(reason: String) {
        var previous: Task<Void, Never>?
        var generation: UInt64 = 0
        var started = false

        lifecycleLock.withLock { lifecycle in
            guard !lifecycle.stopped else { return }
            started = true
            previous = lifecycle.syncTask
            lifecycle.syncGeneration &+= 1
            generation = lifecycle.syncGeneration
            lifecycle.syncTask = Task { [weak self] in
                guard let self else { return }
                let satisfied = await self.sendSyncWithRetry(reason: reason)
                guard !Task.isCancelled else { return }
                let completedCurrent = self.lifecycleLock.withLock { current -> Bool in
                    guard !current.stopped, current.syncGeneration == generation else { return false }
                    current.syncTask = nil
                    return true
                }
                guard completedCurrent else { return }
                DiagnosticLog.log("sync handshake completed", tag: "transport.sync", fields: [
                    "reason": reason,
                    "satisfied": String(satisfied),
                    "generation": String(generation)
                ])
            }
        }

        guard started else {
            DiagnosticLog.log("sync handshake skipped for stopped transport", tag: "transport.sync", fields: [
                "reason": reason
            ])
            return
        }
        previous?.cancel()
        DiagnosticLog.log("sync handshake starting", tag: "transport.sync", fields: [
            "reason": reason,
            "replaced": String(previous != nil),
            "generation": String(generation)
        ])
    }

    /// Send `.sync` with bounded retries until a snapshot arrives.
    ///
    /// The reconnect handshake used to be single-shot: when the relay flipped
    /// connected, one `.sync` was fired and a failure was only printed. That
    /// could deadlock the session: the ViewModel-level sync defers while
    /// `.reconnecting`, but reaching `.connected` requires a snapshot, which
    /// requires the sync. Retry until a snapshot arrives or the budget expires.
    ///
    /// Cancellation and transport stop are successful teardown outcomes, not
    /// retry exhaustion. They return false without logging a terminal error.
    @discardableResult
    func sendSyncWithRetry(
        reason: String,
        attempts: Int = 5,
        initialDelaySeconds: Double = 1.0
    ) async -> Bool {
        let startedAt = Date()
        var delaySeconds = initialDelaySeconds
        for attempt in 1...max(1, attempts) {
            guard !Task.isCancelled, !isStopped else {
                DiagnosticLog.log("sync handshake cancelled", tag: "transport.sync", fields: [
                    "reason": reason,
                    "attempt": String(attempt)
                ])
                return false
            }
            if lastSnapshotReceivedAt > startedAt {
                DiagnosticLog.log("sync satisfied by snapshot", tag: "transport.sync", fields: [
                    "reason": reason,
                    "attempt": String(attempt)
                ])
                return true
            }
            do {
                try await send(.sync)
                DiagnosticLog.log("sync sent", tag: "transport.sync", fields: [
                    "reason": reason,
                    "attempt": String(attempt),
                    "max_attempts": String(attempts)
                ])
            } catch {
                guard !Task.isCancelled, !isStopped else {
                    DiagnosticLog.log("sync handshake cancelled after send", tag: "transport.sync", fields: [
                        "reason": reason,
                        "attempt": String(attempt)
                    ])
                    return false
                }
                DiagnosticLog.log("sync send failed", tag: "transport.sync", level: .warn, fields: [
                    "reason": reason,
                    "attempt": String(attempt),
                    "max_attempts": String(attempts),
                    "error": error.localizedDescription
                ])
            }
            do {
                try await Task.sleep(for: .seconds(delaySeconds))
            } catch is CancellationError {
                DiagnosticLog.log("sync handshake cancelled during backoff", tag: "transport.sync", fields: [
                    "reason": reason,
                    "attempt": String(attempt)
                ])
                return false
            } catch {
                DiagnosticLog.log("sync backoff sleep failed", tag: "transport.sync", level: .error, fields: [
                    "reason": reason,
                    "attempt": String(attempt),
                    "error": error.localizedDescription
                ])
                return false
            }
            delaySeconds = min(delaySeconds * 2, 8.0)
        }
        guard !Task.isCancelled, !isStopped else {
            DiagnosticLog.log("sync handshake cancelled before completion", tag: "transport.sync", fields: [
                "reason": reason
            ])
            return false
        }
        if lastSnapshotReceivedAt > startedAt {
            DiagnosticLog.log("sync satisfied by snapshot", tag: "transport.sync", fields: [
                "reason": reason,
                "attempt": "final"
            ])
            return true
        }
        DiagnosticLog.log("sync retries exhausted, no snapshot arrived", tag: "transport.sync", level: .error, fields: [
            "reason": reason,
            "attempts": String(attempts)
        ])
        return false
    }
}
