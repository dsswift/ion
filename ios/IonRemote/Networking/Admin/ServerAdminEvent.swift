import Foundation

/// One event on a channel an admin screen reads, from one paired server.
///
/// The payload stays uninterpreted here: each settings area decodes the
/// channels it reads into its own types.
struct ServerAdminEvent: Equatable, Sendable {
    /// The `clientId` of the paired server that sent it.
    let serverId: String
    let channel: String
    let payload: JSONValue

    /// The server's MCP server list, republished on every change.
    static let mcpServersChanged = "ion:mcp-servers-changed"
    /// The server's provider subscription state, republished on every change.
    static let providerSubscriptionChanged = "ion:provider-subscription-changed"
    /// The paired clients changed.
    static let clientsChanged = "ion:clients-changed"
    /// Discovery status: `{mode, advertising, until}`.
    static let discovery = "ion:discovery"
    /// Progress of a provider sign-in.
    static let providerLoginEvent = "ion:provider-login-event"
    /// The project registry changed.
    static let projectsChanged = "ion:projects-changed"
    /// A clone, setup, or purge job's progress.
    static let projectJob = "ion:project-job"
    /// The relays the server is reachable through changed.
    static let remoteRelaysChanged = "ion:remote-relays-changed"
    /// The engine's model tiers changed; re-read them with `model.listTiers`.
    static let modelTiersUpdated = "ion:model-tiers-updated"
    /// The engine's default provider changed; re-read it with `provider.getDefault`.
    static let defaultProviderUpdated = "ion:default-provider-updated"

    /// Every channel routed to admin screens rather than to the thin event path.
    static let channels: Set<String> = [
        mcpServersChanged, providerSubscriptionChanged, clientsChanged, discovery, providerLoginEvent,
        projectsChanged, projectJob, remoteRelaysChanged,
        modelTiersUpdated, defaultProviderUpdated,
    ]
}
