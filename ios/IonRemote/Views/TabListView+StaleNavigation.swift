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
// The iPad detail pane already guarded its destination (falling back to "Select
// a tab"), so the two size classes disagreed. Both now route through the same
// validator and both log the outcome.
extension TabListView {

    /// Remove any pushed conversation whose tab no longer exists, returning the
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
            "nav iphone popped stale destination to tab list",
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

    /// iPad equivalent: clear a detail selection whose tab has been closed.
    ///
    /// The detail pane already renders its "Select a tab" empty state for an
    /// unresolvable selection, so the visible outcome was acceptable — but the
    /// stale id was retained silently and never logged. Clearing it keeps
    /// `selectedTabId` honest (so list selection highlighting and focus
    /// reporting agree with what is shown) and makes the event observable.
    func clearStaleDetailSelection(reason: String) {
        guard let tabId = selectedTabId else { return }
        let outcome = NavigationDestinationValidator.classify(
            tabId: tabId,
            knownTabIds: viewModel.tabIds,
            hasAppliedTabSnapshot: viewModel.hasAppliedTabSnapshot
        )
        guard outcome == .stale else { return }

        DiagnosticLog.log(
            "nav ipad cleared stale detail selection",
            tag: "view.nav",
            level: .warn,
            fields: [
                "tab_id": String(tabId.prefix(8)),
                "reason": reason,
                "status": String(viewModel.tabIds.count)
            ]
        )

        selectedTabId = nil
        viewModel.sendReportFocus(tabId: nil)
    }
}
