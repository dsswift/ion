import Foundation

/// What the Studio wire feels like from this phone.
///
/// The server measures the network and its own work (`server/src/protocol/
/// wire-latency.ts`), and neither includes the part a person waits through: an
/// action leaving here and its result arriving back. Every client reports its
/// own, so the dashboard shows the two together -- a low server time beside a
/// high client time is the wire, not the work.
///
/// One line per window, into this device's diagnostic log, which the server it
/// pairs with pulls into `ios-diagnostic-logs.jsonl`. Mirrors
/// `packages/shared/src/client-wire-latency.ts`; the field names are the same
/// because one dashboard reads both.
final class StudioClientLatency {
    /// How often a window is written. Matches the server's and the desktop's.
    static let windowInterval: TimeInterval = 60

    private var durations: [Double] = []
    private var timeouts = 0
    private var outstanding: [String: Date] = [:]
    private let transport: String

    init(transport: String) {
        self.transport = transport
    }

    /// An action left this device.
    func noteActionSent(id: String, at: Date = Date()) {
        outstanding[id] = at
    }

    /// Its result came back. An id with no record is ignored: a result for an
    /// action from a previous connection.
    func noteActionResult(id: String, at: Date = Date()) {
        guard let sentAt = outstanding.removeValue(forKey: id) else { return }
        durations.append(at.timeIntervalSince(sentAt) * 1000)
    }

    /// An action gave up waiting. Counted rather than folded into the
    /// percentiles: a timeout is a different event from a slow answer, and
    /// averaging it in would make the wire look merely sluggish.
    func noteActionTimeout(id: String) {
        outstanding.removeValue(forKey: id)
        timeouts += 1
    }

    /// Whether this window has anything to say.
    var hasSamples: Bool { !durations.isEmpty || timeouts > 0 }

    /// Write the window and start fresh. Silent when nothing happened.
    func flush(clientId: String) {
        guard hasSamples else { return }
        let sorted = durations.sorted()
        DiagnosticLog.log("client window", tag: "wire-latency", fields: [
            "environment_id": clientId,
            "transport": transport,
            "action_p50_ms": String(Self.percentile(sorted, 50)),
            "action_p95_ms": String(Self.percentile(sorted, 95)),
            "action_max_ms": String(Int((sorted.last ?? 0).rounded())),
            "actions": String(sorted.count),
            "action_timeouts": String(timeouts)
        ])
        durations = []
        timeouts = 0
    }

    /// Nearest-rank percentile, rounded to a whole millisecond. Zero for an
    /// empty set; the `actions` count is what says which it is.
    static func percentile(_ sorted: [Double], _ p: Int) -> Int {
        guard !sorted.isEmpty else { return 0 }
        let rank = Int((Double(p) / 100 * Double(sorted.count)).rounded(.up))
        return Int(sorted[min(max(rank, 1), sorted.count) - 1].rounded())
    }
}
