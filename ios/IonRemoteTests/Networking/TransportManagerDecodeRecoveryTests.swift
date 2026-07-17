import XCTest
import CryptoKit
@testable import IonRemote

/// Regression test for the silent-drop-on-decode-failure bug.
///
/// Before the fix, `handleIncomingData` logged a `DECODE-ERR` line and then
/// `return`ed, leaving iOS frozen in stale state whenever a frame decrypted
/// and decompressed cleanly but produced JSON that `RemoteEvent` could not
/// decode. Nothing requested a resync, so the missed state never healed.
///
/// The fix issues a `send(.sync)` before returning so the desktop replies with
/// a fresh snapshot and iOS self-heals.
///
/// How this test proves the fix (and fails on the unfixed code):
/// `send(_:)` calls `buildWireMessage(payload:)` — which increments the
/// outbound sequence counter (`_seqLock`) and encrypts — BEFORE it checks
/// transport availability and throws `noTransportAvailable`. So even with no
/// connected transport, a triggered `send(.sync)` has one observable side
/// effect: the outbound seq counter moves from 0 to 1. On the unfixed code no
/// send is issued, so the counter stays at 0 and the assertion fails.
final class TransportManagerDecodeRecoveryTests: XCTestCase {

    /// Read the current outbound sequence counter. `send(_:)` -> `buildWireMessage`
    /// bumps this before any transport check, so a nonzero value proves a send
    /// was attempted.
    private func outboundSeq(_ m: TransportManager) -> UInt64 {
        m._seqLock.withLock { $0 }
    }

    @MainActor
    func testDecodeFailureRequestsResync() async throws {
        let sharedKey = SymmetricKey(size: .bits256)
        // LAN-only init (no relay); there is no connected socket, so the
        // triggered send(.sync) will throw noTransportAvailable AFTER it has
        // already bumped the outbound seq counter in buildWireMessage.
        let m = TransportManager(sharedKey: sharedKey, deviceId: "dev-1")

        XCTAssertEqual(outboundSeq(m), 0, "precondition: no outbound frames yet")

        // Build a real frame the same way live frames arrive: encrypt bytes that
        // decrypt+decompress cleanly (plaintext starts with '{' so it passes
        // through the compression check untouched) but are NOT valid JSON, so
        // RemoteEvent decode fails and the recovery branch runs.
        let garbled = Data("{bad json".utf8)
        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: garbled, key: sharedKey)
        let wire = WireMessage(
            seq: 1,
            ts: nil,
            payload: nil,
            nonce: nonce.base64EncodedString(),
            ciphertext: ciphertext.base64EncodedString()
        )
        let wireData = try JSONEncoder().encode(wire)

        m.handleIncomingData(wireData, isRelay: false)

        // The recovery send is dispatched on a detached Task; poll briefly for
        // the outbound seq counter to move off zero.
        var attempted = false
        for _ in 0..<50 {
            if outboundSeq(m) > 0 { attempted = true; break }
            try await Task.sleep(for: .milliseconds(20))
        }

        XCTAssertTrue(attempted,
            "handleIncomingData must request a resync (send(.sync)) after a decode failure; " +
            "on the unfixed silent-drop path no send is issued and the outbound seq stays 0")
    }
}
