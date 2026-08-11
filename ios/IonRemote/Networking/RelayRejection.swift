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

    /// Why the relay refused the connection, when it did.
    ///
    /// The distinction matters because the two failures need opposite handling.
    /// An expired credential is recoverable without the user: invalidate, mint a
    /// fresh token, reconnect. An identity mismatch is not recoverable at all by
    /// retrying — the relay bound this channel to a different OIDC subject
    /// (`relay/main.go`, "forbidden: channel owned by another identity"), and a
    /// refresh returns a token for the same subject. Retrying that in a backoff
    /// ladder burns battery forever and never succeeds; the user has to sign in
    /// with the account that owns the channel.
    enum Kind: Equatable {
        /// Not a credential refusal (network fault, timeout, peer restart).
        case none
        /// The credential was rejected but a new one may work.
        case expiredCredential
        /// The channel belongs to a different identity. Retrying cannot help.
        case identityMismatch
    }

    /// Classify an observed WebSocket failure.
    ///
    /// - Parameters:
    ///   - closeCode: raw WebSocket close code, or `nil`/0 when the socket
    ///     failed without a close frame.
    ///   - httpStatus: status code from the upgrade response, when the
    ///     handshake got far enough to produce one.
    static func classify(closeCode: Int?, httpStatus: Int?) -> Kind {
        if let code = closeCode, code == closeCodeTokenExpired {
            return .expiredCredential
        }
        if let status = httpStatus {
            if status == 403 { return .identityMismatch }
            if status == 401 { return .expiredCredential }
        }
        return .none
    }

    /// Whether the observed failure signals that the relay refused our
    /// credential (as opposed to a network fault, timeout, or peer restart).
    ///
    /// Both refusal kinds count: each means the credential we presented did not
    /// get us onto the channel. Callers that need to act differently on the two
    /// use `classify` directly.
    ///
    /// - Parameters:
    ///   - closeCode: raw WebSocket close code, or `nil`/0 when the socket
    ///     failed without a close frame.
    ///   - httpStatus: status code from the upgrade response, when the
    ///     handshake got far enough to produce one.
    /// - Returns: `true` when the relay refused the credential.
    static func isCredentialRejection(closeCode: Int?, httpStatus: Int?) -> Bool {
        classify(closeCode: closeCode, httpStatus: httpStatus) != .none
    }
}
