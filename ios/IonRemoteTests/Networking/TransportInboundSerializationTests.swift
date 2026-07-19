import XCTest
import CryptoKit
@testable import IonRemote

/// WI-7: single-consumer inbound serialization.
///
/// `handleIncomingData` used to be called directly from BOTH the relay listen
/// task and the LAN listen task, mutating `lastReceivedSeq`,
/// `pendingResendSeqs` (a Set — memory-unsafe under concurrent mutation),
/// `lastReceivedEpoch`, and the clock-skew/heartbeat state with zero
/// synchronization. The fix routes both listeners through
/// `enqueueIncomingData`, which enqueues the raw bytes onto the strict-FIFO
/// `inboundQueue`; the queue consumer runs `handleIncomingData` one frame at
/// a time.
///
/// This test hammers `enqueueIncomingData` from two concurrent tasks — one
/// injecting sequential encrypted data frames (the LAN shape), one injecting
/// plaintext `auth_result` frames (the relay-origin injection shape) — and
/// asserts every data frame was processed, applied in enqueue order (FIFO
/// preserved per transport), with no crash and no corrupted dedup state.
final class TransportInboundSerializationTests: XCTestCase {

    private func encryptedEventFrame(seq: UInt64, fromSeq: UInt64, key: SymmetricKey) throws -> Data {
        let json = #"{"type":"desktop_resend_unavailable","fromSeq":\#(fromSeq)}"#
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: Data(json.utf8), key: key)
        let wire = WireMessage(
            seq: seq,
            ts: nil,
            payload: nil,
            nonce: nonce.base64EncodedString(),
            ciphertext: ciphertext.base64EncodedString()
        )
        return try JSONEncoder().encode(wire)
    }

    func testConcurrentInjectionIsSerializedAndOrdered() async throws {
        let sharedKey = SymmetricKey(size: .bits256)
        let m = TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: sharedKey
        )

        let frameCount: UInt64 = 200

        // Pre-build all frames so the concurrent tasks do no crypto work and
        // interleave as tightly as possible.
        var dataFrames: [Data] = []
        for i in 1...frameCount {
            dataFrames.append(try encryptedEventFrame(seq: i, fromSeq: i, key: sharedKey))
        }
        // Plaintext auth_result frames (seq 0: no dedup interaction) — these
        // exercise the receive path from the second task, including the
        // plaintext-auth_result ignore branch, concurrently with data frames.
        let injected = WireMessage(
            seq: 0,
            ts: nil,
            payload: #"{"type":"auth_result","success":false}"#
        )
        let injectedData = try JSONEncoder().encode(injected)

        // Collect every yielded event so ordering can be asserted. Start the
        // (single) consumer before injecting.
        let collector = Task { () -> [UInt64] in
            var seen: [UInt64] = []
            for await event in m.events {
                if case .resendUnavailable(let fromSeq) = event {
                    seen.append(fromSeq)
                    if seen.count == Int(frameCount) { break }
                }
                if case .peerDisconnected = event {
                    XCTFail("plaintext auth_result must never yield peerDisconnected")
                }
            }
            return seen
        }

        // Two concurrent producers, mirroring the two listener tasks.
        async let lanSide: Void = {
            for frame in dataFrames {
                m.enqueueIncomingData(frame, isRelay: false)
            }
        }()
        async let relaySide: Void = {
            for _ in 1...frameCount {
                m.enqueueIncomingData(injectedData, isRelay: true)
            }
        }()
        _ = await (lanSide, relaySide)

        // Drain: wait for the queue to finish everything enqueued above.
        try await m.inboundQueue.enqueue { }

        let seen = await collector.value
        XCTAssertEqual(seen.count, Int(frameCount), "every data frame must be processed")
        XCTAssertEqual(seen, Array(1...frameCount).map { UInt64($0) },
            "frames must apply in per-transport enqueue order (FIFO serialization)")
        XCTAssertEqual(m.lastReceivedSeq, frameCount)
        XCTAssertTrue(m.pendingResendSeqs.isEmpty,
            "sequential frames leave no gap state; corruption here means racing mutation")
    }

    /// `enqueueIncomingData` must be the listeners' ingress — a frame enqueued
    /// through it produces the same observable outcome as a direct
    /// `handleIncomingData` call (pins that the queue actually runs the handler).
    func testEnqueueProcessesFrame() async throws {
        let sharedKey = SymmetricKey(size: .bits256)
        let m = TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: sharedKey
        )
        let frame = try encryptedEventFrame(seq: 7, fromSeq: 7, key: sharedKey)
        m.enqueueIncomingData(frame, isRelay: false)
        try await m.inboundQueue.enqueue { }
        XCTAssertEqual(m.lastReceivedSeq, 7)
    }
}
