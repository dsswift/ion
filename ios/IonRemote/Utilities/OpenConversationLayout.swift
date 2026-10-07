import SwiftUI

/// The rules that keep one open conversation across the two inbox layouts.
///
/// The inbox renders a NavigationStack at compact width and a
/// NavigationSplitView at regular width. A large iPhone crosses that line on
/// every rotation, so both layouts read and write the same navigation stack:
/// the split view's selection is the top of the stack, never a second value.
/// Rotating changes the layout and nothing else.
enum OpenConversationLayout {

    /// The conversation the split view shows: the top of the shared stack.
    static func selection(in stack: [String]) -> String? {
        stack.last
    }

    /// The stack after the split view selects `tabId`.
    ///
    /// Re-selecting the open conversation keeps the stack as it is, so a
    /// conversation pushed on top of another survives a round trip through the
    /// split view. Any other selection replaces the stack, the same as tapping
    /// a row from the list at compact width.
    static func stack(selecting tabId: String?, from stack: [String]) -> [String] {
        guard let tabId else { return [] }
        if stack.last == tabId { return stack }
        return [tabId]
    }

    /// The sidebar to show when the split view takes over.
    ///
    /// With nothing open the sidebar is the whole point, so it shows. With a
    /// conversation open the conversation gets the screen, unless the sidebar
    /// was showing the last time this split view was on screen.
    static func sidebarVisibility(
        openTabId: String?,
        lastSplitVisibility: NavigationSplitViewVisibility?
    ) -> NavigationSplitViewVisibility {
        guard openTabId != nil else { return .all }
        return lastSplitVisibility ?? .detailOnly
    }
}
