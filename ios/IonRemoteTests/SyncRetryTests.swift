import XCTest
import CryptoKit
@testable import IonRemote

/// Pins the retryable reconnect sync handshake (TransportManager+Sync.swift).
///
/// Pre-fix the transport-level sync was single-shot: one `.sync` when the
/// relay flipped connected, with failures only printed. Combined with the
/// ViewModel-level sync deferring while `.reconnecting` (and `.connected`
/// requiring a snapshot, which requires the sync), a single failed send could
/// deadlock the session in `.reconnecting` forever.
final class SyncRetryTests: XCTestCase {

    private func makeManager() -> TransportManager {
        TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: SymmetricKey(size: .bits256)
        )
    }

    /// With no transport available every send fails; the handshake must retry
    /// the configured number of times, then give up and report failure (it
    /// must not throw, hang, or stop after the first failed send).
    func testRetriesExhaustAndReportFailure() async {
        let m = makeManager() // no LAN, no relay connection -> sends throw
        let start = Date()
        let ok = await m.sendSyncWithRetry(reason: "test", attempts: 3, initialDelaySeconds: 0.01)
        XCTAssertFalse(ok, "With no snapshot ever arriving the handshake must report failure")
        // Three backoff sleeps (0.01 + 0.02 + 0.04) prove it retried rather
        // than returning after the first failure.
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(start), 0.06,
            "The handshake must back off between attempts, not fail fast once")
    }

    /// A snapshot arriving mid-handshake satisfies it: the retry loop stops
    /// and reports success even though the sends themselves keep failing.
    func testSnapshotArrivalStopsRetrying() async {
        let m = makeManager()
        let handshake = Task {
            await m.sendSyncWithRetry(reason: "test", attempts: 50, initialDelaySeconds: 0.02)
        }
        // Let the first attempt start, then simulate the desktop answering.
        try? await Task.sleep(for: .milliseconds(30))
        m.lastSnapshotReceivedAt = Date()

        let ok = await handshake.value
        XCTAssertTrue(ok, "A snapshot arriving during the handshake must satisfy it")
    }

    /// The receive path records snapshot arrival for the handshake to observe.
    func testSnapshotFrameUpdatesLastSnapshotReceivedAt() throws {
        let sharedKey = SymmetricKey(size: .bits256)
        let m = TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: sharedKey
        )
        XCTAssertEqual(m.lastSnapshotReceivedAt, .distantPast, "precondition")

        // Minimal valid desktop_snapshot payload, encrypted like a live frame.
        let json = #"{"type":"desktop_snapshot","tabs":[],"recentDirectories":[]}"#
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: Data(json.utf8), key: sharedKey)
        let wire = WireMessage(
            seq: 1,
            ts: nil,
            payload: nil,
            nonce: nonce.base64EncodedString(),
            ciphertext: ciphertext.base64EncodedString()
        )
        m.handleIncomingData(try JSONEncoder().encode(wire), isRelay: true)

        XCTAssertGreaterThan(m.lastSnapshotReceivedAt, Date.distantPast,
            "Decoding a snapshot frame must record its arrival time for the sync handshake")
    }
}
