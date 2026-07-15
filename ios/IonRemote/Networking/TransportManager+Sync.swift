import Foundation

// MARK: - Reconnect sync handshake (retryable)

extension TransportManager {

    /// Send `.sync` with bounded retries until a snapshot arrives.
    ///
    /// The reconnect handshake used to be single-shot: when the relay flipped
    /// connected, one `.sync` was fired and a failure was only printed. That
    /// could deadlock the session: the ViewModel-level sync defers while
    /// `.reconnecting`, but reaching `.connected` requires a snapshot, which
    /// requires the sync — circular. Making the transport-level sync retryable
    /// breaks the cycle: it keeps asking until the desktop answers with a
    /// snapshot (observed via `lastSnapshotReceivedAt`) or the retry budget is
    /// exhausted (at which point the failure is logged loudly and the next
    /// transport state change re-triggers a fresh handshake).
    ///
    /// - Parameters:
    ///   - reason: caller tag for the diagnostic logs (e.g. "relay-connected").
    ///   - attempts: maximum number of sync sends before giving up.
    ///   - initialDelaySeconds: backoff seed; doubles each attempt, capped at 8s.
    /// - Returns: `true` when a snapshot arrived during the handshake, `false`
    ///   when the retry budget was exhausted without one.
    @discardableResult
    func sendSyncWithRetry(
        reason: String,
        attempts: Int = 5,
        initialDelaySeconds: Double = 1.0
    ) async -> Bool {
        let startedAt = Date()
        var delaySeconds = initialDelaySeconds
        for attempt in 1...max(1, attempts) {
            // A snapshot arriving means the desktop already answered (this
            // sync or an equivalent trigger) — the handshake is complete.
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
                DiagnosticLog.log("sync send failed", tag: "transport.sync", level: .warn, fields: [
                    "reason": reason,
                    "attempt": String(attempt),
                    "max_attempts": String(attempts),
                    "error": error.localizedDescription
                ])
            }
            // Wait for the snapshot; if it lands during the backoff we're done
            // on the next loop iteration's check.
            try? await Task.sleep(for: .seconds(delaySeconds))
            delaySeconds = min(delaySeconds * 2, 8.0)
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
