import XCTest
@testable import IonRemote

/// Decode tests for RemoteTabState fields that use non-trivial CodingKey
/// mappings: convFingerprint and engineProfileId.
///
/// Each test also has a "goes red on wrong CodingKey" companion assertion
/// that decodes a payload with a deliberately wrong key and verifies the
/// field decodes as nil — confirming the test would fail if the CodingKey
/// were renamed.
final class RemoteTabStateDecodeTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Minimal tab fixture

    /// Minimal valid RemoteTabState JSON — only the required fields.
    private func minimalTab(extra: String = "") -> Data {
        """
        { "id": "tab-1", "title": "Test", "status": "idle",
          "workingDirectory": "/tmp", "permissionMode": "auto",
          "permissionQueue": []
          \(extra.isEmpty ? "" : ", \(extra)")
        }
        """.data(using: .utf8)!
    }

    // MARK: - convFingerprint

    func testConvFingerprintDecodes() throws {
        let data = minimalTab(extra: #""convFingerprint": "abc123""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.convFingerprint, "abc123",
            "convFingerprint should decode from the 'convFingerprint' JSON key")
    }

    func testConvFingerprintNilWhenAbsent() throws {
        let data = minimalTab()
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.convFingerprint,
            "convFingerprint should be nil when key is absent (back-compat)")
    }

    /// Goes red on wrong CodingKey: if the Swift property were mapped to a
    /// different JSON key (e.g. "conv_fingerprint"), this assertion fails.
    func testConvFingerprintWrongKeyDecodesNil() throws {
        // Use a snake_case key that would match a misnamed CodingKey.
        let data = minimalTab(extra: #""conv_fingerprint": "should-not-decode""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.convFingerprint,
            "convFingerprint must not decode from 'conv_fingerprint' — wrong key")
    }

    // MARK: - engineProfileId

    func testEngineProfileIdDecodes() throws {
        let data = minimalTab(extra: #""engineProfileId": "profile-xyz""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.engineProfileId, "profile-xyz",
            "engineProfileId should decode from the 'engineProfileId' JSON key")
    }

    func testEngineProfileIdNilWhenAbsent() throws {
        let data = minimalTab()
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.engineProfileId,
            "engineProfileId should be nil when key is absent (back-compat)")
    }

    /// Goes red on wrong CodingKey: decoding from 'engine_profile_id' must yield nil.
    func testEngineProfileIdWrongKeyDecodesNil() throws {
        let data = minimalTab(extra: #""engine_profile_id": "should-not-decode""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.engineProfileId,
            "engineProfileId must not decode from 'engine_profile_id' — wrong key")
    }


    // MARK: - Per-instance startup state

    func testConversationInstanceStartingDecodesFromSnapshot() throws {
        let data = minimalTab(extra: #""conversationInstances": [{"id": "main", "label": "Main", "agentStates": [], "isStarting": true}]"#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)

        XCTAssertEqual(tab.conversationInstances?.first?.isStarting, true,
            "isStarting should decode from the per-instance snapshot key")
    }

    func testConversationInstanceStartingIsNilWhenAbsent() throws {
        let data = minimalTab(extra: #""conversationInstances": [{"id": "main", "label": "Main", "agentStates": []}]"#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)

        XCTAssertNil(tab.conversationInstances?.first?.isStarting,
            "isStarting should be nil when older desktops omit the key")
    }

    func testConversationInstanceStartingUsesCamelCaseWireKey() throws {
        let data = minimalTab(extra: #""conversationInstances": [{"id": "main", "label": "Main", "is_starting": true}]"#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)

        XCTAssertNil(tab.conversationInstances?.first?.isStarting,
            "isStarting must not decode from the wrong snake_case key")
    }

    func testConversationInstanceStartingEncodesWithCamelCaseWireKey() throws {
        let instance = ConversationInstanceInfo(id: "main", label: "Main", isStarting: true)
        let data = try JSONEncoder().encode(instance)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["isStarting"] as? Bool, true)
        XCTAssertNil(object["is_starting"])
    }

    // MARK: - Both fields together

    func testBothFieldsDecodeFromSamePayload() throws {
        let data = minimalTab(extra: #""convFingerprint": "fp-1", "engineProfileId": "prof-2""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.convFingerprint, "fp-1")
        XCTAssertEqual(tab.engineProfileId, "prof-2")
    }

    // MARK: - latest run metadata

    func testLatestRunMetadataDecodes() throws {
        let data = minimalTab(extra: #""lastRunDurationMs": 62007, "lastRunReason": "aborted""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.lastRunDurationMs, 62_007)
        XCTAssertEqual(tab.lastRunReason, .aborted)
    }

    func testLatestRunMetadataNilWhenAbsent() throws {
        let tab = try decoder.decode(RemoteTabState.self, from: minimalTab())
        XCTAssertNil(tab.lastRunDurationMs)
        XCTAssertNil(tab.lastRunReason)
    }

    // MARK: - execution host identity

    func testExecutionHostAndMachineDecode() throws {
        let data = minimalTab(extra: #""executionHost": "build-host", "executionMachineId": "machine-42""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.executionHost, "build-host")
        XCTAssertEqual(tab.executionMachineId, "machine-42")
    }

    func testExecutionIdentityIsAbsentOnLegacySnapshots() throws {
        let tab = try decoder.decode(RemoteTabState.self, from: minimalTab())
        XCTAssertNil(tab.executionHost)
        XCTAssertNil(tab.executionMachineId)
    }

    // MARK: - inputLocked (auto-generated conflict-fix conversations)

    func testInputLockedDecodesTrue() throws {
        let data = minimalTab(extra: #""inputLocked": true"#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.inputLocked, true,
            "inputLocked should decode from the 'inputLocked' JSON key")
    }

    /// A desktop that omits the field (every tab today except assist tabs, and
    /// every pre-fix desktop) must decode as unlocked, not fail the payload.
    func testInputLockedNilWhenAbsent() throws {
        let data = minimalTab()
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.inputLocked,
            "inputLocked should be nil when key is absent (back-compat, reads as unlocked)")
    }

    // MARK: - inputLockReason (settled conversations)

    func testInputLockReasonSettledDecodes() throws {
        let data = minimalTab(extra: #""inputLocked": true, "inputLockReason": "settled""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.inputLocked, true)
        XCTAssertEqual(tab.inputLockReason, "settled",
            "inputLockReason 'settled' must decode for settled-conversation input lock")
    }

    func testInputLockReasonLandedWorktreeDecodes() throws {
        let data = minimalTab(extra: #""inputLocked": true, "inputLockReason": "landed-worktree""#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.inputLockReason, "landed-worktree")
    }

    func testInputLockReasonNilWhenAbsent() throws {
        let data = minimalTab(extra: #""inputLocked": true"#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertNil(tab.inputLockReason,
            "inputLockReason should be nil when key is absent (falls through to automated-workflow copy)")
    }

    // MARK: - createdAt (the "Newest created" inbox sort key)

    func testCreatedAtDecodes() throws {
        let data = minimalTab(extra: #""createdAt": 1234567890"#)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.createdAt, 1_234_567_890)
    }

    func testCreatedAtNilWhenAbsent() throws {
        let tab = try decoder.decode(RemoteTabState.self, from: minimalTab())
        XCTAssertNil(tab.createdAt, "older desktops omit createdAt; must decode nil")
    }

    // MARK: - worktree identity (desktop-parity inbox grouping)

    func testWorktreeIdentityDecodes() throws {
        let data = minimalTab(extra: """
        "worktree": { "worktreePath": "/wt/ion-abc", "branchName": "wt/ion-abc",
                      "sourceBranch": "josh", "repoPath": "/repo/ion", "landedAt": 99 }
        """)
        let tab = try decoder.decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.worktree?.worktreePath, "/wt/ion-abc")
        XCTAssertEqual(tab.worktree?.branchName, "wt/ion-abc")
        XCTAssertEqual(tab.worktree?.sourceBranch, "josh")
        XCTAssertEqual(tab.worktree?.repoPath, "/repo/ion")
        XCTAssertEqual(tab.worktree?.landedAt, 99)
    }

    func testWorktreeIdentityNilForRepoRootTabs() throws {
        let tab = try decoder.decode(RemoteTabState.self, from: minimalTab())
        XCTAssertNil(tab.worktree, "repo-root conversations carry no worktree identity")
    }
}

extension RemoteTabStateDecodeTests {
    func testDesktopSnapshotProjectsDecodeWithAllAgreedFields() throws {
        let json = """
        {"type":"desktop_snapshot","tabs":[],"projects":[{
          "directory":"/project","displayName":"Project","isDefault":true,
          "managed":false,"profileAction":"profile","profileId":"profile-1",
          "profileSource":"project","hasOverride":true
        }]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case let .snapshot(_, _, _, _, _, _, _, _, _, _, _, projects, _, _) = event else {
            return XCTFail("Expected desktop snapshot")
        }
        let project = try XCTUnwrap(projects.first)
        XCTAssertEqual(project.directory, "/project")
        XCTAssertEqual(project.displayName, "Project")
        XCTAssertTrue(project.isDefault)
        XCTAssertFalse(project.managed)
        XCTAssertEqual(project.profileAction, "profile")
        XCTAssertEqual(project.profileId, "profile-1")
        XCTAssertEqual(project.profileSource, "project")
        XCTAssertTrue(project.hasOverride)
    }

    func testDesktopSnapshotProjectsAreOptionalForOlderDesktops() throws {
        let json = #"{"type":"desktop_snapshot","tabs":[]}"#.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case let .snapshot(_, _, _, _, _, _, _, _, _, _, _, projects, _, _) = event else {
            return XCTFail("Expected desktop snapshot")
        }
        XCTAssertTrue(projects.isEmpty)
    }
}
