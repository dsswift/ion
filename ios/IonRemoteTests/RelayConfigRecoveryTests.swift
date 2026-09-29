import XCTest
import CryptoKit
import Security
@testable import IonRemote

/// Recovery-path tests for the relay-config lifecycle.
///
/// These pin the two halves of the "iPhone can never reconnect" incident:
///
///  1. `relayURL` / `relayAPIKey` start empty on every launch and were never
///     hydrated from the active pairing, so a cold start held `""` while a
///     good relay config sat in the stored record.
///  2. `softReconnect()` bailed out of an unconnectable pairing with a bare
///     `return` AFTER tearing the transport down and BEFORE setting
///     `connectionState`. The result was `transport == nil` with a stale
///     `.connected`: every command deferred forever, no retry, no banner, no
///     log line.
final class RelayConfigRecoveryTests: XCTestCase {

    private func makeDevice(
        id: String = "dev-recovery",
        relayURL: String?,
        relayAPIKey: String?,
        sharedSecret: Data = Data(repeating: 0x5A, count: 32)
    ) -> PairedDevice {
        PairedDevice(
            id: id,
            name: "TestMac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-\(id)",
            sharedSecret: sharedSecret,
            relayURL: relayURL,
            relayAPIKey: relayAPIKey
        )
    }

    /// A pairing no stored Studio record can match. `studioRecord(for:)` looks
    /// up the real Keychain by `pairedDeviceId` and by the client id the
    /// secret derives, so a fixed secret would match whatever another test in
    /// this target left behind.
    private func makeUncredentialedDevice() -> PairedDevice {
        var secret = Data(count: 32)
        secret.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return makeDevice(id: "dev-no-studio-\(UUID().uuidString)", relayURL: "", relayAPIKey: "", sharedSecret: secret)
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

    // MARK: - No wire to fall back to

    /// The Studio wire is the only wire. A pairing whose Studio credential is
    /// missing has nothing to connect with, so both entry points must land on
    /// `.disconnected` with no transport rather than leaving a stale
    /// `.connected` that defers every command forever — the shape of the
    /// original "iPhone can never reconnect" incident.
    @MainActor
    func testSoftReconnectWithNoStudioCredentialGoesHonestlyDisconnected() {
        let vm = SessionViewModel()
        let device = makeUncredentialedDevice()
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.connectionState = .connected

        vm.softReconnect()

        XCTAssertNil(vm.transport,
            "there is no second wire to build a transport on")
        XCTAssertEqual(vm.connectionState, .disconnected,
            "state must not stay .connected — the disconnected view's auto-retry keys off .disconnected")

        vm.disconnect()
    }

    @MainActor
    func testConnectWithNoStudioCredentialGoesHonestlyDisconnected() {
        let vm = SessionViewModel()
        let device = makeUncredentialedDevice()
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.connectionState = .connected

        vm.connect()

        XCTAssertNil(vm.transport)
        XCTAssertEqual(vm.connectionState, .disconnected)

        vm.disconnect()
    }

    @MainActor
    func testSoftReconnectKeepsTabsIntact() {
        // A failed reconnect must not wipe transient state — the user keeps
        // their tab list while the session re-establishes. The pairing has no
        // Studio credential so nothing connects and nothing restores a cached
        // layout over the tabs, which is the arm this pins.
        let vm = SessionViewModel()
        let device = makeUncredentialedDevice()
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.tabs = [RemoteTabState(
            id: "tab-1", title: "Cached tab", customTitle: nil, status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]

        vm.softReconnect()

        XCTAssertEqual(vm.tabs.count, 1,
            "soft reconnect never wipes transient state, even when it cannot connect")

        vm.disconnect()
    }
}
