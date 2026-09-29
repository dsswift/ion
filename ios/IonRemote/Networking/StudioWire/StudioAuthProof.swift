import Foundation
import CryptoKit

/// The `proof` of a `paired` hello credential: HMAC-SHA256 over nonce bytes,
/// keyed by the pairing's shared secret, base64 (`createAuthProof` in
/// `packages/shared/src/e2e/index.ts`).
enum StudioAuthProof {

    /// The proof over a nonce from `GET /auth/config`, for the direct route.
    /// Nil when the nonce decodes as neither base64 nor base64url.
    static func proof(nonceBase64: String, secret: SymmetricKey) -> String? {
        guard let nonce = decodeBase64OrURL(nonceBase64) else { return nil }
        return E2ECrypto.createAuthProof(nonce: nonce, sharedSecret: secret).base64EncodedString()
    }

    /// Decodes base64 in either alphabet, padded or not.
    ///
    /// The server mints its nonce with `randomBytes(32).toString('base64url')`
    /// (`server/src/auth/nonce.ts`) and verifies with `Buffer.from(n,
    /// 'base64')`, which in Node accepts `-`/`_` and missing padding — so it
    /// decodes its own nonce and never notices the alphabet. Swift's
    /// `Data(base64Encoded:)` is strict on both counts, so it returned nil for
    /// every nonce carrying a `-` or `_` and the direct route failed its
    /// handshake while the relay, which uses no nonce, kept working.
    ///
    /// Accepting both alphabets here rather than changing what the server
    /// mints: the nonce is already published in that form to every client.
    static func decodeBase64OrURL(_ raw: String) -> Data? {
        if let data = Data(base64Encoded: raw) { return data }
        var normalized = raw.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder > 0 { normalized += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: normalized)
    }

    /// The proof for the relay route. No nonce exists over a relay; the sealed
    /// channel is what identifies the client (`docs/protocol/studio-wire.md`,
    /// Credentials). The field is still sent so the credential keeps its shape:
    /// the HMAC over the tag `relay` read as base64, which is the three bytes
    /// that `rela` decodes to. The sealed fixture pins the value.
    static func relayProof(secret: SymmetricKey) -> String {
        E2ECrypto.createAuthProof(nonce: relayTagBytes, sharedSecret: secret).base64EncodedString()
    }

    /// `Buffer.from('relay', 'base64')`: the decoder stops at the last whole group.
    static let relayTagBytes = Data([0xad, 0xe9, 0x5a])
}
