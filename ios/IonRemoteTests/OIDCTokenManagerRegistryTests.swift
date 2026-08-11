import XCTest
import CryptoKit
@testable import IonRemote

/// Per-pairing OIDC manager resolution.
///
/// The bug these pin: `SessionViewModel` held ONE `oidcTokenManager` and skipped
/// initialization whenever it was non-nil, without comparing the device. A phone
/// paired with a personal desktop (tenant A, relay A) and a work desktop
/// (tenant B, relay B) therefore authenticated the work transport with the
/// personal tenant's manager — wrong issuer, wrong client ID, wrong Keychain
/// key — and the relay refused it on every reconnect forever.
final class OIDCTokenManagerRegistryTests: XCTestCase {

    private let personalId = "device-personal-tenant"
    private let workId = "device-work-tenant"

    override func tearDown() {
        super.tearDown()
        KeychainHelper.delete(OIDCTokenManager.refreshKey(deviceId: personalId))
        KeychainHelper.delete(OIDCTokenManager.refreshKey(deviceId: workId))
    }

    // MARK: - Fixtures

    private func makeDevice(
        id: String,
        issuer: String,
        clientId: String,
        scope: String = "api://relay/Relay.Access",
        authMode: String? = "oidc"
    ) -> PairedDevice {
        var device = PairedDevice(
            id: id,
            name: "Desktop-\(id)",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-\(id)",
            sharedSecret: Data(repeating: 0x11, count: 32),
            relayURL: "wss://relay.example.com",
            relayAPIKey: "bootstrap"
        )
        device.relayAuthMode = authMode
        device.relayOidcIssuer = issuer
        device.relayOidcClientId = clientId
        device.relayOidcRequiredScope = scope
        return device
    }

    // MARK: - The reported bug

    func testTwoTenantsGetSeparateManagers() {
        let registry = OIDCTokenManagerRegistry()
        let personal = makeDevice(
            id: personalId,
            issuer: "https://login.microsoftonline.com/personal-tenant/v2.0",
            clientId: "personal-client"
        )
        let work = makeDevice(
            id: workId,
            issuer: "https://login.microsoftonline.com/work-tenant/v2.0",
            clientId: "work-client"
        )

        guard let personalManager = registry.manager(for: personal) else {
            return XCTFail("expected a manager for the personal pairing")
        }
        guard let workManager = registry.manager(for: work) else {
            return XCTFail("expected a manager for the work pairing")
        }

        XCTAssertFalse(personalManager === workManager,
            "each pairing must get its own manager; sharing one is the multi-tenant bug")

        // Bound to locals before asserting: XCTAssert* take autoclosures, and an
        // actor's immutable configuration cannot be read from inside one.
        let workIssuer = workManager.issuer
        let workClient = workManager.clientId
        let workDevice = workManager.deviceId
        let personalIssuer = personalManager.issuer
        let personalClient = personalManager.clientId
        let personalDevice = personalManager.deviceId

        XCTAssertEqual(workIssuer, "https://login.microsoftonline.com/work-tenant/v2.0",
            "the work transport must resolve the WORK tenant's issuer")
        XCTAssertEqual(workClient, "work-client")
        XCTAssertEqual(workDevice, workId)
        XCTAssertEqual(personalIssuer, "https://login.microsoftonline.com/personal-tenant/v2.0")
        XCTAssertEqual(personalClient, "personal-client")
        XCTAssertEqual(personalDevice, personalId)
    }

    /// Each pairing keys its refresh token separately, so signing in to one
    /// tenant cannot overwrite the other's stored credential.
    func testRefreshKeysAreDisjointPerPairing() {
        XCTAssertNotEqual(
            OIDCTokenManager.refreshKey(deviceId: personalId),
            OIDCTokenManager.refreshKey(deviceId: workId)
        )
    }

    // MARK: - Instance reuse

    func testSameDeviceReturnsIdenticalInstance() {
        let registry = OIDCTokenManagerRegistry()
        let device = makeDevice(id: personalId, issuer: "https://issuer.example.com/v2.0", clientId: "client-a")

        let first = registry.manager(for: device)
        let second = registry.manager(for: device)

        XCTAssertNotNil(first)
        XCTAssertTrue(first === second,
            "reusing the instance is what preserves the cached token, single-flight guard, and cancel cooldown across desktop switches")
    }

    func testChangedClientIdRebuilds() {
        let registry = OIDCTokenManagerRegistry()
        let before = makeDevice(id: personalId, issuer: "https://issuer.example.com/v2.0", clientId: "client-a")
        let after = makeDevice(id: personalId, issuer: "https://issuer.example.com/v2.0", clientId: "client-b")

        let first = registry.manager(for: before)
        let second = registry.manager(for: after)

        XCTAssertFalse(first === second, "a different app registration must not reuse the old token state")
        let clientId = second?.clientId
        XCTAssertEqual(clientId, "client-b")
    }

    func testChangedIssuerRebuilds() {
        let registry = OIDCTokenManagerRegistry()
        let before = makeDevice(id: personalId, issuer: "https://issuer-a.example.com/v2.0", clientId: "client-a")
        let after = makeDevice(id: personalId, issuer: "https://issuer-b.example.com/v2.0", clientId: "client-a")

        let first = registry.manager(for: before)
        let second = registry.manager(for: after)

        XCTAssertFalse(first === second, "a different tenant must not reuse the old token state")
        let issuer = second?.issuer
        XCTAssertEqual(issuer, "https://issuer-b.example.com/v2.0")
    }

    func testChangedScopeRebuilds() {
        let registry = OIDCTokenManagerRegistry()
        let before = makeDevice(id: personalId, issuer: "https://issuer.example.com/v2.0", clientId: "c", scope: "api://relay/Relay.Access")
        let after = makeDevice(id: personalId, issuer: "https://issuer.example.com/v2.0", clientId: "c", scope: "api://relay/Relay.Admin")

        let first = registry.manager(for: before)
        let second = registry.manager(for: after)

        XCTAssertFalse(first === second)
        let scope = second?.scope
        XCTAssertEqual(scope, "api://relay/Relay.Admin")
    }

    // MARK: - Non-OIDC pairings

    func testPSKPairingGetsNoManager() {
        let registry = OIDCTokenManagerRegistry()
        let psk = makeDevice(id: personalId, issuer: "", clientId: "", authMode: "psk")
        XCTAssertNil(registry.manager(for: psk))
    }

    func testOidcModeWithMissingClientIdGetsNoManager() {
        let registry = OIDCTokenManagerRegistry()
        let incomplete = makeDevice(id: personalId, issuer: "https://issuer.example.com/v2.0", clientId: "")
        XCTAssertNil(registry.manager(for: incomplete))
    }

    // MARK: - existing()

    func testExistingDoesNotCreate() {
        let registry = OIDCTokenManagerRegistry()
        XCTAssertNil(registry.existing(deviceId: personalId))

        let device = makeDevice(id: personalId, issuer: "https://issuer.example.com/v2.0", clientId: "client-a")
        _ = registry.manager(for: device)

        XCTAssertNotNil(registry.existing(deviceId: personalId))
    }

    // MARK: - Removal deletes the Keychain refresh token

    func testRemoveDeletesManagerAndRefreshToken() {
        let registry = OIDCTokenManagerRegistry()
        let device = makeDevice(id: workId, issuer: "https://issuer.example.com/v2.0", clientId: "client-a")
        _ = registry.manager(for: device)
        KeychainHelper.set("work-refresh-token", service: OIDCTokenManager.refreshKey(deviceId: workId))
        XCTAssertNotNil(KeychainHelper.get(OIDCTokenManager.refreshKey(deviceId: workId)))

        registry.remove(deviceId: workId)

        XCTAssertNil(registry.existing(deviceId: workId))
        XCTAssertNil(KeychainHelper.get(OIDCTokenManager.refreshKey(deviceId: workId)),
            "unpairing must not leave a live refresh token for that tenant on the device")
    }

    func testRemoveAllClearsEveryListedPairing() {
        let registry = OIDCTokenManagerRegistry()
        let personal = makeDevice(id: personalId, issuer: "https://a.example.com/v2.0", clientId: "ca")
        let work = makeDevice(id: workId, issuer: "https://b.example.com/v2.0", clientId: "cb")
        _ = registry.manager(for: personal)
        _ = registry.manager(for: work)
        KeychainHelper.set("t1", service: OIDCTokenManager.refreshKey(deviceId: personalId))
        KeychainHelper.set("t2", service: OIDCTokenManager.refreshKey(deviceId: workId))

        registry.removeAll(deviceIds: [personalId, workId])

        XCTAssertNil(registry.existing(deviceId: personalId))
        XCTAssertNil(registry.existing(deviceId: workId))
        XCTAssertNil(KeychainHelper.get(OIDCTokenManager.refreshKey(deviceId: personalId)))
        XCTAssertNil(KeychainHelper.get(OIDCTokenManager.refreshKey(deviceId: workId)))
    }

    /// Removal is safe for a pairing the registry never built a manager for
    /// (a PSK pairing being unpaired still routes through `remove`).
    func testRemoveUnknownDeviceIsHarmless() {
        let registry = OIDCTokenManagerRegistry()
        registry.remove(deviceId: "never-registered")
        XCTAssertNil(registry.existing(deviceId: "never-registered"))
    }
}
