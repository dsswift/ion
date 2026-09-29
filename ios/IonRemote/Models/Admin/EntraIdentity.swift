import Foundation

/// The organization account signed in on the server's engine (`entra.identity`).
struct EntraIdentity: Codable, Equatable, Sendable {
    /// The attribution claim: the account name, else the object id.
    let user: String
    /// The account name (UPN or email). May be empty.
    let username: String
    let displayName: String
    /// The stable object id.
    let oid: String
    /// Who signed the identity. Absent from an older server.
    let issuer: String?
}
