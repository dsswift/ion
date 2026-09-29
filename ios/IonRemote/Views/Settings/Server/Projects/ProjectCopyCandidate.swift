import Foundation

/// A project another server has that this one lacks, matched by its
/// repository remote.
struct ProjectCopyCandidate: Identifiable, Equatable, Sendable {
    let sourceLabel: String
    let project: EnvironmentProject
    /// The repository remote: the candidate's identity across servers.
    let remote: String
    let cloneURL: String

    var id: String { remote }
}
