import XCTest
import SwiftUI
import CryptoKit
@testable import CODARemote

final class TransportManagerTests: XCTestCase {

    // MARK: - TransportState enum

    func testTransportStateRawValues() {
        XCTAssertEqual(TransportState.disconnected.rawValue, "disconnected")
        XCTAssertEqual(TransportState.relayOnly.rawValue, "relayOnly")
        XCTAssertEqual(TransportState.lanPreferred.rawValue, "lanPreferred")
    }

    func testTransportStateAllCases() {
        // Verify all three states exist by exhaustive switch.
        let states: [TransportState] = [.disconnected, .relayOnly, .lanPreferred]
        for state in states {
            switch state {
            case .disconnected:
                XCTAssertEqual(state.rawValue, "disconnected")
            case .relayOnly:
                XCTAssertEqual(state.rawValue, "relayOnly")
            case .lanPreferred:
                XCTAssertEqual(state.rawValue, "lanPreferred")
            }
        }
    }

    // MARK: - TransportManager initial state

    func testInitialStateIsDisconnected() {
        let key = SymmetricKey(size: .bits256)
        let channelId = E2ECrypto.deriveChannelId(sharedSecret: key)
        let manager = TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "test-key",
            channelId: channelId,
            sharedKey: key
        )
        XCTAssertEqual(manager.state, .disconnected)
    }

    func testRelayClientIsCreated() {
        let key = SymmetricKey(size: .bits256)
        let channelId = "test-channel-id"
        let manager = TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "test-api-key",
            channelId: channelId,
            sharedKey: key
        )
        // The relay client should exist and be disconnected initially.
        XCTAssertFalse(manager.relay.isConnected)
    }

    func testLANClientIsCreated() {
        let key = SymmetricKey(size: .bits256)
        let manager = TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "key",
            channelId: "ch",
            sharedKey: key
        )
        XCTAssertFalse(manager.lan.isConnected)
    }

    // MARK: - ConnectionState (UI-level)

    func testConnectionStateLabels() {
        XCTAssertEqual(ConnectionState.disconnected.label, "Disconnected")
        XCTAssertEqual(ConnectionState.connecting.label, "Connecting")
        XCTAssertEqual(ConnectionState.connected.label, "Connected")
        XCTAssertEqual(ConnectionState.reconnecting.label, "Reconnecting")
    }

    func testConnectionStateRawValues() {
        XCTAssertEqual(ConnectionState.disconnected.rawValue, "disconnected")
        XCTAssertEqual(ConnectionState.connecting.rawValue, "connecting")
        XCTAssertEqual(ConnectionState.connected.rawValue, "connected")
        XCTAssertEqual(ConnectionState.reconnecting.rawValue, "reconnecting")
    }

    func testConnectionStateColors() {
        // Verify each state has a distinct color (SwiftUI Color comparison is opaque,
        // but we can at least confirm they don't crash and cover the code path).
        let states: [ConnectionState] = [.disconnected, .connecting, .connected, .reconnecting]
        var colorDescriptions = Set<String>()
        for state in states {
            let color = state.color
            colorDescriptions.insert(color.description)
            XCTAssertNotNil(color)
        }
        // All four should produce different color descriptions.
        XCTAssertEqual(colorDescriptions.count, 4, "Each ConnectionState should have a distinct color")
    }

    // MARK: - TransportError

    func testTransportErrorDescriptions() {
        let noTransport = TransportError.noTransportAvailable
        XCTAssertNotNil(noTransport.errorDescription)
        XCTAssertTrue(noTransport.errorDescription!.contains("No transport available"))

        let encodingError = TransportError.encodingFailed(NSError(domain: "test", code: 1))
        XCTAssertNotNil(encodingError.errorDescription)
        XCTAssertTrue(encodingError.errorDescription!.contains("encode"))
    }

    // MARK: - WireMessage

    func testWireMessageDecoding() throws {
        let json = """
        {"seq":42,"payload":"{\\"type\\":\\"sync\\"}","nonce":null,"ciphertext":null}
        """.data(using: .utf8)!
        let wire = try JSONDecoder().decode(WireMessage.self, from: json)
        XCTAssertEqual(wire.seq, 42)
        XCTAssertEqual(wire.payload, "{\"type\":\"sync\"}")
        XCTAssertNil(wire.nonce)
        XCTAssertNil(wire.ciphertext)
    }

    func testWireMessageEncodingEncrypted() throws {
        let wire = WireMessage(
            seq: 1,
            payload: nil,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "encrypteddata=="
        )
        let data = try JSONEncoder().encode(wire)
        let decoded = try JSONDecoder().decode(WireMessage.self, from: data)
        XCTAssertEqual(decoded.seq, 1)
        XCTAssertNil(decoded.payload)
        XCTAssertEqual(decoded.nonce, "AAAAAAAAAAAAAAAA")
        XCTAssertEqual(decoded.ciphertext, "encrypteddata==")
    }

    func testWireMessageRoundTrip() throws {
        let wire = WireMessage(seq: 99, payload: "{}", nonce: nil, ciphertext: nil)
        let data = try JSONEncoder().encode(wire)
        let decoded = try JSONDecoder().decode(WireMessage.self, from: data)
        XCTAssertEqual(decoded.seq, wire.seq)
        XCTAssertEqual(decoded.payload, wire.payload)
    }

    // MARK: - Stop resets state

    func testStopResetsToDisconnected() {
        let key = SymmetricKey(size: .bits256)
        let manager = TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "key",
            channelId: "ch",
            sharedKey: key
        )
        // Call stop on a fresh manager; should remain disconnected without crashing.
        manager.stop()
        XCTAssertEqual(manager.state, .disconnected)
    }
}
