import Foundation

/// What the Studio wire feels like from this phone.
///
/// The server measures the network and its own work (`server/src/protocol/
/// wire-latency.ts`), and neither includes the part a person waits through: an
/// action leaving here and its result arriving back. Every client reports its
/// own, so the dashboard shows the two together -- a low server time beside a
/// high client time is the wire, not the work.
///
/// An action is timed from the socket write, not from the moment it was
/// handed to the connection: a frame held until the welcome, or behind a slow
/// send, waited in this client, and that wait is reported on its own as queue
/// time so the wire's number stays the wire's.
///
/// One line per window, into this device's diagnostic log, which the server it
/// pairs with pulls into `ios-diagnostic-logs.jsonl`. Mirrors
/// `packages/shared/src/client-wire-latency.ts`; the field names are the same
/// because one dashboard reads both.
final class StudioClientLatency {
    /// How often a window is written. Matches the server's and the desktop's.
    static let windowInterval: TimeInterval = 60

    /// One window's line: the string fields and the numeric ones.
    struct Window: Equatable {
        var fields: [String: String]
        var numbers: [String: Double]
    }

    private var durations: [Double] = []
    private var queueWaits: [Double] = []
    private var timeouts = 0
    private var enqueued: [String: Date] = [:]
    private var outstanding: [String: Date] = [:]
    /// The route the current socket takes. Unknown until a socket is adopted.
    private(set) var route: StudioRouteKind?
    /// The environment the welcome named. Unknown until the first welcome.
    private(set) var environmentId: String?

    init(route: StudioRouteKind? = nil, environmentId: String? = nil) {
        self.route = route
        self.environmentId = environmentId
    }

    /// A socket was adopted; its route is what the window reports from here on.
    func noteRoute(_ route: StudioRouteKind) {
        self.route = route
    }

    /// The welcome named the environment.
    func noteEnvironment(_ environmentId: String) {
        self.environmentId = environmentId
    }

    /// An action was handed to the connection. The clock for queue time.
    func noteActionEnqueued(id: String, at: Date = Date()) {
        enqueued[id] = at
    }

    /// Its frame is being written to the socket. The clock for the round trip.
    func noteActionSent(id: String, at: Date = Date()) {
        if let queuedAt = enqueued.removeValue(forKey: id) {
            queueWaits.append(max(0, at.timeIntervalSince(queuedAt) * 1000))
        }
        outstanding[id] = at
    }

    /// Its result came back. An id with no record is ignored: a result for an
    /// action from a previous connection, or one whose frame never left.
    func noteActionResult(id: String, at: Date = Date()) {
        enqueued.removeValue(forKey: id)
        guard let sentAt = outstanding.removeValue(forKey: id) else { return }
        durations.append(at.timeIntervalSince(sentAt) * 1000)
    }

    /// An action gave up waiting. Counted rather than folded into the
    /// percentiles: a timeout is a different event from a slow answer, and
    /// averaging it in would make the wire look merely sluggish.
    func noteActionTimeout(id: String) {
        enqueued.removeValue(forKey: id)
        outstanding.removeValue(forKey: id)
        timeouts += 1
    }

    /// Whether this window has anything to say.
    var hasSamples: Bool { !durations.isEmpty || timeouts > 0 || !queueWaits.isEmpty }

    /// The line this window would write, or nil when nothing happened.
    func window() -> Window? {
        guard hasSamples else { return nil }
        let sorted = durations.sorted()
        let queue = queueWaits.sorted()
        var fields = ["transport": route?.rawValue ?? "unknown"]
        if let environmentId { fields["environment_id"] = environmentId }
        return Window(fields: fields, numbers: [
            "action_p50_ms": Double(Self.percentile(sorted, 50)),
            "action_p95_ms": Double(Self.percentile(sorted, 95)),
            "action_max_ms": (sorted.last ?? 0).rounded(),
            "actions": Double(sorted.count),
            "action_timeouts": Double(timeouts),
            "queue_p50_ms": Double(Self.percentile(queue, 50)),
            "queued": Double(queue.count)
        ])
    }

    /// Write the window and start fresh. Silent when nothing happened.
    func flush() {
        guard let window = window() else { return }
        DiagnosticLog.log("client window", tag: "wire-latency", fields: window.fields, numbers: window.numbers)
        durations = []
        queueWaits = []
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
