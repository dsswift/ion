import Foundation

/// `environment.projects.clone` and `gitHosting.startProject`: the job
/// that produces the checkout and the folder it lands in.
struct ProjectCloneStarted: Decodable, Equatable, Sendable {
    let jobId: String
    let dir: String
}
