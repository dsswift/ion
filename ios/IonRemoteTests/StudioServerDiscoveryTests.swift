import XCTest
@testable import IonRemote

/// Finding an Ion Studio Server on the LAN and pairing with its own short
/// code — the path that reaches a server with no desktop in between.
final class StudioServerDiscoveryTests: XCTestCase {

    private func server(id: String = "studioServer:x", machine: String? = nil, environment: String? = nil, label: String? = "oscar", host: String = "192.168.1.9") -> DiscoveredService {
        var txt: [String: String] = [:]
        if let machine { txt["machine"] = machine }
        if let environment { txt["id"] = environment }
        if let label { txt["label"] = label }
        return DiscoveredService(id: id, name: "Ion Studio (oscar)", host: host, port: 7331, metadata: txt)
    }

    private func record(machineId: String? = nil, environmentId: String? = nil) -> StudioServerRecord {
        StudioServerRecord(
            clientId: "client-1", secret: Data(repeating: 7, count: 32), url: nil,
            environmentId: environmentId, machineId: machineId, label: "host", relays: [], pairedDeviceId: nil
        )
    }

    // The announced port is the Studio wire's, where the server answers
    // `/auth/pair` and `/auth/config`.
    func testAStudioServersBaseURLIsItsAnnouncedHostAndPort() {
        XCTAssertEqual(server().studioServerURL, URL(string: "http://192.168.1.9:7331"))
    }

    // Matching reads the TXT record's machine and environment ids. A plain
    // `.bonjour` browse delivers every service with no TXT at all, so the
    // phone saw its own server announced and still called it a stranger.
    func testTheBrowseAsksForEachServicesTXTRecord() {
        guard case .bonjourWithTXTRecord(let type, _) = BonjourBrowser.descriptor(for: "_ion-studio._tcp") else {
            return XCTFail("the browse descriptor must carry TXT records")
        }
        XCTAssertEqual(type, "_ion-studio._tcp")
    }

    func testDisplayNamePrefersTheAnnouncedLabelOverTheDecoratedInstanceName() {
        XCTAssertEqual(server().displayName, "oscar")
        XCTAssertEqual(server(label: nil).displayName, "Ion Studio (oscar)")
    }

    // A pairing carried over from the older wire knows its server only by the
    // host's machine id, which the announcement repeats.
    func testAPairedServerIsMatchedByItsMachineId() {
        let services = [server(id: "a", machine: "machine-2", host: "192.168.1.8"), server(id: "b", machine: "machine-1")]
        XCTAssertEqual(StudioServerDiscovery.match(for: record(machineId: "machine-1"), in: services)?.id, "b")
    }

    func testAPairedServerIsMatchedByItsEnvironmentIdWhenItHasNoMachineId() {
        let services = [server(id: "a", environment: "env-2"), server(id: "b", environment: "env-1")]
        XCTAssertEqual(StudioServerDiscovery.match(for: record(environmentId: "env-1"), in: services)?.id, "b")
    }

    func testAnotherServerOnTheNetworkIsNeverMistakenForThePairedOne() {
        let services = [server(id: "a", machine: "machine-2", environment: "env-2")]
        XCTAssertNil(StudioServerDiscovery.match(for: record(machineId: "machine-1", environmentId: "env-1"), in: services))
        XCTAssertNil(StudioServerDiscovery.match(for: record(), in: services))
    }

}

/// The short code's rules, which must match the server's
/// (`packages/shared/src/discovery-code.ts`). A phone that disagrees would
/// refuse a code the server considers valid.
final class DiscoveryCodeTests: XCTestCase {

    func testNormalizeDropsTheDashAndUpperCases() {
        XCTAssertEqual(DiscoveryCode.normalize("fsse-2s5j"), "FSSE2S5J")
        XCTAssertEqual(DiscoveryCode.normalize("FSSE 2S5J"), "FSSE2S5J")
    }

    // No I, L, O, 0 or 1: the alphabet has no look-alikes, so a code read off
    // a screen cannot be mistyped into a different valid code.
    func testLookAlikeCharactersAreNotPartOfACode() {
        for c in ["I", "L", "O", "0", "1"] {
            XCTAssertFalse(DiscoveryCode.alphabet.contains(c), "\(c) must not be in the alphabet")
        }
        XCTAssertEqual(DiscoveryCode.normalize("FSSE2S5I"), "FSSE2S5")
        XCTAssertFalse(DiscoveryCode.isComplete(DiscoveryCode.normalize("FSSE2S5I")))
    }

    func testIsCompleteOnlyForAFullLegalCode() {
        XCTAssertTrue(DiscoveryCode.isComplete("FSSE2S5J"))
        XCTAssertFalse(DiscoveryCode.isComplete("FSSE2S5"))
        XCTAssertFalse(DiscoveryCode.isComplete("FSSE2S5JX"))
    }

    func testGroupedShowsTheCodeTheWayTheServerPrintsIt() {
        XCTAssertEqual(DiscoveryCode.grouped("FSSE2S5J"), "FSSE-2S5J")
        XCTAssertEqual(DiscoveryCode.grouped("FSS"), "FSS")
        XCTAssertEqual(DiscoveryCode.grouped("fsse2"), "FSSE-2")
    }
}
