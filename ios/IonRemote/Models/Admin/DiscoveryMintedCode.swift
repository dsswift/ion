import Foundation

/// A pairing code `environment.discovery.mintCode` minted on an always
/// discoverable server.
struct DiscoveryMintedCode: Decodable, Equatable, Sendable {
    let code: String
    /// Unix ms the code stops working.
    let expiresAt: Double

    var expiresDate: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
}
