import Foundation

/// A CODA instance paired with this iOS device.
/// Mirrors `PairedDevice` in `src/main/remote/protocol.ts`.
struct PairedDevice: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let pairedAt: Date
    var lastSeen: Date?
    let channelId: String
    /// 32-byte NaCl secretbox key
    let sharedSecret: Data
    var relayURL: String?
    var relayAPIKey: String?
    var apnsToken: String?
}
