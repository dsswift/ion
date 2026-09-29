import Foundation

/// `environment.server.info`: the server, engine, and host behind one paired
/// server. Mirrors `EnvironmentServerInfo` in
/// `packages/shared/src/types-environment-admin.ts`. The optional fields are
/// absent from a server that predates them.
struct EnvironmentServerInfo: Decodable, Equatable, Sendable {

    /// The installed Studio Server bundle, when the server was installed that way.
    struct Bundle: Decodable, Equatable, Sendable {
        struct Version: Decodable, Equatable, Sendable {
            let server: String
            let engine: String
            let node: String
        }
        let root: String
        let version: Version
    }

    /// The app running this server as its child.
    struct HostApp: Decodable, Equatable, Sendable {
        let name: String
        let version: String
    }

    let serverVersion: String
    let engineVersion: String?
    let hostname: String
    let platform: String
    let arch: String
    let home: String
    let dataDir: String
    /// Nil for a server launched by a desktop or from a checkout: Restart,
    /// Update, and Uninstall do not apply to it.
    let bundle: Bundle?
    let uptimeSeconds: Double
    let engineMinVersion: String?
    let engineMeetsMin: Bool?
    let hostApp: HostApp?
    let runningConversations: Int?
}
