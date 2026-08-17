import SwiftUI

/// Shown in place of a conversation whose tab is not in the current tab list.
///
/// Reached only in the narrow pre-snapshot window: once a tab snapshot has been
/// applied, a missing tab is authoritative and the destination is popped back to
/// the tab list instead (see TabListView+StaleNavigation). Until then, absence
/// may just mean "not synced yet", and popping would eject the user from a live
/// conversation.
///
/// Exists because the alternative was rendering `ConversationView` for an
/// unresolvable tab id: every derived value degraded silently through optional
/// chaining, producing an untitled conversation with no messages, no instances,
/// and no indication that anything was wrong.
struct StaleConversationPlaceholderView: View {
    @Environment(\.appTheme) var theme

    /// When false, the tab list has not arrived yet and this is a transient
    /// syncing state. When true, the conversation is genuinely gone and a pop to
    /// the tab list is already in flight — the copy stays neutral because the
    /// view is on screen for at most a frame or two.
    let hasAppliedTabSnapshot: Bool

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: hasAppliedTabSnapshot ? "questionmark.folder" : "arrow.trianglehead.2.clockwise")
                // design-type: SF Symbol empty-state glyph sized as icon
                // geometry, not text.
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text(hasAppliedTabSnapshot ? "Conversation unavailable" : "Syncing conversation…")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(hasAppliedTabSnapshot
                 ? "This conversation is no longer open on the desktop."
                 : "Waiting for the desktop to send its tab list.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background.ignoresSafeArea())
    }
}
