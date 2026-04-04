import XCTest
import CryptoKit
@testable import CODARemote

final class E2ECryptoTests: XCTestCase {

    // MARK: - Encrypt / Decrypt

    func testEncryptDecryptRoundTrip() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = "Hello, CODA!".data(using: .utf8)!
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)
        let decrypted = try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: key)
        XCTAssertEqual(decrypted, plaintext)
    }

    func testEncryptProducesDifferentNonces() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = "same input".data(using: .utf8)!
        let (nonce1, _) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)
        let (nonce2, _) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)
        XCTAssertNotEqual(nonce1, nonce2, "Each encryption should produce a unique nonce")
    }

    func testEncryptProducesDifferentCiphertexts() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = "same input".data(using: .utf8)!
        let (_, ct1) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)
        let (_, ct2) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)
        XCTAssertNotEqual(ct1, ct2, "Different nonces should produce different ciphertext")
    }

    func testDecryptWithWrongKeyFails() throws {
        let key1 = SymmetricKey(size: .bits256)
        let key2 = SymmetricKey(size: .bits256)
        let plaintext = "secret message".data(using: .utf8)!
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: plaintext, key: key1)
        XCTAssertThrowsError(try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: key2)) { error in
            // ChaChaPoly open with wrong key should throw an authentication failure.
            // The error could be CryptoKit.CryptoKitError or our wrapper; just verify it throws.
            XCTAssertNotNil(error)
        }
    }

    func testDecryptWithCorruptedCiphertextFails() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = "original message".data(using: .utf8)!
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)

        // Flip a byte in the middle of the ciphertext to corrupt it.
        var corrupted = ciphertext
        let midpoint = corrupted.count / 2
        corrupted[midpoint] ^= 0xFF

        XCTAssertThrowsError(try E2ECrypto.decrypt(ciphertext: corrupted, nonce: nonce, key: key)) { error in
            XCTAssertNotNil(error)
        }
    }

    func testDecryptWithCorruptedNonceFails() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = "test".data(using: .utf8)!
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)

        var badNonce = nonce
        badNonce[0] ^= 0xFF

        XCTAssertThrowsError(try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: badNonce, key: key))
    }

    func testDecryptWithInvalidNonceLengthFails() throws {
        let key = SymmetricKey(size: .bits256)
        let shortNonce = Data(repeating: 0, count: 8) // Should be 12
        let ciphertext = Data(repeating: 0, count: 32)

        XCTAssertThrowsError(try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: shortNonce, key: key)) { error in
            if let cryptoError = error as? E2ECrypto.Error {
                XCTAssertEqual(cryptoError, .invalidNonceLength)
            }
        }
    }

    func testDecryptWithTooShortCiphertextFails() throws {
        let key = SymmetricKey(size: .bits256)
        let nonce = Data(repeating: 0, count: 12)
        let tooShort = Data(repeating: 0, count: 10) // Less than 16-byte tag

        XCTAssertThrowsError(try E2ECrypto.decrypt(ciphertext: tooShort, nonce: nonce, key: key)) { error in
            if let cryptoError = error as? E2ECrypto.Error {
                XCTAssertEqual(cryptoError, .decryptionFailed)
            }
        }
    }

    func testEmptyPlaintext() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = Data()
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)

        // Ciphertext should still contain the 16-byte Poly1305 tag even for empty plaintext.
        XCTAssertEqual(ciphertext.count, 16, "Empty plaintext should produce exactly a 16-byte tag")

        let decrypted = try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: key)
        XCTAssertEqual(decrypted, plaintext)
        XCTAssertTrue(decrypted.isEmpty)
    }

    func testLargePlaintext() throws {
        let key = SymmetricKey(size: .bits256)
        // 1 MB of random-ish data
        let plaintext = Data((0..<1_048_576).map { UInt8($0 & 0xFF) })
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)

        // Ciphertext = plaintext length + 16-byte tag
        XCTAssertEqual(ciphertext.count, plaintext.count + 16)

        let decrypted = try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: key)
        XCTAssertEqual(decrypted, plaintext)
    }

    func testNonceIs12Bytes() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = "nonce size check".data(using: .utf8)!
        let (nonce, _) = try E2ECrypto.encrypt(plaintext: plaintext, key: key)
        XCTAssertEqual(nonce.count, 12, "ChaChaPoly nonce must be 12 bytes")
    }

    // MARK: - Key Exchange

    func testGenerateKeyPairProducesUniqueKeys() {
        let key1 = E2ECrypto.generateKeyPair()
        let key2 = E2ECrypto.generateKeyPair()
        XCTAssertNotEqual(
            key1.publicKey.rawRepresentation,
            key2.publicKey.rawRepresentation,
            "Each generated key pair should be unique"
        )
    }

    func testKeyExchangeProducesSameSecret() throws {
        let aliceKey = E2ECrypto.generateKeyPair()
        let bobKey = E2ECrypto.generateKeyPair()

        let aliceSecret = try E2ECrypto.deriveSharedSecret(privateKey: aliceKey, peerPublicKey: bobKey.publicKey)
        let bobSecret = try E2ECrypto.deriveSharedSecret(privateKey: bobKey, peerPublicKey: aliceKey.publicKey)

        let aliceData = aliceSecret.withUnsafeBytes { Data($0) }
        let bobData = bobSecret.withUnsafeBytes { Data($0) }
        XCTAssertEqual(aliceData, bobData, "ECDH shared secrets should match for both parties")
    }

    func testKeyExchangeDifferentPeersProduceDifferentSecrets() throws {
        let alice = E2ECrypto.generateKeyPair()
        let bob = E2ECrypto.generateKeyPair()
        let charlie = E2ECrypto.generateKeyPair()

        let secretAB = try E2ECrypto.deriveSharedSecret(privateKey: alice, peerPublicKey: bob.publicKey)
        let secretAC = try E2ECrypto.deriveSharedSecret(privateKey: alice, peerPublicKey: charlie.publicKey)

        let dataAB = secretAB.withUnsafeBytes { Data($0) }
        let dataAC = secretAC.withUnsafeBytes { Data($0) }
        XCTAssertNotEqual(dataAB, dataAC, "Secrets with different peers should differ")
    }

    func testDerivedSecretIs256Bits() throws {
        let alice = E2ECrypto.generateKeyPair()
        let bob = E2ECrypto.generateKeyPair()
        let secret = try E2ECrypto.deriveSharedSecret(privateKey: alice, peerPublicKey: bob.publicKey)
        let keyData = secret.withUnsafeBytes { Data($0) }
        XCTAssertEqual(keyData.count, 32, "Derived key should be 256 bits (32 bytes)")
    }

    // MARK: - Channel ID

    func testDeriveChannelId() throws {
        let key = SymmetricKey(size: .bits256)
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: key)
        XCTAssertEqual(channelId.count, 32, "Channel ID should be 32 hex chars (16 bytes)")
        // Verify it is valid lowercase hexadecimal.
        let hexCharSet = CharacterSet(charactersIn: "0123456789abcdef")
        XCTAssertTrue(
            channelId.unicodeScalars.allSatisfy { hexCharSet.contains($0) },
            "Channel ID should be lowercase hex"
        )
    }

    func testDeriveChannelIdIsDeterministic() throws {
        let key = SymmetricKey(size: .bits256)
        let id1 = E2ECrypto.deriveChannelId(sharedSecret: key)
        let id2 = E2ECrypto.deriveChannelId(sharedSecret: key)
        XCTAssertEqual(id1, id2, "Same key should always produce the same channel ID")
    }

    func testDeriveChannelIdDiffersForDifferentKeys() {
        let key1 = SymmetricKey(size: .bits256)
        let key2 = SymmetricKey(size: .bits256)
        let id1 = E2ECrypto.deriveChannelId(sharedSecret: key1)
        let id2 = E2ECrypto.deriveChannelId(sharedSecret: key2)
        XCTAssertNotEqual(id1, id2, "Different keys should produce different channel IDs")
    }

    // MARK: - Cross key-exchange encryption

    func testCrossKeyExchangeEncryption() throws {
        // Full flow: key exchange -> derive secret -> encrypt -> decrypt
        let aliceKey = E2ECrypto.generateKeyPair()
        let bobKey = E2ECrypto.generateKeyPair()

        // Both sides derive the same shared secret.
        let aliceShared = try E2ECrypto.deriveSharedSecret(privateKey: aliceKey, peerPublicKey: bobKey.publicKey)
        let bobShared = try E2ECrypto.deriveSharedSecret(privateKey: bobKey, peerPublicKey: aliceKey.publicKey)

        // Alice encrypts a message.
        let message = "Top secret payload from Alice".data(using: .utf8)!
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: message, key: aliceShared)

        // Bob decrypts with his copy of the shared secret.
        let decrypted = try E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: bobShared)
        XCTAssertEqual(decrypted, message)

        // Channel IDs also match.
        let aliceChannel = E2ECrypto.deriveChannelId(sharedSecret: aliceShared)
        let bobChannel = E2ECrypto.deriveChannelId(sharedSecret: bobShared)
        XCTAssertEqual(aliceChannel, bobChannel)
    }

    func testBidirectionalEncryption() throws {
        // Both parties can send and receive.
        let alice = E2ECrypto.generateKeyPair()
        let bob = E2ECrypto.generateKeyPair()

        let sharedAlice = try E2ECrypto.deriveSharedSecret(privateKey: alice, peerPublicKey: bob.publicKey)
        let sharedBob = try E2ECrypto.deriveSharedSecret(privateKey: bob, peerPublicKey: alice.publicKey)

        // Alice -> Bob
        let msg1 = "Alice says hi".data(using: .utf8)!
        let (n1, ct1) = try E2ECrypto.encrypt(plaintext: msg1, key: sharedAlice)
        let dec1 = try E2ECrypto.decrypt(ciphertext: ct1, nonce: n1, key: sharedBob)
        XCTAssertEqual(dec1, msg1)

        // Bob -> Alice
        let msg2 = "Bob replies".data(using: .utf8)!
        let (n2, ct2) = try E2ECrypto.encrypt(plaintext: msg2, key: sharedBob)
        let dec2 = try E2ECrypto.decrypt(ciphertext: ct2, nonce: n2, key: sharedAlice)
        XCTAssertEqual(dec2, msg2)
    }
}

// MARK: - E2ECrypto.Error Equatable conformance for test assertions

extension E2ECrypto.Error: @retroactive Equatable {
    public static func == (lhs: E2ECrypto.Error, rhs: E2ECrypto.Error) -> Bool {
        switch (lhs, rhs) {
        case (.encryptionFailed, .encryptionFailed),
             (.decryptionFailed, .decryptionFailed),
             (.invalidNonceLength, .invalidNonceLength),
             (.keyAgreementFailed, .keyAgreementFailed):
            return true
        default:
            return false
        }
    }
}
