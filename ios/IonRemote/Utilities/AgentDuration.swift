import Foundation

/// Shared duration helpers for agent elapsed-time display.
/// Used by AgentBarRow (compact header) and AgentExpandedContent
/// (pinned header in the full-screen popup) so both surfaces use
/// one implementation and can't diverge.
enum AgentDuration {

    /// Compute elapsed seconds for an agent.
    ///
    /// - Running agents: `now.timeIntervalSince1970 − agent.startTime`.
    /// - Terminal agents: `agent.elapsed`.
    /// - Returns `nil` when neither value is available.
    static func elapsedSeconds(
        status: String,
        startTime: Double?,
        elapsed: Double?,
        now: Date
    ) -> Int? {
        if status == "running", let st = startTime {
            let secs = Int(now.timeIntervalSince1970 - st)
            return max(0, secs)
        }
        if let e = elapsed { return max(0, Int(e)) }
        return nil
    }

    /// Format run milliseconds for compact settled-run metadata. Invalid and
    /// sub-second values preserve desktop's `<1s` treatment.
    static func formatMilliseconds(_ durationMs: Int) -> String {
        guard durationMs >= 1_000 else { return "<1s" }
        return format(durationMs / 1_000)
    }

    /// Format an elapsed-seconds value into a human-readable string.
    ///
    /// - < 60 s  → "42s"
    /// - < 1 h   → "2m 7s"
    /// - ≥ 1 h   → "1h 3m"
    static func format(_ secs: Int) -> String {
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m \(secs % 60)s" }
        let h = secs / 3600
        let m = (secs % 3600) / 60
        return "\(h)h \(m)m"
    }
}
