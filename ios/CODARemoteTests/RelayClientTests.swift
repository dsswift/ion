import XCTest
@testable import CODARemote

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
}
