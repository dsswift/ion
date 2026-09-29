import Foundation

/// `environment.purge.appraise`: what an uninstall would remove from the
/// host, so the person sees sizes and counts before choosing. Mirrors
/// `EnvironmentPurgeAppraisal` in `packages/shared/src/types-environment-admin.ts`.
struct EnvironmentPurgeAppraisal: Decodable, Equatable, Sendable {

    struct ClonedProject: Decodable, Equatable, Sendable, Identifiable {
        let dir: String
        let dirty: Bool
        let bytes: Double
        var id: String { dir }
    }

    struct Bundle: Decodable, Equatable, Sendable {
        let root: String
        let version: String
    }

    let conversations: Int
    let dataBytes: Double
    let clonedProjects: [ClonedProject]
    /// Hosts this pairing's git credentials on the server are for.
    let gitCredentialHosts: [String]
    /// Nil when the server was not installed from a bundle: nothing to uninstall.
    let bundle: Bundle?

    var dirtyClones: [ClonedProject] { clonedProjects.filter(\.dirty) }
    var clonedBytes: Double { clonedProjects.reduce(0) { $0 + $1.bytes } }
}
