import XCTest
@testable import IonRemote

final class RelayCapabilitiesTests: XCTestCase {

    // MARK: - URL construction

    func testBuildProbeURLFromWSS() {
        let caps = RelayCapabilities()
        let url = caps.buildProbeURL(relayURL: URL(string: "wss://relay.example.com")!)
        XCTAssertEqual(url?.absoluteString, "https://relay.example.com/v1/auth/config")
    }

    func testBuildProbeURLFromWS() {
        let caps = RelayCapabilities()
        let url = caps.buildProbeURL(relayURL: URL(string: "ws://localhost:8443")!)
        XCTAssertEqual(url?.absoluteString, "http://localhost:8443/v1/auth/config")
    }

    func testBuildProbeURLWithBasePath() {
        let caps = RelayCapabilities()
        let url = caps.buildProbeURL(relayURL: URL(string: "wss://relay.example.com/prefix")!)
        XCTAssertEqual(url?.absoluteString, "https://relay.example.com/prefix/v1/auth/config")
    }

    func testBuildProbeURLFromHTTPS() {
        let caps = RelayCapabilities()
        let url = caps.buildProbeURL(relayURL: URL(string: "https://relay.example.com:9000")!)
        XCTAssertEqual(url?.absoluteString, "https://relay.example.com:9000/v1/auth/config")
    }

    // MARK: - JSON decode

    func testAuthConfigDecodeStrict() throws {
        let json = """
        {"oidc":true,"psk":false,"capabilities":{"mobileForwardAck":true}}
        """
        let config = try JSONDecoder().decode(RelayCapabilities.AuthConfig.self, from: Data(json.utf8))
        XCTAssertTrue(config.oidc)
        XCTAssertFalse(config.psk)
        XCTAssertEqual(config.capabilities?.mobileForwardAck, true)
    }

    func testAuthConfigDecodeLegacy() throws {
        let json = """
        {"oidc":false,"psk":true,"capabilities":{}}
        """
        let config = try JSONDecoder().decode(RelayCapabilities.AuthConfig.self, from: Data(json.utf8))
        XCTAssertFalse(config.oidc)
        XCTAssertTrue(config.psk)
        XCTAssertNil(config.capabilities?.mobileForwardAck)
    }

    func testAuthConfigDecodeNoCapabilities() throws {
        let json = """
        {"oidc":false,"psk":true}
        """
        let config = try JSONDecoder().decode(RelayCapabilities.AuthConfig.self, from: Data(json.utf8))
        XCTAssertNil(config.capabilities)
    }

    // MARK: - Mode lifecycle

    func testInitialModeUnavailable() {
        let caps = RelayCapabilities()
        XCTAssertEqual(caps.ackMode, .unavailable)
        XCTAssertNil(caps.probeDate)
    }

    func testResetClearsMode() async {
        let caps = RelayCapabilities()
        // Simulate a probe against a non-existent host -- will resolve to .unavailable
        // but set probeDate
        _ = await caps.probe(relayURL: URL(string: "wss://localhost:1")!)
        XCTAssertNotNil(caps.probeDate)
        caps.reset()
        XCTAssertEqual(caps.ackMode, .unavailable)
        XCTAssertNil(caps.probeDate)
    }

    // MARK: - Relay delivery ACK lifecycle

    func testRelayDeliveryAcksConsumesEarlyForwardedAck() async {
        let acknowledgements = RelayDeliveryAcks()
        acknowledgements.begin(sequence: 7)
        acknowledgements.resolve(sequence: 7, outcome: .forwarded)

        let outcome = await acknowledgements.wait(for: 7)
        guard case .forwarded = outcome else {
            return XCTFail("early relay ACK was not delivered to waiter")
        }
    }

    func testRelayDeliveryAcksCancelRemovesWaiterAndDropsLateAck() async {
        let acknowledgements = RelayDeliveryAcks()
        acknowledgements.begin(sequence: 8)
        let waiting = Task { await acknowledgements.wait(for: 8) }
        await Task.yield()

        acknowledgements.cancel(sequence: 8, reason: "send_timed_out")
        guard case .unavailable(let reason) = await waiting.value else {
            return XCTFail("cancelled ACK wait did not resolve unavailable")
        }
        XCTAssertEqual(reason, "send_timed_out")

        acknowledgements.resolve(sequence: 8, outcome: .forwarded)
        let late = await acknowledgements.wait(for: 8)
        guard case .unavailable(let lateReason) = late else {
            return XCTFail("late ACK recreated cancelled delivery state")
        }
        XCTAssertEqual(lateReason, "delivery_cancelled")
    }

    func testRelayDeliveryAcksCancelAllResolvesEveryWaiter() async {
        let acknowledgements = RelayDeliveryAcks()
        acknowledgements.begin(sequence: 9)
        acknowledgements.begin(sequence: 10)
        let first = Task { await acknowledgements.wait(for: 9) }
        let second = Task { await acknowledgements.wait(for: 10) }
        for _ in 0..<100 { await Task.yield() }

        acknowledgements.cancelAll(reason: "transport_stopped")
        for outcome in [await first.value, await second.value] {
            guard case .unavailable(let reason) = outcome else {
                return XCTFail("teardown did not resolve ACK waiter")
            }
            XCTAssertEqual(reason, "transport_stopped")
        }
    }

    // MARK: - ConnectionHealth integration

    func testConnectionHealthRelayAckMode() {
        let health = ConnectionHealth()
        XCTAssertEqual(health.relayAckMode, .unavailable)

        health.updateRelayAckMode(.strict)
        XCTAssertEqual(health.relayAckMode, .strict)

        health.updateRelayAckMode(.legacy)
        XCTAssertEqual(health.relayAckMode, .legacy)

        health.reset()
        XCTAssertEqual(health.relayAckMode, .unavailable)
    }
}
