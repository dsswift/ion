import Foundation

/// Where a `StudioConnection` is in its life. Published on `StudioConnection.states`.
enum StudioConnectionState: Equatable, Sendable {
    /// Never started, or stopped by the caller.
    case idle
    /// Resolving a route, dialing, or waiting for the welcome.
    case connecting
    /// Welcomed. Frames flow.
    case connected(route: StudioRouteKind, environmentId: String)
    /// The last attempt failed; the next is scheduled.
    case backoff(attempt: Int, delaySeconds: Double, reason: String)
    /// The quick attempts are used up. Still retrying, slowly, and anything
    /// that was queued has been dropped.
    case offline(reason: String)
    /// The server refused the hello for a reason dialing again cannot fix.
    /// Nothing more happens until `restart()`.
    case refused(StudioRefused)
    /// The server closed the connection for a reason dialing again cannot fix
    /// (the pairing was revoked, or this client holds a newer connection).
    /// Nothing more happens until `restart()`.
    case closedByServer(StudioClose)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

/// The timing of a `StudioConnection`. The defaults are the desktop broker's
/// (`desktop/src/main/connections/broker.ts`); tests pass short ones.
struct StudioConnectionTiming: Equatable, Sendable {
    /// Delay before retry N, in seconds. The last entry repeats.
    var backoffLadderSeconds: [Double] = [1, 2, 4, 8]
    /// Quick attempts allowed inside one window before going `offline`.
    var maxAttempts = 5
    var backoffWindowSeconds: Double = 5 * 60
    /// The retry cadence once `offline`.
    var offlineRetrySeconds: Double = 30
    /// How long a dial may take to produce a welcome before it counts as failed.
    var welcomeDeadlineSeconds: Double = transportConnectDeadlineSeconds
    var actionTimeoutSeconds: Double = 30
    /// Frames held while the wire is coming up. The oldest is dropped first.
    var maxPendingFrames = 256

    static let standard = StudioConnectionTiming()
}

/// What one dial attempt needs: a socket that is not open yet, and the
/// credential for the hello that will be sent on it. Resolved fresh for every
/// attempt, because a paired proof over TCP is an HMAC over a server nonce
/// that rotates and resets when the server restarts.
struct StudioDialPlan: Sendable {
    let socket: any StudioSocket
    let credential: StudioCredential
}

/// Everything a `StudioConnection` delivers to its owner besides action results.
enum StudioInbound: Equatable, Sendable {
    /// Sent once per successful connect, before anything else from that connect.
    case welcome(StudioWelcome)
    case event(StudioEvent)
    case snapshot(JSONValue)
    case body(StudioBody)
    case environmentPolicy(StudioEnvironmentPolicy)
    case binary(StudioBinaryFrame)
}

/// Why `StudioConnection.sendAction` threw.
enum StudioActionFailure: Error, LocalizedError, Equatable {
    /// The server declined the action.
    case refused(code: String, message: String)
    /// The action ran and failed.
    case failed(code: String, message: String)
    case timedOut(action: String, seconds: Double)
    /// The action was sent and the connection dropped before its result arrived.
    case connectionLost(action: String)
    /// The action was still queued when the queue was dropped, or the connection was stopped.
    case abandoned(action: String)

    var errorDescription: String? {
        switch self {
        case .refused(_, let message), .failed(_, let message): return message
        case .timedOut(let action, let seconds): return "studio_action '\(action)' timed out after \(seconds)s"
        case .connectionLost(let action): return "The connection dropped before '\(action)' was answered"
        case .abandoned(let action): return "'\(action)' was never sent; the connection did not come up"
        }
    }

    /// A short name for the outcome, for a log field: the server's code for a
    /// refusal or failure, the kind otherwise.
    var outcomeCode: String {
        switch self {
        case .refused(let code, _): return "refused:\(code)"
        case .failed(let code, _): return "failed:\(code)"
        case .timedOut: return "timed_out"
        case .connectionLost: return "connection_lost"
        case .abandoned: return "abandoned"
        }
    }
}
