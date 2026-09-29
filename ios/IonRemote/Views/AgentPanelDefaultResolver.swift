import Foundation

/// Shared resolver for the `agentPanelDefaultOpen` desktop setting.
///
/// Three call sites read this setting:
///   - `ConversationView.isAgentsPanelExpanded` (main conversation)
///   - `AgentDetailFullScreenView.isAgentsPanelExpanded` (dispatch popup root)
///   - `BreadcrumbDestinationView.isAgentsPanelExpanded` (dispatch popup breadcrumb)
///
/// All three delegate the settings-fallback half here so the resolution
/// logic is in one place and cannot drift between sites.
///
/// Resolution order (the explicit-override check lives at each call site):
///   agentPanelDefaultOpen setting → true (when setting is absent).
enum AgentPanelDefaultResolver {
    /// Returns the value of `agentPanelDefaultOpen` from `settings`, or
    /// `true` when the setting is absent or `settings` is nil.
    static func resolveAgentPanelDefault(_ settings: ServerSettingsState?) -> Bool {
        guard let settings,
              let val = settings.currentValue(for: "agentPanelDefaultOpen"),
              let flag = val.value as? Bool else {
            return true
        }
        return flag
    }
}
