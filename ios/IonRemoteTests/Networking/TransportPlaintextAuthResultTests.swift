import XCTest
import CryptoKit
@testable import IonRemote

/// Hygiene B: plaintext `auth_result` frames on the DATA path must be
/// ignored, never honored.
///
/// A TransportManager always holds a shared secret (both inits require
/// `sharedKey`), and once a secret exists the desktop never sends plaintext
/// data frames — mirroring the desktop's own inbound rule
/// (transport-inbound-payload.ts rejects plaintext when a device secret is
/// set). The old code honored a WireMessage-wrapped plaintext
/// `auth_result success=false` and yielded `.peerDisconnected`: any LAN peer
/// able to reach the socket could inject one unencrypted frame and tear down
/// a healthy session (DoS).
///
/// Red-on-unfixed proof: `testPlaintextAuthResultFailureIsIgnored` collects
/// yielded events after injecting the frame; on the unfixed code
/// `.peerDisconnected` is yielded and the test fails.
///
/// The legitimate pre-secret auth phase is a DIFFERENT path:
/// `performLANAuthCore` consumes `lan.messages` during the handshake before
/// `startLANListener` exists, and its verdict parsing lives in
/// `LANAuthOutcome.verdict`. The tests here pin that that path still works.
final class TransportPlaintextAuthResultTests: XCTestCase {

    private func makeManager(sharedKey: SymmetricKey = SymmetricKey(size: .bits256)) -> TransportManager {
        TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: sharedKey
        )
    }

    /// Injected plaintext auth_result success=false must NOT flip connection
    /// state (no `.peerDisconnected` yield).
    func testPlaintextAuthResultFailureIsIgnored() async throws {
        let m = makeManager()

        // Watch the events stream for any yield triggered by the injection.
        let watcher = Task { () -> RemoteEvent? in
            for await event in m.events {
                return event // first event, if any
            }
            return nil
        }

        let wire = WireMessage(
            seq: 0,
            ts: nil,
            payload: #"{"type":"auth_result","success":false,"reason":"injected"}"#
        )
        let data = try JSONEncoder().encode(wire)
        m.handleIncomingData(data, isRelay: false)

        // Give a (wrong) yield time to land, then confirm nothing arrived.
        try await Task.sleep(for: .milliseconds(200))
        watcher.cancel()
        let event = await watcher.value
        if case .peerDisconnected = event {
            XCTFail("plaintext auth_result success=false must be ignored on the data path, " +
                    "not honored as peerDisconnected — that is an unauthenticated DoS vector")
        }
    }

    /// Same injection via the relay origin — also ignored.
    func testPlaintextAuthResultIgnoredFromRelayOrigin() async throws {
        let m = makeManager()
        let watcher = Task { () -> RemoteEvent? in
            for await event in m.events { return event }
            return nil
        }
        let wire = WireMessage(
            seq: 0,
            ts: nil,
            payload: #"{"type":"auth_result","success":false}"#
        )
        m.handleIncomingData(try JSONEncoder().encode(wire), isRelay: true)
        try await Task.sleep(for: .milliseconds(200))
        watcher.cancel()
        let event = await watcher.value
        if case .peerDisconnected = event {
            XCTFail("plaintext auth_result must be ignored regardless of origin transport")
        }
    }

    /// A plaintext auth_result success=true is equally ignored (no state
    /// side effects at all from plaintext auth frames on the data path).
    func testPlaintextAuthResultSuccessIsAlsoIgnored() throws {
        let m = makeManager()
        m.lastReceivedSeq = 42
        let wire = WireMessage(
            seq: 0,
            ts: nil,
            payload: #"{"type":"auth_result","success":true}"#
        )
        m.handleIncomingData(try JSONEncoder().encode(wire), isRelay: false)
        XCTAssertEqual(m.lastReceivedSeq, 42, "no receive-state side effects")
    }

    // MARK: - Pre-secret auth phase still works

    /// The auth-phase verdict parser (used by `performLANAuthCore` while the
    /// handshake owns `lan.messages`) still classifies auth_result frames —
    /// the data-path ignore must not touch the legitimate auth flow.
    func testAuthPhaseVerdictParsingStillWorks() throws {
        // Bare auth_result, as the desktop's sendAuthResult emits (sendRaw,
        // no WireMessage envelope).
        let bareFail = ["type": "auth_result", "success": false] as [String: Any]
        XCTAssertEqual(LANAuthOutcome.verdict(fromAuthFrame: bareFail), .rejected)
        let bareOk = ["type": "auth_result", "success": true] as [String: Any]
        XCTAssertEqual(LANAuthOutcome.verdict(fromAuthFrame: bareOk), .success)

        // WireMessage-wrapped auth_result (legacy desktop shape).
        let wrapped: [String: Any] = [
            "seq": 0,
            "payload": #"{"type":"auth_result","success":false}"#
        ]
        XCTAssertEqual(LANAuthOutcome.verdict(fromAuthFrame: wrapped), .rejected)
    }
}
