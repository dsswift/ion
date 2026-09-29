import Foundation

/// `environment.host.toolchains`: which developer tools the server's host
/// has. Mirrors `EnvironmentToolchains` in `packages/shared/src/types-environment-admin.ts`.
struct EnvironmentToolchains: Decodable, Equatable, Sendable {

    struct Tool: Decodable, Equatable, Sendable, Identifiable {
        let name: String
        /// Nil when the tool is missing from the host.
        let path: String?
        let version: String?
        var id: String { name }
        var installed: Bool { path != nil }
    }

    let tools: [Tool]
}
