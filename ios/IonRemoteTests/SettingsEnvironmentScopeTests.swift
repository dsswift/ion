import XCTest
@testable import IonRemote

/// An Environment setting is one value for the whole server. The snapshot
/// says whether this phone's connection may change it (`canManageEnvironment`,
/// the `admin` scope) and each schema entry names its `scope`. The phone
/// shows such a setting either way, and offers the edit only when it may make
/// it: the server refuses the write regardless.
final class SettingsEnvironmentScopeTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func snapshot(canManage: String?) -> Data {
        """
        {
            "type": "desktop_settings_snapshot",
            "settings": { "inboxAutoSettleDays": 3, "gitOpsMode": "manual" },
            "schema": [
                { "key": "inboxAutoSettleDays", "type": "number", "group": "tabs", "label": "Auto-settle", "description": "", "defaultValue": 0, "scope": "environment" },
                { "key": "gitOpsMode", "type": "string", "group": "git", "label": "Git mode", "description": "", "defaultValue": "manual", "scope": "account" }
            ],
            "groups": [{ "id": "tabs", "label": "Tabs" }, { "id": "git", "label": "Git" }]
            \(canManage.map { ", \"canManageEnvironment\": \($0)" } ?? "")
        }
        """.data(using: .utf8)!
    }

    private func state(canManage: String?) throws -> ServerSettingsState {
        let event = try decoder.decode(RemoteEvent.self, from: snapshot(canManage: canManage))
        guard case .desktopSettingsSnapshot(let settings, let schema, let groups, _, _, let canManageEnvironment, _) = event else {
            XCTFail("decoded to the wrong case: \(event)")
            throw CancellationError()
        }
        return ServerSettingsState(settings: settings, schema: schema, groups: groups, canManageEnvironment: canManageEnvironment ?? false)
    }

    func testEnvironmentEntryIsReadOnlyWithoutAdmin() throws {
        let state = try state(canManage: "false")
        let autoSettle = try XCTUnwrap(state.schema.first { $0.key == "inboxAutoSettleDays" })
        let gitMode = try XCTUnwrap(state.schema.first { $0.key == "gitOpsMode" })
        XCTAssertEqual(autoSettle.scope, "environment")
        XCTAssertTrue(state.isReadOnly(autoSettle), "a server-wide setting must not be editable without admin")
        XCTAssertFalse(state.isReadOnly(gitMode), "a person's own setting on the server stays editable")
    }

    func testEnvironmentEntryIsEditableWithAdmin() throws {
        let state = try state(canManage: "true")
        let autoSettle = try XCTUnwrap(state.schema.first { $0.key == "inboxAutoSettleDays" })
        XCTAssertFalse(state.isReadOnly(autoSettle))
    }

    /// A server that does not say is treated as "no": the edit is withheld
    /// rather than offered and refused.
    func testAbsentFlagMeansReadOnly() throws {
        let state = try state(canManage: nil)
        let autoSettle = try XCTUnwrap(state.schema.first { $0.key == "inboxAutoSettleDays" })
        XCTAssertTrue(state.isReadOnly(autoSettle))
    }
}

/// The phone's own settings are its Personal and Device entries, whatever
/// group the server files them in.
final class SettingsThisPhoneSectionTests: XCTestCase {
    func testClientOwnedEntriesArePersonalAndDeviceOnly() {
        func entry(_ key: String, _ scope: String) -> ServerSettingSchemaEntry {
            var e = ServerSettingSchemaEntry(key: key, type: .boolean, group: "general", label: key, description: "", defaultValue: AnyCodable(false), choices: nil, range: nil, itemSchema: nil, itemType: nil)
            e.scope = scope
            return e
        }
        let state = ServerSettingsState(
            settings: [:],
            schema: [entry("streamThinkingToRemote", "environment"), entry("aiGeneratedTitles", "personal"), entry("showTodoList", "device"), entry("usageLimitAutoResume", "account")],
            groups: [ServerSettingGroupDescriptor(groupId: "general", label: "General")]
        )
        XCTAssertEqual(state.clientOwnedEntries().map(\.key), ["aiGeneratedTitles", "showTodoList"])
        XCTAssertEqual(state.clientOwnedKeys, ["aiGeneratedTitles", "showTodoList"])
    }
}
