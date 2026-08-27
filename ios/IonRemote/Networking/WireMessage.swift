import Foundation

/// Wire envelope for messages between Ion and the iOS app.
/// Matches the `WireMessage` type in `src/main/remote/protocol.ts`.
struct WireMessage: Codable {
    let seq: UInt64
    /// Unix ms timestamp.
    let ts: Double?
    /// Outbound-seq epoch (generation id), carried in both directions.
    /// A newer inbound epoch resets receive state. An older epoch is stale.
    let epoch: Double?
    /// JSON-encoded payload (nil when encrypted).
    let payload: String?
    /// Base64-encoded nonce (present when encrypted).
    let nonce: String?
    /// Base64-encoded ciphertext (present when encrypted, replaces payload).
    let ciphertext: String?
    /// Identifies the sending device.
    let deviceId: String?

    init(
        seq: UInt64,
        ts: Double?,
        payload: String?,
        nonce: String? = nil,
        ciphertext: String? = nil,
        deviceId: String? = nil,
        epoch: Double? = nil
    ) {
        self.seq = seq
        self.ts = ts
        self.epoch = epoch
        self.payload = payload
        self.nonce = nonce
        self.ciphertext = ciphertext
        self.deviceId = deviceId
    }
}
