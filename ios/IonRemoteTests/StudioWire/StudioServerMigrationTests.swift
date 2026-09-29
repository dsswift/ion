import XCTest
@testable import IonRemote

/// An in-memory `StudioServerStoring`, optionally failing.
final class MemoryStudioServerStore: StudioServerStoring, @unchecked Sendable {
    struct Broken: Error {}

    private let lock = NSLock()
    private var records: [StudioServerRecord]
    private var saves = 0
    var failsLoad = false
    var failsSave = false

    init(_ records: [StudioServerRecord] = []) { self.records = records }

    var saveCount: Int { lock.withLock { saves } }
    var stored: [StudioServerRecord] { lock.withLock { records } }

    func load() throws -> [StudioServerRecord] {
        if failsLoad { throw Broken() }
        return lock.withLock { records }
    }

    func save(_ next: [StudioServerRecord]) throws {
        if failsSave { throw Broken() }
        lock.withLock {
            records = next
            saves += 1
        }
    }
}

/// Pairings made on the older wire become Studio wire records with the id the
/// server derives for them.
final class StudioServerMigrationTests: XCTestCase {

    /// The key of the shared sealed fixture (bytes 1 through 32).
    private let fixtureSecret = Data((1...32).map { UInt8($0) })

    private func device(id: String = "old-device-id", secret: Data, configure: (inout PairedDevice) -> Void = { _ in }) -> PairedDevice {
        var device = PairedDevice(
            id: id, name: "studio-host", pairedAt: Date(timeIntervalSince1970: 0), lastSeen: nil,
            channelId: "unused", sharedSecret: secret, relayURL: nil, relayAPIKey: nil
        )
        configure(&device)
        return device
    }

    func testTheClientIdIsDerivedFromTheSecretTheWayTheServerDerivesIt() throws {
        let fixtureURL = try StudioWireFixtures.directory("sealed").appendingPathComponent("relay-envelope.json")
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: fixtureURL))
        let key = try XCTUnwrap(fixture["key"]?.stringValue.flatMap { Data(base64Encoded: $0) })
        let channelId = try XCTUnwrap(fixture["channelId"]?.stringValue)
        XCTAssertEqual(key, fixtureSecret)
        XCTAssertEqual(StudioServerRecord.clientId(forSecret: key), String(channelId.prefix(16)))
        XCTAssertEqual(StudioServerRecord.clientId(forSecret: key), "ae216c2ef5247a37")
    }

    func testAPairedDeviceBecomesARecordUnderTheDerivedIdNotItsStoredId() {
        let store = MemoryStudioServerStore()
        let outcome = StudioServerMigration.run(devices: [device(secret: fixtureSecret) {
            $0.desktopId = "machine-1"
            $0.customName = "Build box"
        }], store: store)

        XCTAssertEqual(outcome.migrated, ["old-device-id"])
        XCTAssertEqual(store.stored.count, 1)
        let record = store.stored[0]
        XCTAssertEqual(record.clientId, "ae216c2ef5247a37")
        XCTAssertEqual(record.pairedDeviceId, "old-device-id")
        XCTAssertEqual(record.secret, fixtureSecret)
        XCTAssertEqual(record.machineId, "machine-1")
        XCTAssertEqual(record.label, "Build box")
        XCTAssertNil(record.url)
        XCTAssertNil(record.environmentId)
    }

    func testRunningAgainAddsNothingAndWritesNothing() {
        let store = MemoryStudioServerStore()
        let devices = [device(secret: fixtureSecret)]
        StudioServerMigration.run(devices: devices, store: store)
        let again = StudioServerMigration.run(devices: devices, store: store)

        XCTAssertTrue(again.migrated.isEmpty)
        XCTAssertEqual(again.skipped, ["old-device-id": "already a studio server record"])
        XCTAssertEqual(store.stored.count, 1)
        XCTAssertEqual(store.saveCount, 1)
    }

    func testARecordTheConnectionHasSinceUpdatedIsNotOverwritten() {
        let store = MemoryStudioServerStore()
        let devices = [device(secret: fixtureSecret)]
        StudioServerMigration.run(devices: devices, store: store)
        StudioServerRecordUpdater.apply(url: URL(string: "http://192.168.1.20:7331")!, clientId: "ae216c2ef5247a37", store: store)

        StudioServerMigration.run(devices: devices, store: store)
        XCTAssertEqual(store.stored.first?.url, "http://192.168.1.20:7331")
    }

    func testAnUnusableSecretIsSkippedAndTheOthersStillMigrate() {
        let store = MemoryStudioServerStore()
        let outcome = StudioServerMigration.run(devices: [
            device(id: "short", secret: Data([1, 2, 3])),
            device(id: "empty", secret: Data()),
            device(id: "good", secret: fixtureSecret)
        ], store: store)

        XCTAssertEqual(outcome.migrated, ["good"])
        XCTAssertEqual(outcome.skipped["short"], "stored secret is not 32 bytes")
        XCTAssertEqual(outcome.skipped["empty"], "stored secret is not 32 bytes")
        XCTAssertEqual(store.stored.map(\.pairedDeviceId), ["good"])
    }

    func testADirectConnectionIsNotMigrated() {
        let store = MemoryStudioServerStore()
        let outcome = StudioServerMigration.run(devices: [device(secret: fixtureSecret) { $0.connectionKind = "direct" }], store: store)
        XCTAssertTrue(outcome.migrated.isEmpty)
        XCTAssertEqual(store.saveCount, 0)
    }

    func testAStoreThatCannotBeReadMigratesNothing() {
        let store = MemoryStudioServerStore()
        store.failsLoad = true
        let outcome = StudioServerMigration.run(devices: [device(secret: fixtureSecret)], store: store)
        XCTAssertEqual(outcome, StudioServerMigration.Outcome())
    }

    func testAStoreThatCannotBeWrittenReportsNothingMigrated() {
        let store = MemoryStudioServerStore()
        store.failsSave = true
        let outcome = StudioServerMigration.run(devices: [device(secret: fixtureSecret)], store: store)
        XCTAssertTrue(outcome.migrated.isEmpty)
        XCTAssertEqual(outcome.skipped["old-device-id"], "could not be stored")
    }

    // MARK: - Relays

    func testAPreSharedKeyRelayIsCarriedOver() {
        let relays = StudioServerMigration.relays(from: device(secret: fixtureSecret) {
            $0.relayURL = "wss://relay.example.org"
            $0.relayAPIKey = "psk-1"
        })
        XCTAssertEqual(relays, [StudioEnvironmentRelay(url: "wss://relay.example.org", auth: .psk(key: "psk-1"))])
    }

    func testAnOIDCRelayIsCarriedOverWithItsIssuerAudienceAndScope() {
        let relays = StudioServerMigration.relays(from: device(secret: fixtureSecret) {
            $0.relayURL = "wss://relay.example.org"
            $0.relayAPIKey = ""
            $0.relayAuthMode = "oidc"
            $0.relayOidcIssuer = "https://login.example.org/tenant"
            $0.relayOidcAudience = "client-1"
            $0.relayOidcRequiredScope = "api://client-1/Relay.Access"
            $0.relayUrls = ["wss://relay.example.org", "wss://relay-2.example.org"]
        })
        let auth = StudioEnvironmentRelay.Auth.oidc(issuer: "https://login.example.org/tenant", audience: "client-1", scope: "api://client-1/Relay.Access")
        XCTAssertEqual(relays, [
            StudioEnvironmentRelay(url: "wss://relay.example.org", auth: auth),
            StudioEnvironmentRelay(url: "wss://relay-2.example.org", auth: auth)
        ])
    }

    func testALanOnlyPairingHasNoRelay() {
        let relays = StudioServerMigration.relays(from: device(secret: fixtureSecret) {
            $0.relayURL = "ws://192.168.1.20:19837"
            $0.relayAPIKey = "lan-direct"
        })
        XCTAssertTrue(relays.isEmpty)
    }
}
