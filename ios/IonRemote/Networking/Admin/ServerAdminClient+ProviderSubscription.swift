import Foundation

/// The provider subscription calls: the key the server's engine looked up
/// with its signed-in identity, choosing one of several, and looking up again.
extension ServerAdminClient {

    /// Select and refresh may wait on the lookup endpoint, which the engine
    /// bounds on its own; this leaves room for that bound.
    private static let lookupTimeoutSeconds: Double = 45

    func providerSubscription() async throws -> ProviderSubscriptionResult {
        try await call(.providerSubscription)
    }

    /// Applies the offered subscription `id` and has the engine remember it.
    func selectProviderSubscription(id: String) async throws -> ProviderSubscriptionResult {
        try await call(.providerSelectSubscription, fields: ["id": .string(id)], timeoutSeconds: Self.lookupTimeoutSeconds)
    }

    func refreshProviderSubscription() async throws -> ProviderSubscriptionResult {
        try await call(.providerRefreshSubscription, timeoutSeconds: Self.lookupTimeoutSeconds)
    }
}
