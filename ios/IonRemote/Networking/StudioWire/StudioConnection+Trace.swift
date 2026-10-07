import Foundation

// The connection's own measurements: the `connection.connect` span of each
// attempt, and the latency window's clocks.
extension StudioConnection {

    static let connectSpanName = "connection.connect"

    /// A dial is starting. The launch's first connect is a child of
    /// `app.launch`; every later one (a retry, a reconnect, a route change) is
    /// its own trace. An attempt still open from before is superseded.
    func beginConnectSpan() {
        connectSpan?.end(error: "superseded by a new dial")
        connectSpan = TraceSpan(
            name: Self.connectSpanName,
            parent: AppLaunchTrace.shared.parentForFirst(Self.connectSpanName),
            kind: .client,
            attributes: ["surface": "ios", "peer.service": "ion-server", "attempt": String(attempts + 1)]
        )
    }

    /// The welcome arrived: the attempt succeeded over `route` into the
    /// environment the welcome names. The principal it names is the identity
    /// every later span carries as `user`, when it is a person.
    func endConnectSpan(welcome: StudioWelcome, route: StudioRouteKind) {
        TraceSpan.user = welcome.principal.email ?? welcome.principal.username
        guard let span = connectSpan else { return }
        connectSpan = nil
        span.end(attributes: ["route": route.rawValue, "environment_id": welcome.environmentId])
    }

    /// The attempt ended without a welcome. Nothing happens when no attempt is open.
    func endConnectSpan(error: String) {
        guard let span = connectSpan else { return }
        connectSpan = nil
        var attributes: [String: String] = [:]
        if let route = socket?.routeKind ?? latency.route { attributes["route"] = route.rawValue }
        span.end(attributes: attributes, error: error)
    }

    /// An action's frame is being written to the socket: its round trip
    /// starts now, and its wait since `submitAction` is queue time.
    func noteActionWritten(id: String) {
        latency.noteActionSent(id: id)
    }

    /// The window timer fired.
    func flushLatencyWindow() {
        latency.flush()
    }
}
