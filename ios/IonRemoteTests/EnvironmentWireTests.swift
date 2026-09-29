import XCTest
@testable import IonRemote

/// Pins the wire contract for the environment fields added in child 19
/// (Ion Studio Server): `RemoteTabState.environmentId`/`environmentLabel`,
/// and that a snapshot still carrying the retired `environmentPolicy` decodes. The critical
/// nonfunctional requirement from the spec is that an older server/desktop
/// that predates these fields decodes exactly as it did before they
/// existed — every test below has an absence case pinning that.
final class EnvironmentWireTests: XCTestCase {

    // MARK: - RemoteTabState.environmentId / environmentLabel

    func testDecodesEnvironmentFieldsWhenPresent() throws {
        let json = """
        {
            "id": "tab-1",
            "title": "Fix login bug",
            "customTitle": null,
            "status": "idle",
            "workingDirectory": "/repo",
            "permissionMode": "auto",
            "permissionQueue": [],
            "environmentId": "env-abc123",
            "environmentLabel": "Acme Prod"
        }
        """.data(using: .utf8)!

        let tab = try JSONDecoder().decode(RemoteTabState.self, from: json)
        XCTAssertEqual(tab.environmentId, "env-abc123")
        XCTAssertEqual(tab.environmentLabel, "Acme Prod")
    }

    /// The nonfunctional requirement: a server/desktop snapshot that predates
    /// environment support omits both fields entirely. Decoding must not
    /// throw, and both fields must be nil — the exact pre-child-19 shape.
    func testDecodesCleanlyWhenEnvironmentFieldsAbsent() throws {
        let json = """
        {
            "id": "tab-1",
            "title": "Fix login bug",
            "customTitle": null,
            "status": "idle",
            "workingDirectory": "/repo",
            "permissionMode": "auto",
            "permissionQueue": []
        }
        """.data(using: .utf8)!

        let tab = try JSONDecoder().decode(RemoteTabState.self, from: json)
        XCTAssertNil(tab.environmentId)
        XCTAssertNil(tab.environmentLabel)
    }

    /// A tab with an environment id but no human label (server hasn't set
    /// `server.json`'s `label`) still decodes — `environmentLabel` alone is
    /// optional, independent of `environmentId`.
    func testDecodesEnvironmentIdWithoutLabel() throws {
        let json = """
        {
            "id": "tab-1",
            "title": "Fix login bug",
            "customTitle": null,
            "status": "idle",
            "workingDirectory": "/repo",
            "permissionMode": "auto",
            "permissionQueue": [],
            "environmentId": "env-abc123"
        }
        """.data(using: .utf8)!

        let tab = try JSONDecoder().decode(RemoteTabState.self, from: json)
        XCTAssertEqual(tab.environmentId, "env-abc123")
        XCTAssertNil(tab.environmentLabel)
    }

    // MARK: - desktop_settings_snapshot.environmentPolicy

    /// The desktop's environment policy is its own device policy and no
    /// longer rides the phone's settings snapshot; a server that still sends
    /// the key decodes the same as one that does not.
    func testASnapshotStillCarryingEnvironmentPolicyDecodes() throws {
        let json = """
        { "type": "desktop_settings_snapshot", "settings": {}, "schema": [], "groups": [], "environmentPolicy": {"mode": "allowlist"} }
        """
        let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(json.utf8))
        guard case .desktopSettingsSnapshot(let settings, let schema, _, _, _, _, _) = event else {
            return XCTFail("expected desktopSettingsSnapshot, got \(event)")
        }
        XCTAssertTrue(settings.isEmpty)
        XCTAssertTrue(schema.isEmpty)
    }

    // MARK: - RemoteEnvironmentEntry (ManagedEnvironments merge)

}
