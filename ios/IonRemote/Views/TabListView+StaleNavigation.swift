import SwiftUI

// Stale-navigation-destination handling for TabListView.
//
// A conversation closed on the desktop is removed from `viewModel.tabs`, but
// nothing used to touch the navigation state that still pointed at it. On the
// iPhone the pushed tab id stayed on the stack and `destinationView` rendered
// `ConversationView` for an id that no longer resolved — every derived value
// degraded through optional chaining, producing an untitled conversation with
// no messages and no instances. It looked like a real, broken conversation, and
// the only way out was to back out to the list and find the tab again.
//
// The split view's selection is the top of the same stack, so this one rule
// covers both layouts.
extension TabListView {

    /// Remove any open conversation whose tab no longer exists, returning the
    /// user to the tab list.
    ///
    /// No-ops while no snapshot has been applied: absence is not authoritative
    /// until the desktop has sent a full tab list at least once, and the
    /// navigation stack can restore before that happens.
    func pruneStaleNavigationDestinations(reason: String) {
        guard !navigationPath.isEmpty else { return }

        let result = NavigationDestinationValidator.prune(
            stack: navigationPath,
            knownTabIds: viewModel.tabIds,
            hasAppliedTabSnapshot: viewModel.hasAppliedTabSnapshot
        )
        guard !result.dropped.isEmpty else { return }

        // Logged at warn: this is a real navigation interruption for the user,
        // and the absence of any such log line is why an earlier occurrence of
        // this bug left no trace in ios-diagnostic-logs.jsonl at all.
        DiagnosticLog.log(
            "nav popped stale destination to tab list",
            tag: "view.nav",
            level: .warn,
            fields: [
                "tab_id": String((result.dropped.first ?? "").prefix(8)),
                "count": String(result.dropped.count),
                "reason": reason,
                "status": String(viewModel.tabIds.count)
            ]
        )

        navigationPath = result.stack
        // The conversation the desktop was routing intercepts to is gone, so
        // withdraw focus. Without this the desktop keeps targeting a tab this
        // device is no longer displaying.
        if navigationPath.isEmpty {
            viewModel.sendReportFocus(tabId: nil)
        }
    }
}
