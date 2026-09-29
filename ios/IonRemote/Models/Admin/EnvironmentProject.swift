import Foundation

/// One project registered on a server, as `environment.projects.list` lists
/// it. Mirrors `EnvironmentProject` in `@ion/shared/types-environment-admin`.
struct EnvironmentProject: Decodable, Equatable, Sendable, Identifiable {

    /// The registry entry as the server's settings persist it; only the
    /// fields the phone reads.
    struct Entry: Decodable, Equatable, Sendable {
        let name: String?
        /// Canonical `host/org/repo` of the origin: how one repository is
        /// recognised across servers.
        let repoRemote: String?
        let clonedByIon: Bool?
        let cloneUrl: String?
        let trusted: Bool?
    }

    /// The last setup outcome this server lifetime.
    struct Setup: Decodable, Equatable, Sendable {
        enum State: String, Decodable, Sendable {
            case running, ready, failed, none
        }
        let state: State
        let detail: String?
        let at: Double
    }

    /// Absolute path on the server's host: the registry key.
    let dir: String
    let entry: Entry
    let displayName: String
    let exists: Bool
    let isGitRepo: Bool
    let branch: String?
    let originUrl: String?
    let usageCount: Int?
    let setup: Setup?
    let setupCommand: String?
    /// False while Ion may not run the project's code. Absent means trusted.
    let trusted: Bool?

    var id: String { dir }
    var isTrusted: Bool { trusted != false }
    var clonedByIon: Bool { entry.clonedByIon == true }
    /// The URL another server clones to get a copy.
    var copySourceURL: String? { entry.cloneUrl ?? originUrl }
}
