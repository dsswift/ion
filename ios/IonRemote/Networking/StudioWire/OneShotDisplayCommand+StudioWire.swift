import Foundation

/// The one-shot display write, on the Studio wire.
///
/// Renaming a server this device is not currently looking at still needs a
/// connection to that server. The sidecar is a whole `StudioTransport` built
/// from the same stored record the session would use, started, asked one
/// question, and stopped — the live session is untouched.
///
/// It does not look for the server's address on the local network: a throwaway
/// connection that has to browse for a host is a slow way to fail. The stored
/// address is tried and the relay is the fallback, which is what the session's
/// own route does.
extension OneShotDisplayCommand {

    static func send(
        studio record: StudioServerRecord,
        deviceId: String,
        customName: String?,
        customIcon: String?,
        updatedAt: Date,
        oidcToken: (@Sendable () async throws -> String)? = nil
    ) async throws -> RemoteDisplayAck {
        let short = String(deviceId.prefix(8))
        DiagnosticLog.log("oneshot display start on the studio wire", tag: "oneshot.display", fields: [
            "device_id": short, "client_id": record.clientId, "relay_count": String(record.relays.count)
        ])

        var inputs = TransportFactory.StudioInputs(record: record, deviceId: deviceId)
        inputs.discoversAddress = false
        if let oidcToken { inputs.oidcToken = { _ in try await oidcToken() } }
        let transport = TransportFactory.makeStudioTransport(inputs)
        // The stream is buffered, so reading it after the send still sees an
        // answer that arrived first.
        let events = transport.events
        defer {
            DiagnosticLog.log("oneshot display stop", tag: "oneshot.display", fields: ["device_id": short])
            transport.stop()
        }

        await transport.start()
        let deadline = ContinuousClock.now.advanced(by: connectTimeout)
        while ContinuousClock.now < deadline && transport.state == .disconnected {
            // A cancelled sleep means the caller went away; the deadline check
            // ends the loop and the unreachable path below reports it.
            // Only CancellationError can surface; the deadline check ends the loop.
            // swiftlint:disable:next silent_try_optional
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard transport.state != .disconnected else {
            DiagnosticLog.log("oneshot display connect timeout", tag: "oneshot.display", level: .warn, fields: [
                "device_id": short, "state": "disconnected"
            ])
            throw OneShotDisplayError.unreachable
        }
        DiagnosticLog.log("oneshot display connected", tag: "oneshot.display", fields: [
            "device_id": short, "state": transport.state.rawValue
        ])

        try await transport.send(.setRemoteDisplay(customName: customName, customIcon: customIcon, updatedAt: updatedAt))
        return try await ack(from: events, deviceId: short)
    }

    /// The stored value the server answered with, which is not what was sent
    /// when a newer edit won.
    private static func ack(from events: AsyncStream<RemoteEvent>, deviceId: String) async throws -> RemoteDisplayAck {
        try await withThrowingTaskGroup(of: RemoteDisplayAck.self) { group in
            group.addTask {
                for await event in events {
                    guard case .remoteDisplay(let name, let icon, let storedAt) = event else { continue }
                    DiagnosticLog.log("oneshot display ack", tag: "oneshot.display", fields: [
                        "device_id": deviceId, "name": name == nil ? "cleared" : "set",
                        "icon": icon ?? "cleared", "server_ts": String(Int(storedAt.timeIntervalSince1970 * 1000))
                    ])
                    return RemoteDisplayAck(customName: name, customIcon: icon, updatedAt: storedAt)
                }
                DiagnosticLog.log("oneshot display stream ended without an answer", tag: "oneshot.display", level: .warn, fields: [
                    "device_id": deviceId
                ])
                throw OneShotDisplayError.ackMissing
            }
            group.addTask {
                // Cancelled means the answer arrived first, which is the
                // normal end of this task; the log below is skipped for it.
                // Cancellation means the ack arrived first; checkCancellation below exits without logging.
                // swiftlint:disable:next silent_try_optional
                try? await Task.sleep(for: ackTimeout)
                try Task.checkCancellation()
                DiagnosticLog.log("oneshot display timeout", tag: "oneshot.display", level: .warn, fields: [
                    "device_id": deviceId, "after": String(describing: ackTimeout)
                ])
                throw OneShotDisplayError.timeout
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw OneShotDisplayError.ackMissing }
            return first
        }
    }
}
