import XCTest
import CryptoKit
@testable import IonRemote

/// Pins the fix for the relay data blackhole: relay-delivered data frames are
/// PROCESSED while state is `.lanPreferred` (the desktop delivers each frame
/// via exactly one transport, so a relay frame during lanPreferred is real
/// data behind a half-open LAN socket), and `lastReceivedSeq` advances only
/// for frames that are actually applied.
///
/// Pre-fix, `handleIncomingData` advanced `lastReceivedSeq` and THEN dropped
/// every relay data frame in `.lanPreferred` — permanently blackholing
/// snapshots, deltas, resend replays, and heartbeats.
final class TransportRelayLanPreferredTests: XCTestCase {

    private let sharedKey = SymmetricKey(size: .bits256)

    private func makeManager() -> TransportManager {
        TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: sharedKey
        )
    }

    /// Encrypt a payload the way live frames arrive on the wire.
    private func encryptedFrame(seq: UInt64, json: String) throws -> Data {
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: Data(json.utf8), key: sharedKey)
        let wire = WireMessage(
            seq: seq,
            ts: Date().timeIntervalSince1970 * 1000,
            payload: nil,
            nonce: nonce.base64EncodedString(),
            ciphertext: ciphertext.base64EncodedString()
        )
        return try JSONEncoder().encode(wire)
    }

    /// Collect yielded events from the manager's single-consumer stream.
    private func startCollector(_ m: TransportManager) -> OSAllocatedUnfairLockBox<[RemoteEvent]> {
        let box = OSAllocatedUnfairLockBox<[RemoteEvent]>([])
        Task {
            for await event in m.events {
                box.mutate { $0.append(event) }
            }
        }
        return box
    }

    private func waitForEvents(
        _ box: OSAllocatedUnfairLockBox<[RemoteEvent]>,
        count: Int,
        timeout: TimeInterval = 2.0
    ) async -> [RemoteEvent] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if box.value.count >= count { return box.value }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return box.value
    }

    // MARK: - Fix 1: relay data frames are applied in .lanPreferred

    func testRelayDataFrameProcessedWhileLanPreferred() async throws {
        let m = makeManager()
        let events = startCollector(m)
        m.setState(.lanPreferred)

        let frame = try encryptedFrame(seq: 1, json: #"{"type":"desktop_tab_closed","tabId":"tab-1"}"#)
        m.handleIncomingData(frame, isRelay: true)

        let received = await waitForEvents(events, count: 1)
        guard case .tabClosed(let tabId)? = received.first else {
            return XCTFail("Relay data frame in .lanPreferred must be applied, got \(received)")
        }
        XCTAssertEqual(tabId, "tab-1")
        XCTAssertEqual(m.lastReceivedSeq, 1, "Processed frame must advance the dedup mark")
    }

    /// Relay-delivered heartbeats are handled (yielded) in `.lanPreferred` —
    /// they used to be dropped along with everything else — but they must NOT
    /// feed the LAN liveness watchdog: a relay heartbeat proves the relay
    /// works, not the LAN socket.
    func testRelayHeartbeatHandledButDoesNotFeedLanWatchdog() async throws {
        let m = makeManager()
        let events = startCollector(m)
        m.setState(.lanPreferred) // arms the watchdog, baselining lastHeartbeatAt
        let baseline = m.lastHeartbeatAt

        let frame = try encryptedFrame(seq: 1, json: #"{"type":"desktop_heartbeat","ts":1000,"buffered":0}"#)
        m.handleIncomingData(frame, isRelay: true)

        let received = await waitForEvents(events, count: 1)
        guard case .heartbeat? = received.first else {
            return XCTFail("Relay heartbeat in .lanPreferred must be handled, got \(received)")
        }
        XCTAssertEqual(m.lastReceivedSeq, 1, "Heartbeat frame must advance the dedup mark")
        XCTAssertEqual(m.lastHeartbeatAt, baseline,
            "A relay-delivered heartbeat must not refresh the LAN watchdog clock")
    }

    /// A LAN-delivered heartbeat DOES feed the watchdog clock.
    func testLanHeartbeatFeedsWatchdogClock() async throws {
        let m = makeManager()
        _ = startCollector(m)
        m.setState(.lanPreferred)
        let baseline = m.lastHeartbeatAt

        try? await Task.sleep(for: .milliseconds(20))
        let frame = try encryptedFrame(seq: 1, json: #"{"type":"desktop_heartbeat","ts":1000,"buffered":0}"#)
        m.handleIncomingData(frame, isRelay: false)

        XCTAssertGreaterThan(m.lastHeartbeatAt, baseline,
            "A LAN-delivered heartbeat must refresh the LAN watchdog clock")
    }

    // MARK: - Dedup mark advances only for processed frames

    /// A frame that fails to decrypt must NOT advance `lastReceivedSeq`.
    /// Pre-fix the mark advanced before the drop, permanently blackholing the
    /// frame's content (a later resend replay would be deduped away).
    func testFailedDecryptDoesNotAdvanceDedupMark() throws {
        let m = makeManager()
        let wire = WireMessage(
            seq: 5,
            ts: nil,
            payload: nil,
            nonce: Data(repeating: 1, count: 12).base64EncodedString(),
            ciphertext: Data(repeating: 2, count: 32).base64EncodedString() // garbage
        )
        let data = try JSONEncoder().encode(wire)

        m.handleIncomingData(data, isRelay: true)

        XCTAssertEqual(m.lastReceivedSeq, 0,
            "A dropped (undecryptable) frame must not advance the dedup mark")
    }

    /// Cross-transport dedup still holds: the same seq delivered twice is
    /// applied exactly once.
    func testDuplicateFrameStillDropped() async throws {
        let m = makeManager()
        let events = startCollector(m)
        m.setState(.lanPreferred)

        let frame = try encryptedFrame(seq: 1, json: #"{"type":"desktop_tab_closed","tabId":"dup"}"#)
        m.handleIncomingData(frame, isRelay: false)
        m.handleIncomingData(frame, isRelay: true) // duplicate via other transport

        let received = await waitForEvents(events, count: 1)
        // Give the (incorrect) second event a moment to surface if it exists.
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(events.value.count, 1,
            "The same seq arriving on both transports must be applied exactly once, got \(received.count)+")
    }
}
