import Foundation

/// `gitIdentity.mintSshKey` / `gitIdentity.setSshKey`: the public half of the
/// key the server now holds for a git host.
struct GitPublicKey: Decodable, Equatable, Sendable {
    let publicKey: String
}
