import CryptoKit
import XCTest
@testable import IonRemote

/// Tests for `TransportManager.matchingLANHost` desktopId-first matching.
final class BonjourMatchingTests: XCTestCase {

    private func makeHost(
        name: String,
        metadata: [String: String] = [:]
    ) -> DiscoveredService {
        DiscoveredService(
            id: "ionDirect:\(name)",
            kind: .ionDirect,
            name: name,
            host: "192.168.1.1",
            port: 10101,
            metadata: metadata
        )
    }

    private func makeTM() -> TransportManager {
        let key = SymmetricKey(data: Data(repeating: 0xAA, count: 32))
        return TransportManager(sharedKey: key, deviceId: "test-device")
    }

    // MARK: - desktopId matching

    func testMatchesByDesktopIdOverHostname() {
        let tm = makeTM()
        tm.deviceName = "WrongName"
        tm.pairedDesktopId = "desktop-uuid-123"

        let wrongName = makeHost(name: "WrongName")
        let rightId = makeHost(name: "OtherName", metadata: ["desktopId": "desktop-uuid-123"])

        let match = tm.matchingLANHost([wrongName, rightId])
        XCTAssertEqual(match?.name, "OtherName", "desktopId match should take priority over hostname")
    }

    func testFallsBackToHostnameWhenNoDesktopIdMatch() {
        let tm = makeTM()
        tm.deviceName = "MyMac"
        tm.pairedDesktopId = "desktop-uuid-999"

        let hostMatch = makeHost(name: "MyMac")
        let other = makeHost(name: "OtherMac", metadata: ["desktopId": "desktop-uuid-000"])

        let match = tm.matchingLANHost([hostMatch, other])
        XCTAssertEqual(match?.name, "MyMac", "should fall back to hostname when desktopId doesn't match")
    }

    func testFallsBackToHostnameWhenNoDesktopIdSet() {
        let tm = makeTM()
        tm.deviceName = "MyMac"

        let host = makeHost(name: "MyMac", metadata: ["desktopId": "some-id"])

        let match = tm.matchingLANHost([host])
        XCTAssertEqual(match?.name, "MyMac")
    }

    func testFallsBackToFirstHostWhenNothingMatches() {
        let tm = makeTM()
        let host = makeHost(name: "SomeMac")

        let match = tm.matchingLANHost([host])
        XCTAssertEqual(match?.name, "SomeMac")
    }

    func testReturnsNilForEmptyList() {
        let tm = makeTM()
        tm.pairedDesktopId = "desktop-uuid"
        tm.deviceName = "MyMac"

        XCTAssertNil(tm.matchingLANHost([]))
    }

    func testIgnoresRelayHosts() {
        let tm = makeTM()
        tm.pairedDesktopId = "desktop-uuid"

        let relay = DiscoveredService(
            id: "relay:r1", kind: .relay, name: "relay",
            host: "10.0.0.1", port: 443,
            metadata: ["desktopId": "desktop-uuid"]
        )
        let ion = makeHost(name: "Mac", metadata: ["desktopId": "desktop-uuid"])

        let match = tm.matchingLANHost([relay, ion])
        XCTAssertEqual(match?.name, "Mac", "relay hosts should be filtered out")
    }

    func testEmptyDesktopIdStringSkipsIdMatching() {
        let tm = makeTM()
        tm.pairedDesktopId = ""
        tm.deviceName = "MyMac"

        let host = makeHost(name: "MyMac")
        let match = tm.matchingLANHost([host])
        XCTAssertEqual(match?.name, "MyMac")
    }
}
