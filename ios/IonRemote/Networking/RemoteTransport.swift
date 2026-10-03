import Foundation

/// What the view model needs from whatever carries `RemoteEvent`s in and
/// `RemoteCommand`s out. `StudioTransport` is the only conformer; the protocol
/// stays because the view model is written against a transport's capabilities
/// rather than against one class, and `TransportFactory` builds it.
protocol RemoteTransport: AnyObject {
    /// Decoded events, in arrival order, plus the transport's own synthesized
    /// ones (`peerDisconnected`, `transportReconnecting`, `lanAuthRejected`,
    /// `lanSecretUnusable`).
    var events: AsyncStream<RemoteEvent> { get }
    var state: TransportState { get }
    /// The pairing id this transport serves. Diagnostic log lines are stamped with it.
    var deviceId: String? { get }

    /// The developer surfaces the server offers this connection.
    var developerSurfaces: DeveloperSurfaces { get }

    func send(_ command: RemoteCommand) async throws
    func stop()

    /// Whether a relay leg is up right now, so an auth rejection on the LAN leg
    /// can be checked against the relay before the pairing is judged.
    var relayIsConnected: Bool { get }
    /// Whether an auth rejection from this transport covers every route to the
    /// server. True when one credential serves both routes, so there is no
    /// second leg left to try and the pairing itself was refused.
    var authRejectionIsFinal: Bool { get }
    /// Asks the server for its full state again.
    func startSyncHandshake(reason: String)
    /// Called when the app returns to the foreground with a transport still up.
    func revalidateAfterResume()
}

extension RemoteTransport {
    /// A transport that learns nothing about developer surfaces offers them all.
    var developerSurfaces: DeveloperSurfaces { .allEnabled }
}
