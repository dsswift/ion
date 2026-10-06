import Foundation
@testable import IonRemote

/// A `RemoteTransport` that connects to nothing.
///
/// Tests that only need "the view model is holding a transport" — the
/// diagnostic-log pairing stamp, the relay-config rebuild classification —
/// used to reach for the old `desktop_*` transport because building one
/// required no server. The Studio transport needs a socket and a route, so
/// those tests get this instead: it records what was sent and answers every
/// question with the quietest truthful answer.
final class FakeRemoteTransport: RemoteTransport, @unchecked Sendable {

    let events: AsyncStream<RemoteEvent>
    private let continuation: AsyncStream<RemoteEvent>.Continuation
    private(set) var sent: [RemoteCommand] = []
    private(set) var stopped = false
    private(set) var syncHandshakeReasons: [String] = []
    private(set) var revalidatedAfterResume = false

    var state: TransportState
    var deviceId: String?
    var relayIsConnected = false
    var authRejectionIsFinal = false

    init(deviceId: String? = nil, state: TransportState = .relayOnly) {
        self.deviceId = deviceId
        self.state = state
        var escaped: AsyncStream<RemoteEvent>.Continuation!
        events = AsyncStream { escaped = $0 }
        continuation = escaped
    }

    /// Hands an event to whoever is listening, so a test can drive the view
    /// model's event loop without a socket.
    func emit(_ event: RemoteEvent) {
        continuation.yield(event)
    }

    func send(_ command: RemoteCommand) async throws {
        sent.append(command)
    }

    /// Held by `sendAwaitingAnswer` until it returns, so a test can keep an
    /// answer outstanding; nil answers at once.
    var answer: (@Sendable () async throws -> Void)?

    func sendAwaitingAnswer(_ command: RemoteCommand) async throws {
        sent.append(command)
        try await answer?()
    }

    func stop() {
        stopped = true
        continuation.finish()
    }

    func startSyncHandshake(reason: String) {
        syncHandshakeReasons.append(reason)
    }

    func revalidateAfterResume() {
        revalidatedAfterResume = true
    }
}
