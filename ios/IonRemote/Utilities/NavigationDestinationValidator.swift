import Foundation

/// Decides whether a pushed conversation destination is still valid, and what
/// the navigation stack should become when it is not.
///
/// Extracted as a pure, view-independent seam for two reasons: the rule is
/// shared by the iPhone stack and the iPad detail pane (they previously
/// disagreed — the iPad guarded its destination, the iPhone did not), and the
/// decision is the part worth unit-testing without standing up SwiftUI.
///
/// The defect this exists for: `navigationPath` holds tab ids, and closing a
/// conversation on the desktop removes the tab from `tabs` without touching the
/// navigation stack. `destinationView` then rendered `ConversationView` for an
/// id that no longer resolves, producing a titleless, stateless shell that
/// looks like a real-but-broken conversation. The user had to back out to the
/// list manually.
enum NavigationDestinationValidator {

    /// Why a destination was kept or dropped. Carried into the log so a pop is
    /// observable after the fact — the previous code logged pushes but had no
    /// branch for a failed resolution at all, which is why this failure left no
    /// trace beyond a screenshot.
    enum Outcome: Equatable {
        /// The tab is present; stay where we are.
        case valid
        /// No tab snapshot has been applied yet, so absence proves nothing.
        /// Hold the destination and re-evaluate when the snapshot lands.
        case unresolvedAwaitingSnapshot
        /// A snapshot has been applied and the tab is genuinely gone.
        case stale

        /// Stable string for the `reason` log field.
        var logValue: String {
            switch self {
            case .valid: return "valid"
            case .unresolvedAwaitingSnapshot: return "awaiting_snapshot"
            case .stale: return "stale"
            }
        }
    }

    /// Classify a single destination.
    ///
    /// - Parameters:
    ///   - tabId: the pushed destination.
    ///   - knownTabIds: ids the client currently believes exist.
    ///   - hasAppliedTabSnapshot: whether a desktop tab snapshot has ever been
    ///     applied in this app run. This gate is the whole reason the check is
    ///     safe: on a cold launch the navigation stack can restore *before* the
    ///     first snapshot arrives, so `knownTabIds` is legitimately empty for a
    ///     moment. Popping then would eject the user from a perfectly live
    ///     conversation — a worse bug than the one being fixed, and visually
    ///     identical to it.
    static func classify(
        tabId: String,
        knownTabIds: Set<String>,
        hasAppliedTabSnapshot: Bool
    ) -> Outcome {
        if knownTabIds.contains(tabId) { return .valid }
        return hasAppliedTabSnapshot ? .stale : .unresolvedAwaitingSnapshot
    }

    /// Prune every stale destination from a navigation stack.
    ///
    /// Returns the stack the caller should adopt and the ids that were dropped.
    /// Truncates at the FIRST stale entry rather than filtering in place: the
    /// entries above a dropped conversation were reached *through* it, so
    /// keeping them would leave the user somewhere they could not have
    /// navigated to. In practice the conversation stack is one deep, but the
    /// truncating rule is the correct one regardless of depth.
    static func prune(
        stack: [String],
        knownTabIds: Set<String>,
        hasAppliedTabSnapshot: Bool
    ) -> (stack: [String], dropped: [String]) {
        guard let firstStaleIndex = stack.firstIndex(where: { tabId in
            classify(
                tabId: tabId,
                knownTabIds: knownTabIds,
                hasAppliedTabSnapshot: hasAppliedTabSnapshot
            ) == .stale
        }) else {
            return (stack, [])
        }
        return (Array(stack[..<firstStaleIndex]), Array(stack[firstStaleIndex...]))
    }
}
