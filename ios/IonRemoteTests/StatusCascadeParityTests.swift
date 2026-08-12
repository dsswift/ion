import XCTest
@testable import IonRemote

/// Cross-client tab-status cascade parity, iOS side.
///
/// The shared fixture pins precedence names and iOS reachability, never rank
/// integers. This test rejects both fixture entries absent from the iOS
/// declaration and iOS entries absent from the fixture.
final class StatusCascadeParityTests: XCTestCase {

    private struct Fixture: Decodable {
        let statuses: [Status]
    }

    private struct Status: Decodable, Equatable {
        let name: String
        let semantics: String
        let iosReachable: Bool
    }

    private func loadFixture() throws -> Fixture {
        let candidates = [
            "../assets/design-system/status-cascade.json", // cwd = ios/
            "assets/design-system/status-cascade.json", // cwd = repo root
        ]
        for candidate in candidates {
            let url = URL(fileURLWithPath: candidate)
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
            }
        }
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<5 {
            directory = directory.deletingLastPathComponent()
            let candidate = directory.appendingPathComponent("assets/design-system/status-cascade.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
            }
        }
        throw FixtureError.notFound
    }

    private enum FixtureError: Error {
        case notFound
    }

    func testFixtureMatchesTheFullIOSDeclarationInOrder() throws {
        let fixture = try loadFixture()
        let declared = TabStatusRollup.statusCascade.map {
            Status(name: $0.name, semantics: "", iosReachable: $0.iosReachable)
        }
        let expected = fixture.statuses.map {
            Status(name: $0.name, semantics: "", iosReachable: $0.iosReachable)
        }

        XCTAssertEqual(declared, expected)
    }

    func testFixtureMarksOnlyWireReachableStatusesForIOS() throws {
        let fixture = try loadFixture()
        let fixtureReachable = fixture.statuses.filter(\.iosReachable).map(\.name)
        let declaredReachable = TabStatusRollup.statusCascade
            .filter(\.iosReachable)
            .map(\.name)

        XCTAssertEqual(declaredReachable, fixtureReachable)
        XCTAssertFalse(fixture.statuses.first { $0.name == "bash" }!.iosReachable)
        XCTAssertFalse(fixture.statuses.first { $0.name == "unread" }!.iosReachable)
    }

    func testFixtureGivesEveryStatusSemantics() throws {
        for status in try loadFixture().statuses {
            XCTAssertFalse(status.semantics.isEmpty, "\(status.name) needs semantics")
        }
    }
}
