import Foundation

/// Per-pairing authority to display server-owned data on this phone.
///
/// Transport availability and authorization are different facts. A temporary
/// socket loss leaves an already-authorized pairing's cache useful; an explicit
/// refusal or cancelled sign-in means Ion has no current authority to expose
/// that server's cached conversations, resources, terminals, or settings.
/// See ADR-026.
struct ServerAccessRecord: Codable, Sendable, Equatable {
    enum Status: String, Codable, Sendable {
        case startup
        case authorized
        case verifying
        case transientlyDisconnected
        case authenticationRequired
        case rejected
    }

    enum Reason: String, Codable, Sendable {
        case none
        case noCredential
        case userCancelled
        case refreshRejected
        case wrongAccount
        case pairingRejected
        case signedOut
    }

    var status: Status
    var reason: Reason
    var changedAt: Date
    var lastAuthorizedAt: Date?

    static func startup(now: Date = Date()) -> ServerAccessRecord {
        ServerAccessRecord(status: .startup, reason: .none, changedAt: now, lastAuthorizedAt: nil)
    }
}
