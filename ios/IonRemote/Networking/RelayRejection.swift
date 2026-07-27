import Foundation

/// Classifies why a relay WebSocket connection failed, specifically whether the
/// failure was the relay refusing our bearer credential.
///
/// Two distinct signals carry a credential rejection, and the relay uses a
/// different one depending on *when* it rejects:
///
/// - **HTTP 401/403 on the upgrade.** `auth.Validate` runs in the HTTP handler
///   before the WebSocket upgrade (`relay/main.go`), so a bad or expired token
///   presented at connect time is refused with a plain HTTP status. No
///   WebSocket ever exists, so there is no close code at all —
///   `URLSessionWebSocketTask` surfaces only the generic
///   "There was a bad response from the server."
/// - **Close code 4401 mid-connection.** A token that expires while the socket
///   is open is enforced by the relay's expiry watcher, which closes with the
///   application code 4401 ("token_expired").
///
/// Only the second was ever recognised. A phone whose cached OIDC token had
/// gone stale hit the first path on every attempt: the rejection was invisible,
/// `onTokenRejected` never fired, the stale token was never invalidated, and
/// the backoff ladder retried the same dead credential out to its 30-second
/// ceiling indefinitely.
///
/// Pure and side-effect free so the classification is unit-testable without a
/// live socket — same seam as `LANAuthOutcome.resolve`.
enum RelayRejection {

    /// WebSocket application close code the relay uses for an expired token.
    static let closeCodeTokenExpired = 4401

    /// Whether the observed failure signals that the relay refused our
    /// credential (as opposed to a network fault, timeout, or peer restart).
    ///
    /// - Parameters:
    ///   - closeCode: raw WebSocket close code, or `nil`/0 when the socket
    ///     failed without a close frame.
    ///   - httpStatus: status code from the upgrade response, when the
    ///     handshake got far enough to produce one.
    /// - Returns: `true` when the credential should be invalidated and
    ///   re-acquired before the next attempt.
    static func isCredentialRejection(closeCode: Int?, httpStatus: Int?) -> Bool {
        if let code = closeCode, code == closeCodeTokenExpired {
            return true
        }
        if let status = httpStatus, status == 401 || status == 403 {
            return true
        }
        return false
    }
}
