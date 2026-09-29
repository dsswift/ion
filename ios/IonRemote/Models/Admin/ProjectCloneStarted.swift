import Foundation

/// `environment.projects.clone`: the job cloning the repository and the
/// folder it lands in.
struct ProjectCloneStarted: Decodable, Equatable, Sendable {
    let jobId: String
    let dir: String
}
