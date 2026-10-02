import Foundation

/// One subscription a lookup offered, without its key.
struct SubscriptionOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
}

/// The provider key the server's engine looked up for its signed-in
/// identity, as `provider.subscription` and the
/// `ion:provider-subscription-changed` snapshot report it. The key itself
/// never leaves the engine.
struct ProviderSubscriptionStatus: Codable, Equatable, Sendable {
    /// One of the `State` values; kept as a string so a state a newer server
    /// adds still decodes.
    let state: String
    let provider: String?
    /// The provider's configured display name; absent when none is set.
    let providerDisplayName: String?
    /// The subscription whose key is applied; present only when applied.
    let selected: SubscriptionOption?
    /// The subscriptions the last lookup returned, in response order.
    let options: [SubscriptionOption]?
    /// `lookup` or `cache`: where the applied key came from.
    let source: String?
    /// When the lookup behind the key or options ran, Unix milliseconds.
    let resolvedAt: Int64?
    /// The most recent lookup failure.
    let error: String?
    /// The Policy Failure identifier of the state; present when it is `none`
    /// or `failed`.
    var policyFailure: String? = nil
    /// The enterprise policy's text for `policyFailure`; absent when none is
    /// configured.
    var message: String? = nil

    /// What a failure state says: the enterprise policy's text for it when
    /// one is configured, `fallback` otherwise.
    func failureText(_ fallback: String) -> String {
        guard let message, !message.isEmpty else { return fallback }
        return message
    }

    enum State {
        static let disabled = "disabled"
        static let awaitingIdentity = "awaiting_identity"
        static let resolving = "resolving"
        static let applied = "applied"
        static let selectionRequired = "selection_required"
        static let none = "none"
        static let failed = "failed"
    }
}

/// The answer to every `provider.*Subscription` action: the snapshot the
/// action left, even when it failed.
struct ProviderSubscriptionResult: Codable, Equatable, Sendable {
    let ok: Bool
    let error: String?
    let subscription: ProviderSubscriptionStatus
}
