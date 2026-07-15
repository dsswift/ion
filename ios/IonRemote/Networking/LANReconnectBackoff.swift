import Foundation

/// Escalating backoff for consecutive failed LAN auto-reconnect attempts.
///
/// The Bonjour observation loop polls every ~500ms; before this state machine
/// existed it re-attempted a failing LAN auth on every tick. Hammering a
/// desktop whose auth path is failing repeatedly re-trips its auth-failure
/// cooldown, so every subsequent attempt gets a transient close (1008) and a
/// genuinely recoverable situation never recovers — and a definitive
/// rejection was retried forever instead of being surfaced.
///
/// Pure value-type state machine (no clocks, no timers) so the progression is
/// directly unit-testable: attempts 1,2,3,4,5,6,... map to delays
/// 1s,2s,5s,10s,30s,30s,... `reset()` on a successful auth returns to zero so
/// the next disconnect starts the ladder from the beginning.
struct LANReconnectBackoff: Equatable, Sendable {

    /// Delay ladder in seconds for consecutive failures. The last entry is
    /// the cap: every failure beyond the ladder keeps returning it.
    static let delays: [TimeInterval] = [1, 2, 5, 10, 30]

    /// Count of consecutive failed attempts since the last `reset()`.
    private(set) var consecutiveFailures: Int = 0

    /// Record a failed connect attempt and return the delay to wait before
    /// the next attempt (escalating per `delays`, capped at the last entry).
    mutating func recordFailure() -> TimeInterval {
        consecutiveFailures += 1
        let index = min(consecutiveFailures - 1, Self.delays.count - 1)
        return Self.delays[index]
    }

    /// A successful connection clears the ladder: the next failure starts
    /// again at the first delay.
    mutating func reset() {
        consecutiveFailures = 0
    }
}
