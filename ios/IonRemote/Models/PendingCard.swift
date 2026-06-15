import Foundation

/// PendingCard — the single, testable rule for deciding whether a restored
/// AskUserQuestion / ExitPlanMode card should appear when a conversation is
/// reopened on iOS. Mirrors the desktop `pendingCardOutcome` in
/// `desktop/src/shared/pending-card.ts` so both clients agree exactly: a
/// pending card is restored only when the last AskUserQuestion / ExitPlanMode
/// tool is genuinely still outstanding — no trailing `/clear` divider and no
/// trailing user message dismissed it.
///
/// The `/clear` divider arrives as a `system` message whose content starts
/// with the clear sentinel ("── Cleared", produced by desktop's
/// `formatClearDivider`). Keeping this as a pure function over `[Message]`
/// makes the parity rule unit-testable without standing up a SwiftUI view.
enum PendingCard {
    /// The two intercepted tools that produce a restorable pending card.
    static let cardTools: Set<String> = ["AskUserQuestion", "ExitPlanMode"]

    /// Sentinel prefix for the `/clear` checkpoint divider. Mirrors
    /// `isClearDivider` in desktop's clear-divider.ts.
    static let clearDividerPrefix = "── Cleared"

    enum Outcome: Equatable {
        case found(Message)
        case none
        case suppressedByClear
        case suppressedByUser

        // Hand-written Equatable: Message is not Equatable (and does not need
        // to be), so compare by case and — for `.found` — by the message id,
        // which is the stable identity the card is keyed on.
        static func == (lhs: Outcome, rhs: Outcome) -> Bool {
            switch (lhs, rhs) {
            case (.none, .none),
                 (.suppressedByClear, .suppressedByClear),
                 (.suppressedByUser, .suppressedByUser):
                return true
            case (.found(let a), .found(let b)):
                return a.id == b.id
            default:
                return false
            }
        }
    }

    /// Decide whether `messages` should restore a pending card. Walks from the
    /// end: a `/clear` divider or a user message after the last pending tool
    /// dismisses it; otherwise the last AskUserQuestion / ExitPlanMode tool is
    /// the card to restore.
    static func outcome(for messages: [Message]) -> Outcome {
        guard let lastTool = messages.last(where: { $0.isTool }),
              let name = lastTool.toolName,
              cardTools.contains(name)
        else {
            return .none
        }
        // Walk backwards from the end until we reach the tool; if a user
        // message or a clear divider appears first, the card is dismissed.
        for message in messages.reversed() {
            if message.id == lastTool.id { break }
            if message.role == .user { return .suppressedByUser }
            if message.role == .system && message.content.hasPrefix(clearDividerPrefix) {
                return .suppressedByClear
            }
        }
        return .found(lastTool)
    }
}
