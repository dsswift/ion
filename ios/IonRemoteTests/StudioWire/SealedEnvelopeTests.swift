import XCTest
import CryptoKit
@testable import IonRemote

/// The Swift envelope against frames the TypeScript `sealRelayFrame` sealed
/// (`__fixtures__/sealed/relay-envelope.json`). The TypeScript test
/// `sealed-fixture.test.ts` opens the same file.
final class SealedEnvelopeTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Case: Decodable {
            let plaintext: String
            let envelope: String
        }
        struct AuthProof: Decodable {
            let nonce: String
            let proof: String
        }
        struct RelayProof: Decodable {
            let tagBytes: String
            let proof: String
        }
        let key: String
        let channelId: String
        let text: Case
        let binary: Case
        let doorbell: Case
        let authProof: AuthProof
        let relayProof: RelayProof
    }

    private func loadFixture() throws -> (Fixture, SymmetricKey) {
        let url = try StudioWireFixtures.directory("sealed").appendingPathComponent("relay-envelope.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let key = SymmetricKey(data: try XCTUnwrap(Data(base64Encoded: fixture.key)))
        return (fixture, key)
    }

    func testOpensATextFrameSealedByTypeScript() throws {
        let (fixture, key) = try loadFixture()
        let opened = try XCTUnwrap(SealedEnvelope.open(fixture.text.envelope, key: key))
        XCTAssertFalse(opened.isBinary)
        XCTAssertEqual(String(decoding: opened.bytes, as: UTF8.self), fixture.text.plaintext)
        guard case .event(let event) = try StudioFrame.decode(text: fixture.text.plaintext) else { return XCTFail("not an event") }
        XCTAssertEqual(event.channel, studioThinEventChannel)
    }

    func testOpensABinaryFrameSealedByTypeScriptAndHonorsItsFlag() throws {
        let (fixture, key) = try loadFixture()
        let opened = try XCTUnwrap(SealedEnvelope.open(fixture.binary.envelope, key: key))
        XCTAssertTrue(opened.isBinary)
        XCTAssertEqual(opened.bytes.base64EncodedString(), fixture.binary.plaintext)
        let frame = try StudioBinaryFrame.decode(opened.bytes)
        XCTAssertEqual(frame, StudioBinaryFrame(channel: .terminalData, key: "tab-1:inst-1", payload: Data([0, 1, 2, 253, 254, 255])))
    }

    func testOpensADoorbellEnvelopeDespiteItsPlaintextPushFields() throws {
        let (fixture, key) = try loadFixture()
        let opened = try XCTUnwrap(SealedEnvelope.open(fixture.doorbell.envelope, key: key))
        XCTAssertEqual(String(decoding: opened.bytes, as: UTF8.self), fixture.doorbell.plaintext)
    }

    func testWrongKeyTamperingAndNonEnvelopesReturnNil() throws {
        let (fixture, key) = try loadFixture()
        XCTAssertNil(SealedEnvelope.open(fixture.text.envelope, key: SymmetricKey(data: Data(repeating: 9, count: 32))))
        XCTAssertNil(SealedEnvelope.open("not json", key: key))
        XCTAssertNil(SealedEnvelope.open(#"{"type":"relay:peer-joined"}"#, key: key))
        XCTAssertNil(SealedEnvelope.open(#"{"v":2,"nonce":"AAAA","ciphertext":"AAAA"}"#, key: key))

        var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture.text.envelope.utf8)) as? [String: Any])
        envelope["bin"] = false
        let withFalseFlag = String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self)
        XCTAssertNil(SealedEnvelope.open(withFalseFlag, key: key), "bin is only ever absent or true")

        var ciphertext = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(envelope["ciphertext"] as? String)))
        ciphertext[0] ^= 0x01
        envelope["bin"] = nil
        envelope["ciphertext"] = ciphertext.base64EncodedString()
        let tampered = String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self)
        XCTAssertNil(SealedEnvelope.open(tampered, key: key))
    }

    func testSwiftSealOpensAgainAndHasTheWireShape() throws {
        let (_, key) = try loadFixture()
        let frame = try StudioFrame.snapshotRequest.encodedText()

        let sealedText = try SealedEnvelope.seal(text: frame, key: key)
        let textObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sealedText.utf8)) as? [String: Any])
        XCTAssertEqual(Set(textObject.keys), ["v", "nonce", "ciphertext"])
        XCTAssertEqual(textObject["v"] as? Int, 1)
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(textObject["nonce"] as? String))?.count, 12)
        XCTAssertFalse(sealedText.contains("studio_snapshot_request"))
        XCTAssertFalse(sealedText.contains("\\/"), "base64 must not be slash-escaped")
        XCTAssertEqual(SealedEnvelope.open(sealedText, key: key), .init(bytes: Data(frame.utf8), isBinary: false))

        let payload = Data([7, 7, 7])
        let sealedBinary = try SealedEnvelope.seal(binary: payload, key: key)
        let binaryObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sealedBinary.utf8)) as? [String: Any])
        XCTAssertEqual(Set(binaryObject.keys), ["v", "nonce", "ciphertext", "bin"])
        XCTAssertEqual(binaryObject["bin"] as? Bool, true)
        XCTAssertEqual(SealedEnvelope.open(sealedBinary, key: key), .init(bytes: payload, isBinary: true))
    }

    func testChannelIdAndHelloProofsMatchTypeScript() throws {
        let (fixture, key) = try loadFixture()
        XCTAssertEqual(E2ECrypto.deriveChannelId(sharedSecret: key), fixture.channelId)
        XCTAssertEqual(StudioAuthProof.proof(nonceBase64: fixture.authProof.nonce, secret: key), fixture.authProof.proof)
        XCTAssertEqual(StudioAuthProof.relayTagBytes.base64EncodedString(), fixture.relayProof.tagBytes)
        XCTAssertEqual(StudioAuthProof.relayProof(secret: key), fixture.relayProof.proof)
        XCTAssertNil(StudioAuthProof.proof(nonceBase64: "not base64!", secret: key))
    }
}
