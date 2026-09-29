import Foundation

/// What `auth.revokeClient` did.
struct RevokeClientResult: Decodable, Equatable, Sendable {
    /// False when the pairing was already gone.
    let revoked: Bool
    /// Live sessions on that pairing the server closed.
    let closed: Int
}
