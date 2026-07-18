import XCTest
import CryptoKit
@testable import IonRemote

/// Tests for the outbound-seq epoch reset in TransportManager+Receive (RC-3).
///
/// A changed WireMessage.epoch means the desktop's outbound seq space restarted
/// (desktop process restart, or an in-process stop()+recreate): its seqs are
/// back at 1 and its retransmit buffer is empty. iOS must reset its receive
/// dedup high-water (`lastReceivedSeq`) and pending-resend set on an epoch change
/// so the fresh seq=1 stream is accepted instead of being deduped as stale. The
/// check runs BEFORE the seq comparison and only on a real change.
final class TransportManagerEpochResetTests: XCTestCase {

    private let key = SymmetricKey(size: .bits256)

    private func makeManager() -> TransportManager {
        TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: key
        )
    }

    /// Build an encrypted WireMessage frame carrying `epoch` and a heartbeat
    /// payload (a payload type the receive path processes without needing a full
    /// snapshot). The epoch check runs before decrypt, so any valid frame drives
    /// it; a heartbeat keeps the rest of the path side-effect-light.
    private func frame(seq: UInt64, epoch: Double?) throws -> Data {
        let payload = #"{"type":"desktop_heartbeat","ts":0,"buffered":0}"#
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: Data(payload.utf8), key: key)
        var obj: [String: Any] = [
            "seq": seq,
            "ts": 0,
            "nonce": nonce.base64EncodedString(),
            "ciphertext": ciphertext.base64EncodedString(),
        ]
        if let epoch { obj["epoch"] = epoch }
        return try JSONSerialization.data(withJSONObject: obj)
    }

    /// A changed epoch resets lastReceivedSeq so a fresh low seq is accepted.
    func testEpochChangeResetsDedupHighWater() throws {
        let m = makeManager()

        // First epoch-bearing frame seeds the tracker (no reset). seq 50.
        m.handleIncomingData(try frame(seq: 50, epoch: 100), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 50, "first epoch frame processes normally and advances the mark")

        // Desktop restart: new epoch, seq back to 1. Without the reset this frame
        // would be dropped (1 <= 50) and never advance the mark.
        m.handleIncomingData(try frame(seq: 1, epoch: 200), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 1,
            "an epoch change must reset the dedup high-water so the fresh seq=1 stream is accepted")
    }

    /// The same epoch across frames does NOT reset — normal dedup still applies.
    func testSameEpochDoesNotReset() throws {
        let m = makeManager()

        m.handleIncomingData(try frame(seq: 10, epoch: 100), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 10)

        // Same epoch, a lower seq is a genuine duplicate and must be dropped
        // (mark unchanged) — the epoch reset must not fire.
        m.handleIncomingData(try frame(seq: 5, epoch: 100), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 10,
            "same epoch keeps normal dedup: a lower seq is dropped, not reset")
    }

    /// A frame with no epoch (desktop predating the field) never triggers a reset.
    func testMissingEpochPreservesLegacyBehavior() throws {
        let m = makeManager()
        m.lastReceivedSeq = 30

        // No epoch field: legacy desktop. A lower seq stays deduped.
        m.handleIncomingData(try frame(seq: 5, epoch: nil), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 30,
            "absent epoch must not reset the mark (legacy desktop behavior preserved)")
    }
}
