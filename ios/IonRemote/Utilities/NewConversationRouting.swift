import Foundation

// MARK: - New Conversation Routing
//
// Pure routing logic for the single "New Conversation" entry point
// (conversation unification #256).
//
// Mirrors `resolveNewConversationAction` in
// desktop/src/renderer/components/new-conversation-routing.ts.
// Extracted into its own module so it can be unit-tested without any
// SwiftUI, view-model, or network dependencies.
//
// State machine (highest to lowest precedence, matching desktop):
//   0. Enterprise-locked: policy present and locked=true -> use mandated
//      baseDirectory + profileId. Empty profileId means plain.
//      The enterprise policy reaches iOS over the wire via the
//      desktop_settings_snapshot event (newConversationPolicy field), is stored on
//      SessionViewModel, and is passed in here as `enterprisePolicy`. This
//      branch is gated on policy presence — when `enterprisePolicy` is nil
//      (no policy projected) the branch is skipped.
//   1. Zero engine profiles -> plain conversation, no picker.
//   2. defaultEngineProfileId is non-empty AND the profile exists
//      -> use that profile directly, no picker.
//      (Empty defaultEngineProfileId = "use plain conversation as default"
//       on desktop; falls through to picker here to match intent.)
//   3. Otherwise -> show the extended picker (plain option + profiles).

/// The resolved action the UI should take when the user taps "New Conversation".
enum NewConversationAction: Equatable {
    /// Open a plain (no-extension) conversation tab directly.
    case plain
    /// Open a conversation tab with the given engine profile id directly.
    case profile(profileId: String)
    /// Show the conversation picker (plain + all profiles).
    case showPicker
    /// Enterprise-locked: use the mandated directory and profile id.
    /// profileId="" means plain conversation.
    case locked(baseDirectory: String, profileId: String)
}

/// Enterprise new-conversation policy. Mirrors `NewConversationDefaultsPolicy` in
/// `desktop/src/shared/types-session.ts`. Projected by the desktop as
/// `newConversationPolicy` in the `desktop_settings_snapshot` event, decoded in
/// `NormalizedEvent+EngineDecoder.swift`, stored on
/// `SessionViewModel.enterpriseNewConversationPolicy`, and consumed in `TabListView`.
struct NewConversationDefaultsPolicy: Equatable {
    var locked: Bool
    var baseDirectory: String
    var profileId: String
}

/// Resolve the next action for "New Conversation" given the current
/// preference state. Pure and side-effect-free.
///
/// - Parameters:
///   - profiles:          The current engine profiles list.
///   - defaultId:         The current `defaultEngineProfileId` (empty = unset).
///   - enterprisePolicy:  The enterprise NewConversationDefaults policy, or nil if none.
func resolveNewConversationAction(
    profiles: [EngineProfile],
    defaultId: String,
    enterprisePolicy: NewConversationDefaultsPolicy? = nil
) -> NewConversationAction {
    // State 0 (highest precedence): enterprise-locked.
    if let policy = enterprisePolicy, policy.locked {
        return .locked(baseDirectory: policy.baseDirectory, profileId: policy.profileId)
    }

    // State 1: no profiles at all -> plain conversation, no picker.
    if profiles.isEmpty { return .plain }

    // State 2: a default is set and the profile still exists -> use it.
    if !defaultId.isEmpty {
        let exists = profiles.contains(where: { $0.id == defaultId })
        if exists { return .profile(profileId: defaultId) }
        // Default was deleted: fall through to picker.
    }

    // State 3: show the extended picker (plain + profiles).
    return .showPicker
}

/// Resolve the profile choice for a desktop-owned project.
///
/// `profileAction` comes from the desktop snapshot. Unknown values use the
/// picker, so a newer desktop never causes iOS to create the wrong kind of
/// conversation.
func resolveNewConversationAction(for project: RemoteProject) -> NewConversationAction {
    switch project.profileAction {
    case "plain":
        return .plain
    case "profile":
        guard let profileId = project.profileId, !profileId.isEmpty else {
            return .showPicker
        }
        return .profile(profileId: profileId)
    case "ask":
        return .showPicker
    default:
        return .showPicker
    }
}
