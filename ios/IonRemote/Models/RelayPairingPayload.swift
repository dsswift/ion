import Foundation

/// The payload Ion Studio presents for relay pairing (scanned as a QR code
/// or copy-pasted): everything iOS needs to sign in, reach a relay, and run
/// the DH handshake on a pairing channel the desktop/server already opened.
struct RelayPairingPayload: Codable, Sendable, Equatable {
    /// Relay base URLs to try, in order. `RelayPairing.pairOverRelay` dials
    /// the first one that accepts the WebSocket upgrade.
    let relayUrls: [String]
    /// The pairing channel id the server opened and is waiting on.
    let channelId: String
    let issuer: String
    let audience: String
    let scope: String
    /// Unix ms — the payload is only valid until this time. `RelayPairing`
    /// refuses to start a handshake against an expired payload rather than
    /// let the user watch a doomed connect attempt fail with an opaque error.
    let expiresAt: Double

    var isExpired: Bool {
        Date().timeIntervalSince1970 * 1000 > expiresAt
    }
}
