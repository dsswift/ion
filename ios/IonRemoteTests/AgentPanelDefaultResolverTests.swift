import XCTest
@testable import IonRemote

// MARK: - AgentPanelDefaultResolverTests
//
// Pins the shared AgentPanelDefaultResolver.resolveAgentPanelDefault helper.
//
// The resolver is the settings-fallback half of the three-tier resolution
// used by ConversationView, AgentDetailFullScreenView, and
// BreadcrumbDestinationView:
//
//   explicit override > agentPanelDefaultOpen setting > true (default)
//
// The explicit-override check lives at each call site (it uses @State,
// which cannot be tested here). The tests here exercise the settings +
// absence branches and confirm that the old hardcoded-true behavior
// (before the resolver existed) is now governed by the setting.

final class AgentPanelDefaultResolverTests: XCTestCase {

    // MARK: - Helpers

    private func makeSettings(agentPanelDefaultOpen value: Bool) -> ServerSettingsState {
        ServerSettingsState(
            settings: ["agentPanelDefaultOpen": AnyCodable(value)],
            schema: [
                ServerSettingSchemaEntry(
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
                ServerSettingGroupDescriptor(groupId: "conversation", label: "Conversation")
            ]
        )
    }

    // MARK: - Setting present and false → resolver returns false

    /// When agentPanelDefaultOpen is explicitly false in the desktop settings,
    /// the resolver must return false. This is the key regression guard: the
    /// old hardcoded-true path would have returned true here.
    func test_settingFalse_returnsFalse() {
        let settings = makeSettings(agentPanelDefaultOpen: false)
        let result = AgentPanelDefaultResolver.resolveAgentPanelDefault(settings)
        XCTAssertFalse(
            result,
            "resolveAgentPanelDefault must return false when agentPanelDefaultOpen=false"
        )
    }

    // MARK: - Setting present and true → resolver returns true

    /// When agentPanelDefaultOpen is true in the desktop settings,
    /// the resolver must return true.
    func test_settingTrue_returnsTrue() {
        let settings = makeSettings(agentPanelDefaultOpen: true)
        let result = AgentPanelDefaultResolver.resolveAgentPanelDefault(settings)
        XCTAssertTrue(
            result,
            "resolveAgentPanelDefault must return true when agentPanelDefaultOpen=true"
        )
    }

    // MARK: - Setting absent → resolver returns true (hard-coded default)

    /// When the settings object has no agentPanelDefaultOpen key at all,
    /// the resolver falls back to true (expanded by default).
    func test_settingAbsent_returnsTrue() {
        let emptySettings = ServerSettingsState(settings: [:], schema: [], groups: [])
        let result = AgentPanelDefaultResolver.resolveAgentPanelDefault(emptySettings)
        XCTAssertTrue(
            result,
            "resolveAgentPanelDefault must return true (default) when the key is absent"
        )
    }

    // MARK: - Settings object nil → resolver returns true

    /// When no desktop settings object is available yet (e.g. just connected,
    /// snapshot not yet received), the resolver defaults to true.
    func test_nilSettings_returnsTrue() {
        let result = AgentPanelDefaultResolver.resolveAgentPanelDefault(nil)
        XCTAssertTrue(
            result,
            "resolveAgentPanelDefault must return true when settings is nil"
        )
    }
}
