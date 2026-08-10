import XCTest
import CryptoKit
@testable import IonRemote

/// Desktop switching with two OIDC pairings in different tenants.
///
/// End-to-end shape of the reported bug: pair a personal desktop (tenant A,
/// relay A) and a work desktop (tenant B, relay B), then switch between them.
/// The old single-slot manager meant the second desktop's transport resolved the
/// first desktop's credential, which the second relay refuses forever.
final class SessionViewModelOidcSwitchTests: XCTestCase {

    private let personalId = "vm-personal"
    private let workId = "vm-work"

    override func tearDown() {
        super.tearDown()
        KeychainHelper.delete(OIDCTokenManager.refreshKey(deviceId: personalId))
        KeychainHelper.delete(OIDCTokenManager.refreshKey(deviceId: workId))
    }

    private func makeDevice(id: String, issuer: String, clientId: String) -> PairedDevice {
        var device = PairedDevice(
            id: id,
            name: "Desktop-\(id)",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-\(id)",
            sharedSecret: Data(repeating: 0x33, count: 32),
            relayURL: "wss://relay-\(id).example.com",
            relayAPIKey: ""
        )
        device.relayAuthMode = "oidc"
        device.relayOidcIssuer = issuer
        device.relayOidcClientId = clientId
        device.relayOidcRequiredScope = "api://\(id)/Relay.Access"
        return device
    }

    @MainActor
    private func makeViewModel() -> SessionViewModel {
        let vm = SessionViewModel()
        vm.pairedDevices = [
            makeDevice(id: personalId, issuer: "https://login.example.com/personal/v2.0", clientId: "personal-client"),
            makeDevice(id: workId, issuer: "https://login.example.com/work/v2.0", clientId: "work-client"),
        ]
        return vm
    }

    // MARK: - The regression

    /// Each pairing resolves its own manager through the registry, so the work
    /// desktop can never be handed the personal tenant's credential.
    @MainActor
    func testEachPairingResolvesItsOwnManager() throws {
        let vm = makeViewModel()
        let personal = try XCTUnwrap(vm.pairedDevices.first { $0.id == personalId })
        let work = try XCTUnwrap(vm.pairedDevices.first { $0.id == workId })

        let personalManager = try XCTUnwrap(vm.oidcRegistry.manager(for: personal))
        let workManager = try XCTUnwrap(vm.oidcRegistry.manager(for: work))

        XCTAssertFalse(personalManager === workManager)
        // Locals: actor configuration cannot be read inside an XCTAssert autoclosure.
        let personalIssuer = personalManager.issuer
        let workIssuer = workManager.issuer
        XCTAssertEqual(personalIssuer, "https://login.example.com/personal/v2.0")
        XCTAssertEqual(workIssuer, "https://login.example.com/work/v2.0")
    }

    /// Simulates the switch: after activating the personal desktop and then the
    /// work desktop, the manager registered for the work pairing still carries
    /// the WORK tenant's configuration.
    @MainActor
    func testSwitchingDesktopsKeepsCredentialsSeparate() throws {
        let vm = makeViewModel()
        vm.activeDeviceId = personalId
        let personal = try XCTUnwrap(vm.activeDevice)
        _ = vm.oidcRegistry.manager(for: personal)

        vm.activeDeviceId = workId
        let work = try XCTUnwrap(vm.activeDevice)
        let resolved = try XCTUnwrap(vm.oidcRegistry.manager(for: work))

        let resolvedDevice = resolved.deviceId
        let resolvedClient = resolved.clientId
        XCTAssertEqual(resolvedDevice, workId)
        XCTAssertEqual(resolvedClient, "work-client",
            "the work transport must not inherit the personal pairing's client ID")

        // And the personal pairing's manager is still intact for the way back.
        let personalAgain = try XCTUnwrap(vm.oidcRegistry.existing(deviceId: personalId))
        let personalClient = personalAgain.clientId
        XCTAssertEqual(personalClient, "personal-client")
    }

    /// Credential closures are built per pairing and are nil for non-OIDC ones.
    @MainActor
    func testCredentialClosuresNilForPskPairing() throws {
        let vm = makeViewModel()
        var psk = makeDevice(id: "vm-psk", issuer: "", clientId: "")
        psk.relayAuthMode = "psk"
        psk.relayOidcIssuer = nil
        psk.relayOidcClientId = nil
        vm.pairedDevices.append(psk)

        XCTAssertNil(vm.oidcCredentialClosures(for: psk))
        let work = try XCTUnwrap(vm.pairedDevices.first { $0.id == workId })
        XCTAssertNotNil(vm.oidcCredentialClosures(for: work))
    }

    // MARK: - Unpair cleanup

    @MainActor
    func testUnpairRemovesManagerAndRefreshToken() throws {
        let vm = makeViewModel()
        vm.activeDeviceId = personalId
        let work = try XCTUnwrap(vm.pairedDevices.first { $0.id == workId })
        _ = vm.oidcRegistry.manager(for: work)
        KeychainHelper.set("work-refresh", service: OIDCTokenManager.refreshKey(deviceId: workId))

        vm.unpairDevice(work)

        XCTAssertNil(vm.oidcRegistry.existing(deviceId: workId))
        XCTAssertNil(KeychainHelper.get(OIDCTokenManager.refreshKey(deviceId: workId)),
            "unpairing must not strand a live refresh token for that tenant")
        XCTAssertFalse(vm.pairedDevices.contains { $0.id == workId })
    }

    @MainActor
    func testAuthorizedSnapshotReportsMobileAuthOnce() throws {
        let vm = makeViewModel()
        vm.activeDeviceId = workId
        vm.authorizeDesktop(deviceId: workId)

        let reports = vm.pendingEssentialQueue.filter { $0.command.kindName == "reportMobileAuth" }
        XCTAssertEqual(reports.count, 1, "one authenticated snapshot must create one mobile auth report")
    }

    // MARK: - Identity mismatch state

    @MainActor
    func testIdentityMismatchIsRecordedPerPairing() {
        let vm = makeViewModel()
        vm.activeDeviceId = workId

        vm.handleRelayIdentityMismatch(deviceId: workId)

        XCTAssertTrue(vm.relayIdentityMismatch.contains(workId))
        XCTAssertFalse(vm.relayIdentityMismatch.contains(personalId),
            "a refusal for one pairing must not flag the other")
        XCTAssertEqual(vm.activeDesktopAccess.status, .rejected)
        XCTAssertEqual(vm.activeDesktopAccess.reason, .wrongAccount,
            "the active pairing being refused must lock data without conflating transport state")
        XCTAssertFalse(vm.mayViewActiveDesktopData)
    }

    @MainActor
    func testIdentityMismatchForInactivePairingLeavesConnectionState() {
        let vm = makeViewModel()
        vm.activeDeviceId = personalId
        vm.connectionState = .connected

        vm.handleRelayIdentityMismatch(deviceId: workId)

        XCTAssertTrue(vm.relayIdentityMismatch.contains(workId))
        XCTAssertEqual(vm.connectionState, .connected,
            "an inactive pairing's refusal must not disturb the live session")
    }

    /// A successful token acquisition proves the bound account works, so any
    /// earlier refusal flag is stale.
    @MainActor
    func testApplyingIdentityClearsMismatchAndPersistsAccount() throws {
        let vm = makeViewModel()
        vm.relayIdentityMismatch.insert(workId)

        vm.applyOIDCIdentity(deviceId: workId, identity: OIDCAccountIdentity(
            username: "user@example.com",
            displayName: "Example User",
            subject: "work-subject",
            tenantId: "work-tenant",
            issuedAt: Date(timeIntervalSince1970: 760_000_000)
        ))

        let work = try XCTUnwrap(vm.pairedDevices.first { $0.id == workId })
        XCTAssertEqual(work.relayOidcAccountUsername, "user@example.com")
        XCTAssertEqual(work.relayOidcTenantId, "work-tenant")
        XCTAssertFalse(vm.relayIdentityMismatch.contains(workId))
    }

    @MainActor
    func testIdentityForUnknownPairingIsDiscarded() {
        let vm = makeViewModel()
        let before = vm.pairedDevices

        vm.applyOIDCIdentity(deviceId: "not-a-pairing", identity: OIDCAccountIdentity(
            username: "stray@example.com", displayName: "", subject: "s", tenantId: "t", issuedAt: Date()
        ))

        XCTAssertEqual(vm.pairedDevices.map(\.id), before.map(\.id))
        XCTAssertFalse(vm.pairedDevices.contains { $0.relayOidcAccountUsername == "stray@example.com" })
    }

    @MainActor
    func testIdentityMismatchLocksWhenLanAuthorityDrops() {
        let vm = makeViewModel()
        vm.activeDeviceId = workId
        vm.relayIdentityMismatch.insert(workId)
        vm.connectionQuality.transportState = .lanPreferred
        vm.connectionQuality.transportState = .relayOnly

        vm.lockDeferredRelayMismatchIfNeeded()

        XCTAssertEqual(vm.activeDesktopAccess.reason, .wrongAccount)
        XCTAssertFalse(vm.mayViewActiveDesktopData)
    }

    // MARK: - Sign out

    @MainActor
    func testSignOutClearsAccountFieldsAndCredential() throws {
        let vm = makeViewModel()
        vm.activeDeviceId = personalId
        var work = try XCTUnwrap(vm.pairedDevices.first { $0.id == workId })
        _ = vm.oidcRegistry.manager(for: work)
        KeychainHelper.set("work-refresh", service: OIDCTokenManager.refreshKey(deviceId: workId))
        vm.applyOIDCIdentity(deviceId: workId, identity: OIDCAccountIdentity(
            username: "user@example.com", displayName: "Example User",
            subject: "s", tenantId: "t", issuedAt: Date()
        ))
        work = try XCTUnwrap(vm.pairedDevices.first { $0.id == workId })
        XCTAssertNotNil(work.relayOidcAccountUsername)

        vm.signOutOIDC(device: work)

        let after = try XCTUnwrap(vm.pairedDevices.first { $0.id == workId })
        XCTAssertNil(after.relayOidcAccountUsername)
        XCTAssertNil(after.relayOidcSubject)
        XCTAssertNil(after.relayOidcSignedInAt)
        XCTAssertNil(KeychainHelper.get(OIDCTokenManager.refreshKey(deviceId: workId)))
        XCTAssertTrue(after.usesOIDC, "the pairing itself survives a sign-out")
    }
}
