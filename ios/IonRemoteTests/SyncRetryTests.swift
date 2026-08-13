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

    /// stop() owns the handshake lifetime. Once stopped, the task must cancel
    /// promptly and no replacement handshake may be started on that manager.
    func testStopCancelsOwnedHandshake() async {
        let m = makeManager()
        m.startSyncHandshake(reason: "test-stop")
        XCTAssertNotNil(m.syncHandshakeTask, "the transport must retain active sync work")

        try? await Task.sleep(for: .milliseconds(20))
        m.stop()

        XCTAssertTrue(m.isStopped)
        XCTAssertNil(m.syncHandshakeTask, "stop must release the owned handshake")
        let outboundAtStop = m._seqLock.withLock { $0 }
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(m._seqLock.withLock { $0 }, outboundAtStop,
            "a stopped transport must not make further sync attempts")

        m.startSyncHandshake(reason: "after-stop")
        XCTAssertNil(m.syncHandshakeTask,
            "a stopped transport must refuse new handshake work")
    }

    /// A newer sync reason replaces the old task rather than stacking another
    /// retry loop. The generation token prevents the cancelled predecessor from
    /// clearing the replacement when it unwinds.
    func testNewHandshakeSupersedesPriorOwnedTask() async {
        let m = makeManager()
        m.startSyncHandshake(reason: "first")
        let firstGeneration = m.syncHandshakeGeneration

        m.startSyncHandshake(reason: "second")

        XCTAssertGreaterThan(m.syncHandshakeGeneration, firstGeneration)
        XCTAssertNotNil(m.syncHandshakeTask)
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertNotNil(m.syncHandshakeTask,
            "the cancelled predecessor must not clear the current handshake")
        m.stop()
    }

    /// A sync operation already queued behind another outbound operation must
    /// re-check stop inside the queue before allocating its sequence number.
    func testStoppedTransportRejectsQueuedSyncBeforeSeqAllocation() async throws {
        let m = makeManager()
        let blockerReady = OSAllocatedUnfairLockBox(false)
        let releaseBlocker = OSAllocatedUnfairLockBox(false)
        let blocker = m.outboundQueue.submit {
            blockerReady.mutate { $0 = true }
            while !releaseBlocker.value {
                try? await Task.sleep(for: .milliseconds(2))
            }
        }
        while !blockerReady.value {
            try? await Task.sleep(for: .milliseconds(2))
        }

        m.startSyncHandshake(reason: "queued-stop")
        try? await Task.sleep(for: .milliseconds(10))
        m.stop()
        let outboundAtStop = m._seqLock.withLock { $0 }
        releaseBlocker.mutate { $0 = true }
        _ = try await blocker.value
        try? await Task.sleep(for: .milliseconds(30))

        XCTAssertEqual(m._seqLock.withLock { $0 }, outboundAtStop,
            "queued work must observe stop before building a wire message")
    }

    /// Concurrent triggers must leave exactly the newest generation owned, and
    /// stop must atomically prevent any trigger from installing more work.
    func testConcurrentHandshakeTriggersCannotEscapeStop() async {
        let m = makeManager()
        await withTaskGroup(of: Void.self) { group in
            for index in 0..<20 {
                group.addTask { m.startSyncHandshake(reason: "race-\(index)") }
            }
        }
        XCTAssertNotNil(m.syncHandshakeTask)

        await withTaskGroup(of: Void.self) { group in
            group.addTask { m.stop() }
            for index in 0..<20 {
                group.addTask { m.startSyncHandshake(reason: "after-stop-\(index)") }
            }
        }

        XCTAssertTrue(m.isStopped)
        XCTAssertNil(m.syncHandshakeTask)
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
