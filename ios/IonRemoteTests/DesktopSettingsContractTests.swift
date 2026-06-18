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
                    defaultValue: AnyCodable(false),
                    choices: nil,
                    range: nil,
                    itemSchema: nil,
                    itemType: nil
                ),
                DesktopSettingSchemaEntry(
                    key: "b",
                    type: .boolean,
                    group: "known",
                    label: "B",
                    description: "second (omitted from values map)",
                    defaultValue: AnyCodable(true),
                    choices: nil,
                    range: nil,
                    itemSchema: nil,
                    itemType: nil
                ),
                DesktopSettingSchemaEntry(
                    key: "c",
                    type: .boolean,
                    group: "future_group",
                    label: "C",
                    description: "future-compat (unknown group)",
                    defaultValue: AnyCodable(false),
                    choices: nil,
                    range: nil,
                    itemSchema: nil,
                    itemType: nil
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
        XCTAssertEqual(json?["type"] as? String, "desktop_set_desktop_setting")
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

    // MARK: - New wire types: enum + list

    /// Enum-typed schema entries carry a `choices` array. Each choice's
    /// `value` is either a string or null (the "None" choice for
    /// nullable enums like the three tab-group pointer keys). Verify
    /// the wire round-trip preserves both the string-value and
    /// null-value forms.
    func testDesktopSettingsEnumDecode() throws {
        let json = """
        {
            "type": "desktop_settings_snapshot",
            "settings": {
                "gitOpsMode": "worktree",
                "planningGroupId": null
            },
            "schema": [
                {
                    "key": "gitOpsMode",
                    "type": "enum",
                    "group": "git",
                    "label": "GitOps Mode",
                    "description": "Manual or worktree.",
                    "defaultValue": "manual",
                    "choices": [
                        { "value": "manual", "label": "Manual" },
                        { "value": "worktree", "label": "Worktree" }
                    ]
                },
                {
                    "key": "planningGroupId",
                    "type": "enum",
                    "group": "tabs",
                    "label": "Planning group",
                    "description": "Group tabs auto-move to in plan mode.",
                    "defaultValue": null,
                    "choices": [
                        { "value": null, "label": "None" },
                        { "value": "g1", "label": "Backlog" }
                    ]
                }
            ],
            "groups": [
                { "id": "git", "label": "Git" },
                { "id": "tabs", "label": "Tabs & Panels" }
            ]
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .desktopSettingsSnapshot(let settings, let schema, _) = event else {
            XCTFail("expected desktopSettingsSnapshot")
            return
        }

        // Value side: planningGroupId is null over the wire. AnyCodable
        // preserves null as NSNull. The view treats NSNull and missing
        // values identically (both fall through to "None").
        XCTAssertEqual(settings["gitOpsMode"]?.value as? String, "worktree")
        XCTAssertTrue(settings["planningGroupId"]?.value is NSNull)

        // Schema side: choices decoded into Swift, including the
        // null-valued choice.
        let gitOps = schema.first { $0.key == "gitOpsMode" }
        XCTAssertEqual(gitOps?.type, .enumType)
        XCTAssertEqual(gitOps?.choices?.count, 2)
        XCTAssertEqual(gitOps?.choices?[0].label, "Manual")
        XCTAssertEqual(gitOps?.choices?[0].value.value as? String, "manual")

        let planning = schema.first { $0.key == "planningGroupId" }
        XCTAssertEqual(planning?.choices?.count, 2)
        XCTAssertEqual(planning?.choices?[0].label, "None")
        // The first choice's value is JSON null. AnyCodable decodes
        // null as NSNull; with the non-optional `value: AnyCodable`
        // declaration, that NSNull survives end-to-end and the view's
        // `selectionKey` returns the empty string for it.
        XCTAssertTrue(planning?.choices?[0].value.value is NSNull)
        XCTAssertEqual(planning?.choices?[1].value.value as? String, "g1")
    }

    /// List-typed schema entries carry an `itemSchema` describing the
    /// per-record fields. The editor reuses the schema entry shape
    /// recursively for the nested rows.
    func testDesktopSettingsListDecode() throws {
        let json = """
        {
            "type": "desktop_settings_snapshot",
            "settings": {
                "quickTools": [
                    { "id": "a", "name": "Build", "icon": "Hammer", "command": "make" }
                ]
            },
            "schema": [
                {
                    "key": "quickTools",
                    "type": "list",
                    "group": "quicktools",
                    "label": "Quick tools",
                    "description": "Custom shell-command buttons.",
                    "defaultValue": [],
                    "itemSchema": [
                        {
                            "key": "id",
                            "type": "string",
                            "group": "quicktools",
                            "label": "ID",
                            "description": "Auto-assigned.",
                            "defaultValue": ""
                        },
                        {
                            "key": "name",
                            "type": "string",
                            "group": "quicktools",
                            "label": "Name",
                            "description": "Display label.",
                            "defaultValue": ""
                        }
                    ]
                }
            ],
            "groups": [
                { "id": "quicktools", "label": "Quick Tools" }
            ]
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .desktopSettingsSnapshot(let settings, let schema, _) = event else {
            XCTFail("expected desktopSettingsSnapshot")
            return
        }

        // Value side: the list is an array of dictionaries (AnyCodable
        // decodes nested objects as [String: AnyCodable]).
        let tools = settings["quickTools"]?.value as? [AnyCodable]
        XCTAssertEqual(tools?.count, 1)
        let first = tools?[0].value as? [String: AnyCodable]
        XCTAssertEqual(first?["name"]?.value as? String, "Build")
        XCTAssertEqual(first?["command"]?.value as? String, "make")

        // Schema side: itemSchema preserved.
        let quickTools = schema.first { $0.key == "quickTools" }
        XCTAssertEqual(quickTools?.type, .list)
        XCTAssertEqual(quickTools?.itemSchema?.count, 2)
        XCTAssertEqual(quickTools?.itemSchema?[0].key, "id")
        XCTAssertEqual(quickTools?.itemSchema?[1].key, "name")
    }

    /// Number-typed schema entries may carry a `range`. When present,
    /// the iOS Stepper uses it to clamp +/- and pick a step. When
    /// absent, the view falls back to a permissive default. Verify
    /// the wire decode preserves the range when present.
    func testDesktopSettingsNumberRangeDecode() throws {
        let json = """
        {
            "type": "desktop_settings_snapshot",
            "settings": { "uiZoom": 1.5 },
            "schema": [
                {
                    "key": "uiZoom",
                    "type": "number",
                    "group": "appearance",
                    "label": "UI zoom",
                    "description": "Overall zoom level.",
                    "defaultValue": 1,
                    "range": { "min": 0.5, "max": 2.0, "step": 0.1 }
                }
            ],
            "groups": [ { "id": "appearance", "label": "Appearance" } ]
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .desktopSettingsSnapshot(_, let schema, _) = event else {
            XCTFail("expected desktopSettingsSnapshot")
            return
        }
        let entry = schema.first { $0.key == "uiZoom" }
        XCTAssertEqual(entry?.range?.min, 0.5)
        XCTAssertEqual(entry?.range?.max, 2.0)
        XCTAssertEqual(entry?.range?.step, 0.1)
    }

    /// Primitive-list schema entries (`list` + `itemType`) decode the
    /// itemType field and the value as a flat `[String]` (or `[Number]`,
    /// `[Bool]` for the other primitive types). Mirrors the desktop's
    /// `planModeAllowedBashCommands` projection shape.
    ///
    /// This pins the iOS half of the round-trip that the original
    /// BLOCKER finding addressed: the desktop preference is `string[]`,
    /// the projection declares `itemType: 'string'`, and iOS must
    /// decode both halves so its primitive-list editor renders the
    /// right control (TextField per row) and writes back an array
    /// (not a CSV string).
    func testDesktopSettingsPrimitiveListDecode() throws {
        let json = """
        {
            "type": "desktop_settings_snapshot",
            "settings": {
                "planModeAllowedBashCommands": ["gh", "git log", "git diff"]
            },
            "schema": [
                {
                    "key": "planModeAllowedBashCommands",
                    "type": "list",
                    "itemType": "string",
                    "group": "ai",
                    "label": "Plan mode allowed Bash commands",
                    "description": "Command prefixes the agent may invoke via Bash while in plan mode.",
                    "defaultValue": ["gh"]
                }
            ],
            "groups": [
                { "id": "ai", "label": "AI & Models" }
            ]
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .desktopSettingsSnapshot(let settings, let schema, _) = event else {
            XCTFail("expected desktopSettingsSnapshot, got \(event)")
            return
        }
        let entry = schema.first { $0.key == "planModeAllowedBashCommands" }
        XCTAssertNotNil(entry, "primitive-list entry must decode")
        XCTAssertEqual(entry?.type, .list, "primitive-list still uses the 'list' wire type")
        XCTAssertEqual(entry?.itemType, .string, "itemType disambiguates record-list vs primitive-list")
        XCTAssertNil(entry?.itemSchema, "primitive-list does not carry an itemSchema")

        // Value decodes as an array of AnyCodable wrapping String.
        let values = settings["planModeAllowedBashCommands"]?.value as? [AnyCodable]
        XCTAssertEqual(values?.count, 3)
        XCTAssertEqual(values?[0].value as? String, "gh")
        XCTAssertEqual(values?[1].value as? String, "git log")
        XCTAssertEqual(values?[2].value as? String, "git diff")

        // Default value decodes as [AnyCodable] too, so the editor's
        // fallback path (when the snapshot omits the key) renders the
        // correct shape.
        let defaultValues = entry?.defaultValue.value as? [AnyCodable]
        XCTAssertEqual(defaultValues?.count, 1)
        XCTAssertEqual(defaultValues?[0].value as? String, "gh")
    }

    // MARK: - Extended-thinking projection toggle (issue #158)

    /// Parity test for the `streamThinkingToRemote` projection toggle.
    ///
    /// This setting is the desktop's per-pairing low-bandwidth control: when
    /// off, the desktop suppresses thinking_delta events (the iOS UI then
    /// renders summary-only thinking rows from the block boundaries alone).
    /// The DESKTOP owns the projection — it adds `streamThinkingToRemote` to
    /// `PROJECTABLE_SETTINGS_DATA` with a group id (Phase 3, in parallel).
    /// iOS does NOT hand-render this toggle: `DesktopSettingsView` is fully
    /// data-driven and auto-renders any boolean schema entry as a
    /// `booleanRow`. The only iOS obligation is that the snapshot decode +
    /// state-lookup path surfaces the entry into a known group so it renders.
    ///
    /// This test pins exactly that: a boolean `streamThinkingToRemote` entry
    /// in the snapshot decodes, its value is read back through
    /// `currentValue(for:)`, and it lands in its declared group (not in the
    /// forward-compat "Other" orphan section). When the desktop ships its
    /// projection with a matching group id, the iOS toggle renders with no
    /// further iOS code change. If the desktop instead projects it into a
    /// group iOS doesn't list in `groups`, `orphanedEntries()` would surface
    /// it — this test guards the in-group (auto-render) path.
    func testStreamThinkingToRemoteAutoRenders() throws {
        // The group id must match whatever the desktop's CATEGORIES array
        // uses for the remote section. The desktop projects remote-pairing
        // settings under the "remote" group; this snapshot mirrors that so
        // the entry lands in-group rather than orphaned.
        let json = """
        {
            "type": "desktop_settings_snapshot",
            "settings": {
                "streamThinkingToRemote": false
            },
            "schema": [
                {
                    "key": "streamThinkingToRemote",
                    "type": "boolean",
                    "group": "remote",
                    "label": "Stream thinking to phone",
                    "description": "Send the model's reasoning deltas to paired devices. Turn off on slow links — devices still show a thinking summary.",
                    "defaultValue": true
                }
            ],
            "groups": [
                { "id": "remote", "label": "Remote" }
            ]
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .desktopSettingsSnapshot(let settings, let schema, let groups) = event else {
            XCTFail("expected desktopSettingsSnapshot, got \(event)")
            return
        }

        // The entry decodes as a boolean schema entry → DesktopSettingsView
        // routes booleans to `booleanRow`, the auto-rendered Toggle.
        let entry = schema.first { $0.key == "streamThinkingToRemote" }
        XCTAssertNotNil(entry, "streamThinkingToRemote must decode from the schema")
        XCTAssertEqual(entry?.type, .boolean, "boolean type drives the auto-rendered Toggle row")
        XCTAssertEqual(entry?.group, "remote")

        // Build the state model the view binds to and confirm the value and
        // grouping surface for auto-render (not orphaned).
        let state = DesktopSettingsState(settings: settings, schema: schema, groups: groups)
        XCTAssertEqual(
            state.currentValue(for: "streamThinkingToRemote")?.value as? Bool, false,
            "the persisted toggle value must read back through currentValue"
        )
        XCTAssertEqual(
            state.entries(in: "remote").map(\.key), ["streamThinkingToRemote"],
            "the toggle must land in its declared group so DesktopSettingsView renders it"
        )
        XCTAssertTrue(
            state.orphanedEntries().isEmpty,
            "an in-group entry must NOT fall into the forward-compat Other section"
        )
    }
}
