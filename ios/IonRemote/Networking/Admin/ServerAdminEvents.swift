import Foundation

/// Admin channel events from every paired server, keyed by server.
///
/// A transport publishes what arrives; a settings page subscribes to one
/// server's events and may read the newest payload of a channel it opened
/// after the event arrived.
final class ServerAdminEvents: @unchecked Sendable {

    /// The store every transport built by `TransportFactory` publishes to.
    static let shared = ServerAdminEvents()

    private let lock = NSLock()
    private var subscribers: [String: [UUID: AsyncStream<ServerAdminEvent>.Continuation]] = [:]
    private var latest: [String: [String: JSONValue]] = [:]

    func publish(_ event: ServerAdminEvent) {
        let continuations: [AsyncStream<ServerAdminEvent>.Continuation] = lock.withLock {
            latest[event.serverId, default: [:]][event.channel] = event.payload
            return Array((subscribers[event.serverId] ?? [:]).values)
        }
        DiagnosticLog.log("admin events: published", tag: "admin.events", level: .debug, fields: [
            "server_id": event.serverId, "channel": event.channel, "subscribers": String(continuations.count)
        ])
        for continuation in continuations { continuation.yield(event) }
    }

    /// Every event from `serverId` published after this call, until the
    /// consumer stops iterating.
    func events(for serverId: String) -> AsyncStream<ServerAdminEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ServerAdminEvent>.makeStream()
        continuation.onTermination = { [weak self] _ in
            self?.lock.withLock { _ = self?.subscribers[serverId]?.removeValue(forKey: id) }
            DiagnosticLog.log("admin events: subscriber left", tag: "admin.events", level: .debug, fields: ["server_id": serverId])
        }
        lock.withLock { subscribers[serverId, default: [:]][id] = continuation }
        DiagnosticLog.log("admin events: subscriber joined", tag: "admin.events", level: .debug, fields: ["server_id": serverId])
        return stream
    }

    /// The newest payload `serverId` sent on `channel`, if any arrived.
    func latest(serverId: String, channel: String) -> JSONValue? {
        lock.withLock { latest[serverId]?[channel] }
    }
}
