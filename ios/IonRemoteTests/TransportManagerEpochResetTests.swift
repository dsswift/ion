import XCTest
import CryptoKit
@testable import IonRemote

/// Tests for the outbound-seq epoch handling in TransportManager (RC-3 + the
/// lockstep epoch-only-reset fix).
///
/// Epochs are time-seeded ms and monotonic per peer process generation, so the
/// inbound compare is ordered, not equality:
///  - NEWER epoch: the desktop's outbound seq space restarted (process restart
///    or stop()+recreate) — reset `lastReceivedSeq`/`pendingResendSeqs` and
///    adopt, so the fresh seq=1 stream is accepted instead of deduped as stale.
///  - OLDER epoch: a late frame from a dead desktop generation — dropped
///    entirely, never adopted (the old `!=` logic flapped the tracker on
///    alternating old/new frames, resetting the dedup repeatedly).
///  - EQUAL: normal seq dedup. The check runs BEFORE the seq comparison.
///
/// The epoch is also the ONLY reset trigger: LAN (re)auth and relay
/// peer-reconnected no longer zero any seq state, and every outbound frame
/// carries this instance's `outboundEpoch` so the desktop can apply the same
/// monotonic logic inbound.
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

    // MARK: - Monotonic compare (B4)

    /// A frame from a STALE (older) epoch is dropped entirely: not processed,
    /// epoch not adopted. On the unfixed `!=` code the stale frame reset the
    /// dedup AND adopted the dead epoch.
    func testStaleEpochFrameIsDroppedAndNotAdopted() throws {
        let m = makeManager()

        // Current generation: epoch 200, seq up to 10.
        m.handleIncomingData(try frame(seq: 10, epoch: 200), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 10)
        XCTAssertEqual(m.lastReceivedEpoch, 200)

        // Late frame from the dead generation (epoch 100) with a high seq.
        // Must be dropped: no processing (mark unchanged), no adoption.
        m.handleIncomingData(try frame(seq: 999, epoch: 100), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 10,
            "a stale-epoch frame must not be processed — its seq must not poison the mark")
        XCTAssertEqual(m.lastReceivedEpoch, 200,
            "a stale epoch must never be adopted")
    }

    /// Alternating old/new-epoch frames (old socket draining during a desktop
    /// restart) cause exactly ONE reset. The old `!=` logic adopted every
    /// difference, so each alternation reset the dedup again — flapping.
    func testAlternatingEpochsCauseExactlyOneReset() throws {
        let m = makeManager()

        // Old generation established a high mark.
        m.handleIncomingData(try frame(seq: 50, epoch: 100), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 50)

        // New generation arrives: ONE reset, seq restarts.
        m.handleIncomingData(try frame(seq: 1, epoch: 200), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 1)

        // Straggler from the old socket: dropped, no adoption.
        m.handleIncomingData(try frame(seq: 51, epoch: 100), isRelay: false)
        XCTAssertEqual(m.lastReceivedEpoch, 200)
        XCTAssertEqual(m.lastReceivedSeq, 1)

        // Next new-generation frame is EQUAL epoch — must NOT reset again
        // (on the `!=` code the straggler adopted 100, so this frame's 200
        // triggered a second reset).
        m.handleIncomingData(try frame(seq: 2, epoch: 200), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 2,
            "equal epoch is the normal path — seq advances, no reset flap")
    }

    /// A newer epoch also clears the pending-resend set — the dead
    /// generation's gap-recovery ranges can never be filled.
    func testNewerEpochClearsPendingResendSeqs() throws {
        let m = makeManager()
        m.handleIncomingData(try frame(seq: 50, epoch: 100), isRelay: false)
        m.pendingResendSeqs = [40, 41, 42]

        m.handleIncomingData(try frame(seq: 1, epoch: 200), isRelay: false)
        XCTAssertTrue(m.pendingResendSeqs.isEmpty,
            "a new desktop generation invalidates the old generation's pending resend range")
    }

    // MARK: - Epoch is the ONLY reset trigger (B1)

    /// relay:peer-reconnected must NOT zero lastReceivedSeq. The desktop's
    /// outbound seq is continuous across relay reconnects of the same
    /// process; a real restart announces itself with a newer epoch.
    func testPeerReconnectedDoesNotResetDedup() throws {
        let m = makeManager()
        m.lastReceivedSeq = 42

        let json = #"{"type":"relay:peer-reconnected"}"#
        m.handleIncomingData(Data(json.utf8), isRelay: true)

        XCTAssertEqual(m.lastReceivedSeq, 42,
            "peer-reconnected must not reset the dedup — only a newer epoch does")
    }

    /// LAN connection activation (the post-auth path of startLANWithAuth)
    /// must NOT zero lastReceivedSeq or the outbound seq counter.
    func testLANActivationDoesNotResetSeqState() async throws {
        let m = makeManager()
        m.lastReceivedSeq = 42
        m._seqLock.withLock { state in state = 7 }

        await m.activateLANConnection(host: "192.168.1.10", port: 8422)

        XCTAssertEqual(m.lastReceivedSeq, 42,
            "LAN activation must not zero the inbound dedup — gap detection would be disabled during the switch")
        XCTAssertEqual(m._seqLock.withLock { $0 }, 7,
            "outbound seq stays continuous for the life of the instance — the epoch identifies the generation")
        m.stop()
    }

    // MARK: - Outbound epoch (B2)

    /// Every outbound WireMessage carries this instance's outboundEpoch, and
    /// it round-trips through the Codable wire shape.
    func testOutboundWireMessageCarriesInstanceEpoch() throws {
        let m = makeManager()

        let wire1 = try m.buildWireMessage(payload: Data("{}".utf8))
        let wire2 = try m.buildWireMessage(payload: Data("{}".utf8))
        XCTAssertEqual(wire1.epoch, m.outboundEpoch,
            "every outbound frame must be stamped with the instance epoch")
        XCTAssertEqual(wire2.epoch, m.outboundEpoch,
            "the epoch is stable across frames within one instance")
        XCTAssertEqual(wire2.seq, wire1.seq + 1, "outbound seq stays contiguous")

        // Encode → decode: the epoch must survive the wire (encode, not just
        // decode — the desktop reads it from the serialized JSON).
        let data = try JSONEncoder().encode(wire1)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["epoch"] as? Double, m.outboundEpoch,
            "epoch must be present in the encoded JSON the desktop receives")
    }

    /// Distinct TransportManager instances carry distinct, increasing epochs
    /// (time-seeded ms) — that ordering is what makes the desktop's monotonic
    /// compare meaningful.
    func testFreshInstanceCarriesNewerEpoch() throws {
        let m1 = makeManager()
        // Guarantee a clock tick so the ms-seeded epochs differ.
        Thread.sleep(forTimeInterval: 0.002)
        let m2 = makeManager()
        XCTAssertGreaterThan(m2.outboundEpoch, m1.outboundEpoch,
            "a newer instance must carry a strictly larger epoch")
    }
}
