import XCTest
@testable import IonRemote

final class RelayClientTests: XCTestCase {

    // MARK: - Initialization

    func testRelayClientInitialization() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        // Client should exist without crashing.
        XCTAssertNotNil(client)
    }

    func testInitiallyDisconnected() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        XCTAssertFalse(client.isConnected)
    }

    func testMessagesStreamIsAvailable() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        // The messages async stream should be accessible.
        XCTAssertNotNil(client.messages)
    }

    // MARK: - Disconnect

    func testDisconnectOnFreshClient() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        // Calling disconnect on a client that was never connected should not crash.
        client.disconnect()
        XCTAssertFalse(client.isConnected)
    }

    func testDisconnectIsIdempotent() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        client.disconnect()
        client.disconnect()
        XCTAssertFalse(client.isConnected)
    }

    // MARK: - Send without connection

    func testSendWhileDisconnectedThrows() async {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        let payload = "test".data(using: .utf8)!
        do {
            try await client.send(data: payload)
            XCTFail("Expected send to throw when not connected")
        } catch {
            // Verify it is the expected error type.
            XCTAssertTrue(error is RelayClientError)
            if let relayError = error as? RelayClientError {
                XCTAssertEqual(relayError, .notConnected)
            }
        }
    }

    // MARK: - RelayClientError

    func testRelayClientErrorDescription() {
        let error = RelayClientError.notConnected
        XCTAssertNotNil(error.errorDescription)
        XCTAssertTrue(error.errorDescription!.contains("not connected"))
    }

    func testRelayClientErrorEquality() {
        XCTAssertEqual(RelayClientError.notConnected, RelayClientError.notConnected)
    }

    // MARK: - Multiple clients

    func testMultipleClientsAreIndependent() {
        let url = URL(string: "wss://relay.example.com")!
        let client1 = RelayClient(relayURL: url, apiKey: "key-1", channelId: "ch-1")
        let client2 = RelayClient(relayURL: url, apiKey: "key-2", channelId: "ch-2")
        XCTAssertFalse(client1.isConnected)
        XCTAssertFalse(client2.isConnected)

        // Disconnecting one should not affect the other.
        client1.disconnect()
        XCTAssertFalse(client2.isConnected)
    }

    // MARK: - Keepalive ping lifecycle (Task.sleep loop, not Timer)

    /// The keepalive is a Task.sleep loop because `startPing()` is invoked
    /// from a URLSession callback thread with no running RunLoop — a
    /// `Timer.scheduledTimer` there never fired, so no pings went out and NAT
    /// idled the socket. These tests pin the reachable lifecycle seam:
    /// started -> active; stop/disconnect -> cancelled. (The "fires on a
    /// RunLoop-less thread" property itself needs a live socket and is
    /// verified by code structure: Task loops are scheduler-driven.)
    func testStartPingActivatesKeepalive() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        XCTAssertFalse(client.isPingKeepaliveActive)
        client.startPing()
        XCTAssertTrue(client.isPingKeepaliveActive,
            "startPing must install the keepalive task")
    }

    func testStopPingCancelsKeepalive() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        client.startPing()
        client.stopPing()
        XCTAssertFalse(client.isPingKeepaliveActive,
            "stopPing must cancel and clear the keepalive task")
    }

    func testDisconnectCancelsKeepalive() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        client.startPing()
        client.disconnect()
        XCTAssertFalse(client.isPingKeepaliveActive,
            "disconnect must tear the keepalive down with the socket")
    }

    func testStartPingIsIdempotentReplacement() {
        let url = URL(string: "wss://relay.example.com")!
        let client = RelayClient(relayURL: url, apiKey: "test-key", channelId: "ch123")
        client.startPing()
        client.startPing() // replaces, never stacks
        XCTAssertTrue(client.isPingKeepaliveActive)
        client.stopPing()
        XCTAssertFalse(client.isPingKeepaliveActive,
            "one stop clears the keepalive — startPing must not stack loops")
    }

    // MARK: - Credential rejection classification

    // The relay refuses a bad bearer two different ways depending on when it
    // notices, and only one of them was ever recognised. `auth.Validate` runs
    // in the HTTP handler BEFORE the WebSocket upgrade, so a token that is
    // already stale at connect time is refused with HTTP 401 and no WebSocket
    // (hence no close code) is ever created. Reading only `closeCode` made
    // that look like a generic network error: the credential was never
    // invalidated and the backoff ladder retried the same dead token out to
    // its 30-second ceiling forever.

    func testCloseCode4401IsCredentialRejection() {
        XCTAssertTrue(RelayRejection.isCredentialRejection(closeCode: 4401, httpStatus: nil),
            "4401 is the relay's mid-connection token-expiry close")
    }

    func testHTTP401IsCredentialRejection() {
        // The connect-time path: refused at the HTTP upgrade, no close code.
        XCTAssertTrue(RelayRejection.isCredentialRejection(closeCode: nil, httpStatus: 401),
            "an upgrade refused with 401 is a credential rejection")
    }

    func testHTTP403IsCredentialRejection() {
        // Channel ownership denial (subject mismatch) also refuses at the
        // upgrade and equally warrants re-acquiring the credential.
        XCTAssertTrue(RelayRejection.isCredentialRejection(closeCode: nil, httpStatus: 403),
            "an upgrade refused with 403 is a credential rejection")
    }

    func testAbnormalCloseIsNotCredentialRejection() {
        // 1006 = abnormal closure (network drop). Invalidating the token here
        // would force a needless re-auth on every flaky-network blip.
        XCTAssertFalse(RelayRejection.isCredentialRejection(closeCode: 1006, httpStatus: nil))
    }

    func testNoSignalsIsNotCredentialRejection() {
        XCTAssertFalse(RelayRejection.isCredentialRejection(closeCode: nil, httpStatus: nil))
    }

    func testSuccessfulUpgradeStatusIsNotCredentialRejection() {
        // 101 Switching Protocols with a policy close: not a credential fault.
        XCTAssertFalse(RelayRejection.isCredentialRejection(closeCode: 1008, httpStatus: 101))
    }

    func testGoingAwayWithSuccessStatusIsNotCredentialRejection() {
        // The relay closes with 1001 "replaced" when the same role reconnects.
        XCTAssertFalse(RelayRejection.isCredentialRejection(closeCode: 1001, httpStatus: 101))
    }
}
