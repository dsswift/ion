import XCTest
import CryptoKit
@testable import IonRemote

/// The `paired` credential's proof is an HMAC over the nonce BYTES, so both
/// sides must decode the nonce string the same way. The server mints it with
/// `randomBytes(32).toString('base64url')` and verifies with `Buffer.from(n,
/// 'base64')`, which in Node accepts the URL alphabet and missing padding.
/// Swift's decoder accepts neither, so every nonce containing `-` or `_`
/// failed here — and the direct LAN route failed its handshake with it, while
/// the relay, which uses no nonce, kept working and hid the defect.
final class StudioAuthProofTests: XCTestCase {

    private let secret = SymmetricKey(data: Data(repeating: 7, count: 32))

    /// A real nonce this server served, chosen because it carries a `-` and
    /// no padding: exactly the shape Swift's strict decoder rejects.
    func testProofIsProducedForABase64URLNonce() {
        let nonce = "WLJvZMuBCqUzFMzdtLvUZ4fzQEqVx3xSOnxNz6Jga-c"
        XCTAssertNotNil(StudioAuthProof.proof(nonceBase64: nonce, secret: secret),
                        "a base64url nonce must produce a proof, not nil")
    }

    /// Both alphabets must decode to the SAME bytes, or the proof would be
    /// computed over something the server never hashed.
    func testBothAlphabetsDecodeToTheSameBytes() throws {
        let standard = "+/+/AAAA"
        let urlSafe = "-_-_AAAA"
        let a = try XCTUnwrap(StudioAuthProof.decodeBase64OrURL(standard))
        let b = try XCTUnwrap(StudioAuthProof.decodeBase64OrURL(urlSafe))
        XCTAssertEqual(a, b)
    }

    func testUnpaddedInputIsAccepted() throws {
        // 43 chars: 32 bytes, unpadded, which is what the server mints.
        let unpadded = String(repeating: "A", count: 43)
        let decoded = try XCTUnwrap(StudioAuthProof.decodeBase64OrURL(unpadded))
        XCTAssertEqual(decoded.count, 32)
    }

    func testGarbageIsStillRejected() {
        XCTAssertNil(StudioAuthProof.decodeBase64OrURL("not base64 at all !!"))
        XCTAssertNil(StudioAuthProof.proof(nonceBase64: "not base64 at all !!", secret: secret))
    }
}
