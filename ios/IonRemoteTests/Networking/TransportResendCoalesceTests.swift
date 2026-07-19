import XCTest
import CryptoKit
@testable import IonRemote

/// WI-6: the resend-request debounce must coalesce, not drop.
///
/// The old debounce was leading-edge only: gap A sent immediately; gap B
/// arriving inside the 150ms window inserted its seqs into
/// `pendingResendSeqs` and returned — no trailing retry ever fired, so gap B
/// stayed unhealed until the (slow) snapshot reconcile. The fix schedules ONE
/// trailing task that sleeps out the remaining window and sends a single
/// merged request covering `pendingResendSeqs.min()...max()`.
///
/// Red-on-unfixed proof: `send(_:)` bumps the outbound seq counter
/// (`_seqLock`, via `buildWireMessage`) BEFORE it checks transport
/// availability, so even with no connected transport every attempted resend
/// request has an observable side effect. Gap A bumps the counter to 1. On
/// the unfixed code gap B never sends — the counter stays at 1 and
/// `testSecondGapInsideWindowYieldsTrailingCoalescedRequest` fails. On the
/// fixed code the trailing task sends the merged request and the counter
/// reaches 2.
final class TransportResendCoalesceTests: XCTestCase {

    private func makeManager() -> TransportManager {
        TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: SymmetricKey(size: .bits256)
        )
    }

    private func outboundSeq(_ m: TransportManager) -> UInt64 {
        m._seqLock.withLock { $0 }
    }

    /// Poll until the outbound seq counter reaches `target` (each attempted
    /// send bumps it exactly once) or the deadline passes.
    private func waitForOutboundSeq(_ m: TransportManager, toReach target: UInt64, timeout: TimeInterval = 3.0) async throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if outboundSeq(m) >= target { return true }
            try await Task.sleep(for: .milliseconds(20))
        }
        return outboundSeq(m) >= target
    }

    func testSecondGapInsideWindowYieldsTrailingCoalescedRequest() async throws {
        let m = makeManager()
        // Widen the window so the 100ms inter-gap delay lands inside it
        // deterministically even under CI scheduling jitter.
        m.resendDebounceInterval = 0.4

        // Gap A: leading edge — sends immediately.
        m.requestResendForGap(fromSeq: 5, toSeq: 8)
        let sentA = try await waitForOutboundSeq(m, toReach: 1)
        XCTAssertTrue(sentA, "gap A must send a resend request immediately (leading edge)")

        // Gap B ~100ms later: inside the window.
        try await Task.sleep(for: .milliseconds(100))
        m.requestResendForGap(fromSeq: 15, toSeq: 18)

        // On the unfixed code nothing more ever sends: the counter stays 1.
        let sentB = try await waitForOutboundSeq(m, toReach: 2)
        XCTAssertTrue(sentB,
            "gap B inside the debounce window must yield a trailing coalesced request; " +
            "the leading-edge-only debounce silently dropped it")

        // The trailing request must cover BOTH still-missing ranges merged:
        // pendingResendSeqs.min()...max() = 5...18.
        // Drain the inbound queue first: the trailing task records the range
        // on the queue before dispatching the send.
        try await m.inboundQueue.enqueue { }
        XCTAssertEqual(m.lastResendRequestedRange, UInt64(5)...UInt64(18),
            "coalesced request must span the merged still-missing range")
        // Both gaps' seqs are tracked for replay acceptance.
        XCTAssertEqual(m.pendingResendSeqs, Set(5...8).union(Set(15...18)))
    }

    /// Several gaps inside one window schedule exactly ONE trailing task —
    /// one merged request, not one per gap.
    func testMultipleGapsInsideWindowCoalesceToOneRequest() async throws {
        let m = makeManager()
        m.resendDebounceInterval = 0.4

        m.requestResendForGap(fromSeq: 5, toSeq: 6)   // leading edge -> seq 1
        _ = try await waitForOutboundSeq(m, toReach: 1)
        m.requestResendForGap(fromSeq: 10, toSeq: 11) // in window -> trailing
        m.requestResendForGap(fromSeq: 20, toSeq: 21) // in window -> same trailing
        m.requestResendForGap(fromSeq: 30, toSeq: 31) // in window -> same trailing

        _ = try await waitForOutboundSeq(m, toReach: 2)
        try await m.inboundQueue.enqueue { }
        XCTAssertEqual(m.lastResendRequestedRange, UInt64(5)...UInt64(31),
            "one merged trailing request covering min...max of everything still missing")

        // No third request sneaks out after the window: give any (wrong)
        // extra task time to fire, then confirm the counter stopped at 2.
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(outboundSeq(m), 2,
            "exactly one trailing coalesced request per window — never one per gap")
    }

    /// A gap after the window has fully elapsed is a fresh leading edge.
    func testGapAfterWindowSendsImmediately() async throws {
        let m = makeManager()
        m.resendDebounceInterval = 0.15

        m.requestResendForGap(fromSeq: 5, toSeq: 8)
        _ = try await waitForOutboundSeq(m, toReach: 1)
        try await Task.sleep(for: .milliseconds(250)) // window elapsed
        m.requestResendForGap(fromSeq: 15, toSeq: 18)
        let sent = try await waitForOutboundSeq(m, toReach: 2)
        XCTAssertTrue(sent, "post-window gap sends on the leading edge")
        XCTAssertEqual(m.lastResendRequestedRange, UInt64(15)...UInt64(18),
            "post-window request covers just the new gap (not a merged span)")
    }
}
