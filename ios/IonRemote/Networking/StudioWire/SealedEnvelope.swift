import Foundation
import CryptoKit

/// The end-to-end envelope every Studio wire frame rides in for a paired
/// client, over a relay and over the server's TCP listener alike
/// (`studio-wire/relay-envelope.ts`).
///
/// The frame is sealed with the pairing's shared secret using the same
/// AES-256-GCM layout the rest of the app uses (`E2ECrypto`): a 12-byte nonce,
/// and the ciphertext with its 16-byte tag appended, both base64. Text frames
/// and binary frames take the same envelope; `bin` says which.
struct SealedEnvelope: Codable, Equatable, Sendable {
    // swiftlint:disable:next identifier_name
    let v: Int
    let nonce: String
    let ciphertext: String
    /// Present and true when the sealed bytes are a binary wire frame.
    let bin: Bool?

    // The doorbell fields a server sets beside the sealed frame for a relay to
    // read. They are plaintext and unauthenticated, so this client carries
    // them only so an envelope that has them still decodes; it never acts on them.
    let push: Bool?
    let pushTitle: String?
    let pushBody: String?
    let pushTabId: String?
    let notifyKind: String?
    let notifyResourceId: String?
    /// A W3C traceparent the sender sets beside the sealed frame, in plaintext,
    /// so a relay can record its forward span as a child. It names a span, never
    /// content, and a receiver does not act on it.
    let traceparent: String?

    /// What an envelope opened to.
    struct Opened: Equatable, Sendable {
        let bytes: Data
        let isBinary: Bool
    }

    // MARK: - Seal

    /// Seals one text frame into the envelope's wire text.
    static func seal(text: String, key: SymmetricKey, traceparent: String? = nil) throws -> String {
        try seal(bytes: Data(text.utf8), isBinary: false, key: key, traceparent: traceparent)
    }

    /// Seals one binary frame into the envelope's wire text.
    static func seal(binary: Data, key: SymmetricKey) throws -> String {
        try seal(bytes: binary, isBinary: true, key: key)
    }

    private static func seal(bytes: Data, isBinary: Bool, key: SymmetricKey, traceparent: String? = nil) throws -> String {
        let sealed = try E2ECrypto.encrypt(plaintext: bytes, key: key)
        let envelope = SealedEnvelope(
            v: 1,
            nonce: sealed.nonce.base64EncodedString(),
            ciphertext: sealed.ciphertext.base64EncodedString(),
            bin: isBinary ? true : nil,
            push: nil, pushTitle: nil, pushBody: nil, pushTabId: nil, notifyKind: nil, notifyResourceId: nil,
            traceparent: traceparent
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let text = String(data: try encoder.encode(envelope), encoding: .utf8) else {
            throw StudioWireError(message: "sealed envelope did not encode as UTF-8")
        }
        return text
    }

    // MARK: - Open

    /// Opens an envelope. Returns nil when the text is not an envelope or does
    /// not decrypt with `key`. The transport is untrusted, so a caller drops
    /// such a frame; it never acts on it.
    static func open(_ raw: String, key: SymmetricKey) -> Opened? {
        let envelope: SealedEnvelope
        do {
            envelope = try JSONDecoder().decode(SealedEnvelope.self, from: Data(raw.utf8))
        } catch {
            // Not envelope-shaped. The caller logs the drop with its own context.
            return nil
        }
        // `bin` is only ever absent or true on the wire; false is not an envelope.
        guard envelope.v == 1, envelope.bin != false else { return nil }
        guard let nonce = Data(base64Encoded: envelope.nonce),
              let ciphertext = Data(base64Encoded: envelope.ciphertext) else { return nil }
        do {
            let bytes = try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: key)
            return Opened(bytes: bytes, isBinary: envelope.bin == true)
        } catch {
            // Wrong key, tampered bytes, or a bad nonce length. Same answer as above.
            return nil
        }
    }
}
