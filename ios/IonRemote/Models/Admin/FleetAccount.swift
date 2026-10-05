import Foundation

/// One provider CLI account a server has seen signed in during the last 30
/// days. Mirrors `FleetAccount` in `packages/shared/src/types-fleet.ts`.
struct FleetAccount: Decodable, Equatable, Sendable {

    /// A usage limit as the server's ledger holds it. Mirrors `FleetAccountLimit`.
    struct Limit: Decodable, Equatable, Sendable {
        /// "session", "weekly", "weekly_model", or "spend".
        let kind: String
        /// What the limit covers when the kind alone does not say (a model's name).
        let label: String?
        /// How much of the limit is used, 0...100 (above 100 once exceeded).
        let percent: Double
        /// RFC3339 time the limit resets.
        let resetsAt: String?
        /// Unix ms this limit was last read.
        let fetchedAt: Double
    }

    let provider: String
    let backend: String
    /// Empty for a login with no email (an API key).
    let email: String
    let orgId: String?
    let orgName: String?
    let planType: String?
    let authMethod: String?
    let label: String?
    /// Unix ms the account was last seen signed in.
    let lastSeen: Double
    let signedIn: Bool
    let limits: [Limit]
    let limitsError: String?

    /// The identity of a ledger row: one account of one provider.
    var key: String {
        [provider, email.lowercased(), orgId ?? "", email.isEmpty ? (authMethod ?? "") : ""].joined(separator: "|")
    }
}
