import Foundation
import CryptoKit

/// End-to-end encryption using AES-256-GCM with X25519 key exchange.
///
/// Note: ChaCha20-Poly1305 is not available in Electron's BoringSSL.
/// AES-256-GCM has equivalent security properties and is universally
/// supported across Node.js, Electron, and iOS CryptoKit.
struct E2ECrypto {

    enum Error: Swift.Error {
        case encryptionFailed
        case decryptionFailed
        case invalidNonceLength
        case keyAgreementFailed
    }

    /// Encrypt plaintext with a 32-byte shared secret.
    /// Returns (nonce, ciphertext) where nonce is 12 bytes and ciphertext includes the 16-byte GCM tag.
    static func encrypt(plaintext: Data, key: SymmetricKey) throws -> (nonce: Data, ciphertext: Data) {
        let nonce = AES.GCM.Nonce()
        let sealedBox = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
        // sealedBox.ciphertext is the encrypted payload; sealedBox.tag is the 16-byte auth tag.
        // Concatenate ciphertext + tag so the receiver can reconstruct the SealedBox.
        var ciphertextWithTag = Data(sealedBox.ciphertext)
        ciphertextWithTag.append(contentsOf: sealedBox.tag)
        return (nonce: Data(nonce), ciphertext: ciphertextWithTag)
    }

    /// Decrypt ciphertext (with appended tag) using nonce and shared secret.
    static func decrypt(ciphertext: Data, nonce: Data, key: SymmetricKey) throws -> Data {
        guard nonce.count == 12 else {
            throw Error.invalidNonceLength
        }
        let gcmNonce = try AES.GCM.Nonce(data: nonce)

        // The ciphertext contains the encrypted payload followed by the 16-byte GCM tag.
        let tagLength = 16
        guard ciphertext.count >= tagLength else {
            throw Error.decryptionFailed
        }
        let encryptedPayload = ciphertext.prefix(ciphertext.count - tagLength)
        let tag = ciphertext.suffix(tagLength)

        let sealedBox = try AES.GCM.SealedBox(
            nonce: gcmNonce,
            ciphertext: encryptedPayload,
            tag: tag
        )
        return try AES.GCM.open(sealedBox, using: key)
    }

    /// Generate an X25519 key pair for pairing key exchange.
    static func generateKeyPair() -> Curve25519.KeyAgreement.PrivateKey {
        Curve25519.KeyAgreement.PrivateKey()
    }

    /// Derive a shared secret from our private key and the peer's public key.
    /// Uses HKDF-SHA256 with info "coda-remote-v1" to derive a 32-byte symmetric key.
    static func deriveSharedSecret(
        privateKey: Curve25519.KeyAgreement.PrivateKey,
        peerPublicKey: Curve25519.KeyAgreement.PublicKey
    ) throws -> SymmetricKey {
        let rawShared = try privateKey.sharedSecretFromKeyAgreement(with: peerPublicKey)
        return rawShared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(),
            sharedInfo: Data("coda-remote-v1".utf8),
            outputByteCount: 32
        )
    }

    /// Create an HMAC-SHA256 auth proof: HMAC(nonce, sharedSecret).
    static func createAuthProof(nonce: Data, sharedSecret: SymmetricKey) -> Data {
        let hmac = HMAC<SHA256>.authenticationCode(for: nonce, using: sharedSecret)
        return Data(hmac)
    }

    /// Verify an HMAC-SHA256 auth proof with constant-time comparison.
    static func verifyAuthProof(nonce: Data, proof: Data, sharedSecret: SymmetricKey) -> Bool {
        return HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: nonce, using: sharedSecret)
    }

    /// Derive a channel ID from the shared secret.
    /// Takes the first 16 bytes of the SHA-256 hash of the raw key material and hex-encodes them.
    static func deriveChannelId(sharedSecret: SymmetricKey) -> String {
        sharedSecret.withUnsafeBytes { keyBytes in
            let hash = SHA256.hash(data: Data(keyBytes))
            return hash.prefix(16).map { String(format: "%02x", $0) }.joined()
        }
    }
}
