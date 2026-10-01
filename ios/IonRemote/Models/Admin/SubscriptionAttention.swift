import Foundation

/// One server's Provider Subscription Prompt: the snapshot that needs a
/// person, and whether they dismissed the prompt for it.
struct SubscriptionAttention: Equatable, Sendable {
    /// `selection_required` or `none`.
    let state: String
    let status: ProviderSubscriptionStatus
    var dismissed: Bool

    /// The state that needs a person, or nil when the snapshot needs nobody:
    /// several subscriptions with none chosen, or none at all.
    static func state(of status: ProviderSubscriptionStatus?) -> String? {
        guard let state = status?.state else { return nil }
        let needsPerson = state == ProviderSubscriptionStatus.State.selectionRequired || state == ProviderSubscriptionStatus.State.none
        return needsPerson ? state : nil
    }

    /// Folds one snapshot into the prompt state. A dismissal lasts while the
    /// snapshot stays in the same state, so the prompt shows once per
    /// transition into a state and not again on each later snapshot of it.
    static func next(previous: SubscriptionAttention?, status: ProviderSubscriptionStatus?) -> SubscriptionAttention? {
        guard let status, let state = state(of: status) else { return nil }
        return SubscriptionAttention(state: state, status: status, dismissed: previous?.state == state ? previous?.dismissed ?? false : false)
    }
}
