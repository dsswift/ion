import Foundation

/// A pairing link `auth.createPairingLink` minted. The link is a bearer
/// secret: whoever holds it until it expires can pair.
struct PairingLinkMinted: Decodable, Equatable, Sendable {
    let url: String
    /// The one-time code inside the link.
    let code: String
    /// Unix ms the link stops working.
    let expiresAt: Double

    var expiresDate: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
}
