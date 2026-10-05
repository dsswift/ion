import Foundation

/// One Fleet Hub a server is set to report to, as `fleet.hubs.list` returns
/// it. Mirrors `FleetHubStatus` in `packages/shared/src/fleet-hub.ts`.
struct FleetHubStatus: Decodable, Equatable, Identifiable, Sendable {
    let url: String
    /// The hub's own name once it has answered; the address's host until then.
    let label: String
    /// `policy`: the organization set it and it cannot be removed. `added`: an admin of the server did.
    let source: String
    /// Whether the hub may run its actions on the server.
    let manage: Bool
    /// `connecting`, `connected`, `refused`, `blocked`, or `unreachable`.
    let state: String
    /// Why, for a hub that is refused, not allowed, or unreachable.
    let detail: String?

    var id: String { url }
    var removable: Bool { source == "added" }

    /// The state in a word a person reads.
    var stateWord: String { Self.word(for: state) }

    static func word(for state: String) -> String {
        switch state {
        case "connected": return "Reporting"
        case "connecting": return "Connecting"
        case "refused": return "Refused"
        case "blocked": return "Not allowed"
        case "unreachable": return "Unreachable"
        default: return state
        }
    }
}

/// `fleet.hubs.list`, and what adding or removing a hub answers with.
struct FleetHubsList: Decodable, Equatable, Sendable {
    let hubs: [FleetHubStatus]
    /// The organization limits which hubs the server may join.
    let restricted: Bool
}
