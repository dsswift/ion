import Foundation

/// `fleet.report`: what one server says about itself. Mirrors `FleetReport`
/// in `packages/shared/src/types-fleet.ts`; only what the Fleet screen shows
/// is decoded.
struct FleetReport: Decodable, Equatable, Sendable {

    /// The caller's own paired devices on the server, the calling one left out.
    struct Devices: Decodable, Equatable, Sendable {
        let paired: Int
        let connected: Int
    }

    /// A provider as a Fleet row shows it.
    struct Provider: Decodable, Equatable, Sendable {
        let id: String
        let displayName: String?
        let hasAuth: Bool
        let backend: String?
        let modelCount: Int
    }

    /// One Fleet Hub the server reports to.
    struct Hub: Decodable, Equatable, Sendable {
        let url: String
        let label: String
        /// `connecting`, `connected`, `refused`, `blocked`, or `unreachable`.
        let state: String
        let manage: Bool
    }

    /// Unix ms the report was built.
    let generatedAt: Double
    let server: EnvironmentServerInfo
    let devices: Devices
    let providers: [Provider]
    /// Empty when no default provider is set.
    let defaultProvider: String
    let accounts: [FleetAccount]
    /// The Fleet Hubs the server reports to; nil from a server that does not say.
    let hubs: [Hub]?
}
