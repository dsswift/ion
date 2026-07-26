import XCTest
import CryptoKit
@testable import IonRemote

/// Recovery-path tests for the relay-config lifecycle.
///
/// These pin the two halves of the "iPhone can never reconnect" incident that
/// live below `handleRelayConfig`:
///
///  1. `relayURL` / `relayAPIKey` start empty on every launch and were never
///     hydrated from the active device. That turned them into a destructive
///     fallback — `handleRelayConfig` treats them as the "keep what we have"
///     source, so on a cold start it fell back onto `""`.
///  2. `softReconnect()` bailed out of an empty relay URL with a bare `return`
///     AFTER tearing the transport down and BEFORE setting `connectionState`.
///     The result was `transport == nil` with a stale `.connected`: every
///     command deferred forever, no retry, no banner, no log line.
final class RelayConfigRecoveryTests: XCTestCase {

    private func makeDevice(
        id: String = "dev-recovery",
        relayURL: String?,
        relayAPIKey: String?
    ) -> PairedDevice {
        PairedDevice(
            id: id,
            name: "TestMac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-\(id)",
            sharedSecret: Data(repeating: 0x5A, count: 32),
            relayURL: relayURL,
            relayAPIKey: relayAPIKey
        )
    }

    // MARK: - Hydration

    @MainActor
    func testHydrateRelayConfigPopulatesFromActiveDevice() {
        let vm = SessionViewModel()
        vm.pairedDevices = [makeDevice(
            relayURL: "wss://relay.example.com",
            relayAPIKey: "stored-token"
        )]
        vm.activeDeviceId = "dev-recovery"
        // Simulate the cold-launch state the defect depended on.
        vm.relayURL = ""
        vm.relayAPIKey = ""

        vm.hydrateRelayConfig()

        XCTAssertEqual(vm.relayURL, "wss://relay.example.com",
            "the in-memory relay URL must come from the stored device record")
        XCTAssertEqual(vm.relayAPIKey, "stored-token")
    }

    @MainActor
    func testHydrateRelayConfigWithNoActiveDeviceLeavesStateUntouched() {
        let vm = SessionViewModel()
        vm.pairedDevices = []
        vm.relayURL = ""
        vm.relayAPIKey = ""

        vm.hydrateRelayConfig()

        XCTAssertEqual(vm.relayURL, "")
        XCTAssertEqual(vm.relayAPIKey, "")
    }

    @MainActor
    func testHydratedConfigSurvivesACredentiallessPush() {
        // The two fixes composed: hydration gives handleRelayConfig a real
        // fallback, and the empty-write guard refuses to persist nothing.
        let vm = SessionViewModel()
        vm.pairedDevices = [makeDevice(
            relayURL: "wss://relay.example.com",
            relayAPIKey: "stored-token"
        )]
        vm.activeDeviceId = "dev-recovery"
        vm.hydrateRelayConfig()

        vm.handleRelayConfig(
            relayUrl: "",
            relayApiKey: "",
            authMode: "psk",
            relayOidcIssuer: nil,
            relayOidcAudience: nil,
            relayOidcRequiredScope: nil,
            relayOidcClientId: nil
        )

        XCTAssertEqual(vm.relayURL, "wss://relay.example.com")
        XCTAssertEqual(vm.relayAPIKey, "stored-token")
        XCTAssertEqual(vm.pairedDevices.first?.relayURL, "wss://relay.example.com")
        XCTAssertEqual(vm.pairedDevices.first?.relayAPIKey, "stored-token")
    }

    // MARK: - LAN-only fallback instead of a silent dead end

    @MainActor
    func testSoftReconnectWithEmptyRelayURLStillBuildsATransport() {
        let vm = SessionViewModel()
        vm.pairedDevices = [makeDevice(relayURL: "", relayAPIKey: "")]
        vm.activeDeviceId = "dev-recovery"
        vm.relayURL = ""
        vm.relayAPIKey = ""
        // The exact wedged state from the incident: the app believes it is
        // connected while the transport is gone.
        vm.connectionState = .connected

        vm.softReconnect()

        XCTAssertNotNil(vm.transport,
            "an empty relay URL must fall back to a LAN-only transport, never leave transport == nil")
        XCTAssertEqual(vm.connectionState, .disconnected,
            "state must not stay .connected — the disconnected view's auto-retry keys off .disconnected")

        vm.disconnect()
    }

    @MainActor
    func testSoftReconnectWithMalformedRelayURLStillBuildsATransport() {
        let vm = SessionViewModel()
        // A stored value that is non-empty but unparseable hit the same
        // `guard ... else { return }` dead end.
        vm.pairedDevices = [makeDevice(relayURL: "not a url", relayAPIKey: "k")]
        vm.activeDeviceId = "dev-recovery"
        vm.relayURL = "not a url"
        vm.relayAPIKey = "k"
        vm.connectionState = .connected

        vm.softReconnect()

        XCTAssertNotNil(vm.transport)
        XCTAssertEqual(vm.connectionState, .disconnected)

        vm.disconnect()
    }

    @MainActor
    func testConnectWithEmptyRelayURLStillBuildsATransport() {
        let vm = SessionViewModel()
        vm.pairedDevices = [makeDevice(relayURL: "", relayAPIKey: "")]
        vm.activeDeviceId = "dev-recovery"
        vm.relayURL = ""
        vm.relayAPIKey = ""

        vm.connect()

        XCTAssertNotNil(vm.transport,
            "connect() must also fall back to LAN rather than returning with no transport")
        XCTAssertEqual(vm.connectionState, .disconnected)

        vm.disconnect()
    }

    @MainActor
    func testLANOnlyFallbackKeepsTabsIntact() {
        // The fallback must not wipe transient state — the user keeps their
        // cached tab list while Bonjour re-establishes the session.
        let vm = SessionViewModel()
        vm.pairedDevices = [makeDevice(relayURL: "", relayAPIKey: "")]
        vm.activeDeviceId = "dev-recovery"
        vm.tabs = [RemoteTabState(
            id: "tab-1", title: "Cached tab", customTitle: nil, status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]

        vm.softReconnect()

        XCTAssertEqual(vm.tabs.count, 1,
            "soft reconnect never wipes transient state, including on the LAN fallback path")

        vm.disconnect()
    }
}
