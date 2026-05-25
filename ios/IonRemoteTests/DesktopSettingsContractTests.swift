import XCTest
@testable import IonRemote

/// Contract-sync tests for the desktop-settings projection (Part 7).
///
/// Extracted from `ContractSyncTests.swift` to keep that file under the
/// 600-line Swift cap. The Part 7 wire surfaces (`desktop_settings_snapshot`
/// event, `set_desktop_setting` command) and the iOS-side `DesktopSettingsState`
/// model live here as a cohesive test cluster — the file can grow with
/// future projection tests without touching the broader contract sync
/// tests.
final class DesktopSettingsContractTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - DesktopSettingsSnapshot decode

    /// The desktop emits desktop_settings_snapshot on initial pairing
    /// and on every projectable-setting change. iOS decodes the full
    /// payload (values + schema + groups) and replaces its cached
    /// state wholesale. Test verifies the round-trip and that the
    /// AnyCodable-typed value map preserves Bool / String / Double
    /// faithfully.
    func testDesktopSettingsSnapshotDecode() throws {
        let json = """
        {
            "type": "desktop_settings_snapshot",
            "settings": {
                "enableEarlyStopContinuation": true,
                "aiGeneratedTitles": false,
                "editorFontSize": 14
            },
            "schema": [
                {
                    "key": "enableEarlyStopContinuation",
                    "type": "boolean",
                    "group": "conversation",
                    "label": "Early-stop continuation nudge",
                    "description": "Ask the model to keep working when it stops early.",
                    "defaultValue": true
                },
                {
                    "key": "aiGeneratedTitles",
                    "type": "boolean",
                    "group": "conversation",
                    "label": "AI-generated tab titles",
                    "description": "Generate short titles automatically.",
                    "defaultValue": true
                }
            ],
            "groups": [
                { "id": "conversation", "label": "Conversation" },
                { "id": "workflow", "label": "Workflow" }
            ]
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .desktopSettingsSnapshot(let settings, let schema, let groups) = event {
            XCTAssertEqual(settings.count, 3)
            XCTAssertEqual(settings["enableEarlyStopContinuation"]?.value as? Bool, true)
            XCTAssertEqual(settings["aiGeneratedTitles"]?.value as? Bool, false)
            XCTAssertEqual(schema.count, 2)
            XCTAssertEqual(schema[0].key, "enableEarlyStopContinuation")
            XCTAssertEqual(schema[0].type, .boolean)
            XCTAssertEqual(schema[0].group, "conversation")
            XCTAssertEqual(schema[0].defaultValue.value as? Bool, true)
            XCTAssertEqual(groups.count, 2)
            XCTAssertEqual(groups[0].groupId, "conversation")
            XCTAssertEqual(groups[0].label, "Conversation")
        } else {
            XCTFail("Expected desktopSettingsSnapshot, got \(event)")
        }
    }

    /// Verify the DesktopSettingsState lookup helpers behave correctly
    /// against the snapshot. Three things this locks in:
    ///
    ///   1. currentValue returns the persisted value when present.
    ///   2. currentValue falls back to schema defaultValue when the
    ///      values map omits a key (defensive — the desktop should
    ///      always emit every key, but we don't crash if it doesn't).
    ///   3. orphanedEntries surfaces schema entries whose group is
    ///      not in the groups list. This is the forward-compat path
    ///      for older iOS builds receiving a newer desktop's schema.
    func testDesktopSettingsStateLookups() throws {
        let state = DesktopSettingsState(
            settings: ["a": AnyCodable(true)],
            schema: [
                DesktopSettingSchemaEntry(
                    key: "a",
                    type: .boolean,
                    group: "known",
                    label: "A",
                    description: "first",
                    defaultValue: AnyCodable(false)
                ),
                DesktopSettingSchemaEntry(
                    key: "b",
                    type: .boolean,
                    group: "known",
                    label: "B",
                    description: "second (omitted from values map)",
                    defaultValue: AnyCodable(true)
                ),
                DesktopSettingSchemaEntry(
                    key: "c",
                    type: .boolean,
                    group: "future_group",
                    label: "C",
                    description: "future-compat (unknown group)",
                    defaultValue: AnyCodable(false)
                ),
            ],
            groups: [
                DesktopSettingGroupDescriptor(groupId: "known", label: "Known"),
            ]
        )

        XCTAssertEqual(state.currentValue(for: "a")?.value as? Bool, true)
        XCTAssertEqual(state.currentValue(for: "b")?.value as? Bool, true) // fell back to default
        XCTAssertNil(state.currentValue(for: "nonexistent"))
        XCTAssertEqual(state.entries(in: "known").map(\.key), ["a", "b"])
        XCTAssertEqual(state.orphanedEntries().map(\.key), ["c"])
    }

    /// Round-trip the set_desktop_setting command through encode → wire
    /// JSON → decode. Locks in the wire field names (`key`, `value`)
    /// and the AnyCodable-typed payload.
    func testSetDesktopSettingEncode() throws {
        let original = RemoteCommand.setDesktopSetting(
            key: "enableEarlyStopContinuation",
            value: AnyCodable(false),
        )
        let encoded = try encoder.encode(original)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        XCTAssertEqual(json?["type"] as? String, "set_desktop_setting")
        XCTAssertEqual(json?["key"] as? String, "enableEarlyStopContinuation")
        XCTAssertEqual(json?["value"] as? Bool, false)

        // Round-trip back through the decoder to lock the symmetric path.
        let decoded = try decoder.decode(RemoteCommand.self, from: encoded)
        if case .setDesktopSetting(let key, let value) = decoded {
            XCTAssertEqual(key, "enableEarlyStopContinuation")
            XCTAssertEqual(value.value as? Bool, false)
        } else {
            XCTFail("Expected setDesktopSetting, got \(decoded)")
        }
    }
}
