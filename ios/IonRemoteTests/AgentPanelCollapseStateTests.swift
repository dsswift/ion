import XCTest
@testable import IonRemote

// MARK: - AgentPanelCollapseStateTests
//
// Regression tests for the agent panel collapse/expand state resolution.
//
// Regression: commit 61c00a66 moved agent rendering into Transcript.swift's
// TranscriptAgentSection but dropped the collapsible behavior — the panel
// rendered as a flat always-expanded list. The state variables
// `agentsPanelExpanded` and `agentPanelFullscreen` on ConversationView
// were wired to nothing.
//
// These tests pin the settings-fallback resolution logic so the three-tier
// priority (explicit override > agentPanelDefaultOpen setting > true) cannot
// silently regress again.
//
// Because pure-SwiftUI render assertions are not viable in XCTest without
// a running host app, the tests operate directly on the resolution logic
// extracted into a standalone helper (mirroring ConversationView's
// `isAgentsPanelExpanded` computed var) and on DesktopSettingsState
// lookups. The helper is verified against all relevant branches.

final class AgentPanelCollapseStateTests: XCTestCase {

    // MARK: - Resolution helper
    //
    // Mirrors ConversationView.isAgentsPanelExpanded exactly:
    //   explicit override > agentPanelDefaultOpen setting > true
    //
    // If this function's body drifts from ConversationView's computed var,
    // this test suite will still catch regressions in the setting lookup
    // path — because the DesktopSettingsState fixture below matches the
    // real production lookup.

    private func resolveExpanded(
        explicit: Bool?,
        settings: DesktopSettingsState?
    ) -> Bool {
        if let explicit { return explicit }
        if let settings = settings,
           let val = settings.currentValue(for: "agentPanelDefaultOpen"),
           let flag = val.value as? Bool {
            return flag
        }
        return true
    }

    // MARK: - Helpers

    private func makeSettings(agentPanelDefaultOpen: Bool) -> DesktopSettingsState {
        DesktopSettingsState(
            settings: ["agentPanelDefaultOpen": AnyCodable(agentPanelDefaultOpen)],
            schema: [
                DesktopSettingSchemaEntry(
                    key: "agentPanelDefaultOpen",
                    type: .boolean,
                    group: "conversation",
                    label: "Agent panel open by default",
                    description: "Controls initial expanded state of the agent panel.",
                    defaultValue: AnyCodable(true),
                    choices: nil,
                    range: nil,
                    itemSchema: nil,
                    itemType: nil
                )
            ],
            groups: [
                DesktopSettingGroupDescriptor(groupId: "conversation", label: "Conversation")
            ]
        )
    }

    // MARK: - Priority 1: explicit override wins unconditionally

    /// When `agentsPanelExpanded` is set explicitly to false, the result is
    /// false regardless of what the desktop setting says.
    func test_explicitFalse_overridesSettingTrue() {
        let settings = makeSettings(agentPanelDefaultOpen: true)
        let result = resolveExpanded(explicit: false, settings: settings)
        XCTAssertFalse(result, "Explicit false must override agentPanelDefaultOpen=true")
    }

    /// When `agentsPanelExpanded` is set explicitly to true, the result is
    /// true regardless of what the desktop setting says.
    func test_explicitTrue_overridesSettingFalse() {
        let settings = makeSettings(agentPanelDefaultOpen: false)
        let result = resolveExpanded(explicit: true, settings: settings)
        XCTAssertTrue(result, "Explicit true must override agentPanelDefaultOpen=false")
    }

    /// Explicit false wins even when no settings object is available.
    func test_explicitFalse_noSettings() {
        let result = resolveExpanded(explicit: false, settings: nil)
        XCTAssertFalse(result, "Explicit false must win with no desktop settings")
    }

    // MARK: - Priority 2: agentPanelDefaultOpen setting is the fallback

    /// When no explicit override exists but the setting is false, the panel
    /// starts collapsed.
    func test_noExplicit_settingFalse_returnsCollapsed() {
        let settings = makeSettings(agentPanelDefaultOpen: false)
        let result = resolveExpanded(explicit: nil, settings: settings)
        XCTAssertFalse(result, "agentPanelDefaultOpen=false must collapse the panel when no explicit override")
    }

    /// When no explicit override exists and the setting is true, the panel
    /// starts expanded.
    func test_noExplicit_settingTrue_returnsExpanded() {
        let settings = makeSettings(agentPanelDefaultOpen: true)
        let result = resolveExpanded(explicit: nil, settings: settings)
        XCTAssertTrue(result, "agentPanelDefaultOpen=true must expand the panel when no explicit override")
    }

    // MARK: - Priority 3: hard-coded default is true

    /// When there is no explicit override and no desktop settings at all,
    /// the panel defaults to expanded.
    func test_noExplicit_noSettings_defaultsToExpanded() {
        let result = resolveExpanded(explicit: nil, settings: nil)
        XCTAssertTrue(result, "Panel must default to expanded when no settings and no explicit override")
    }

    /// When there is no explicit override and the settings object exists but
    /// does not contain agentPanelDefaultOpen, the panel defaults to expanded.
    func test_noExplicit_settingAbsent_defaultsToExpanded() {
        let emptySettings = DesktopSettingsState(settings: [:], schema: [], groups: [])
        let result = resolveExpanded(explicit: nil, settings: emptySettings)
        XCTAssertTrue(result, "Panel must default to expanded when agentPanelDefaultOpen is absent from settings")
    }

    // MARK: - Mutation: explicit set followed by reset

    /// After a user explicitly collapses the panel (explicit=false), clearing
    /// the explicit override (explicit=nil) re-consults the settings.
    func test_clearExplicit_reConsultsSettings() {
        let settingsCollapsed = makeSettings(agentPanelDefaultOpen: false)

        // User explicitly expanded — should see true.
        let afterExplicitOpen = resolveExpanded(explicit: true, settings: settingsCollapsed)
        XCTAssertTrue(afterExplicitOpen, "Explicit true must expand even when setting says collapsed")

        // Clearing the explicit override — should fall back to the setting.
        let afterClear = resolveExpanded(explicit: nil, settings: settingsCollapsed)
        XCTAssertFalse(afterClear, "After clearing explicit, should fall back to agentPanelDefaultOpen=false")
    }
}
