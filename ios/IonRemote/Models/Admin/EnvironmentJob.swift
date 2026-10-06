import Foundation

/// A background job a server runs on a project: a clone, a setup, a purge,
/// or a create (a new repository, its clone, and a conversation opened in
/// it). Mirrors `EnvironmentJob` in `@ion/shared/types-environment-admin`;
/// every change arrives whole on `ion:project-job`.
struct EnvironmentJob: Decodable, Equatable, Sendable, Identifiable {
    enum Kind: String, Decodable, Sendable {
        case clone, setup, purge, create

        /// What a running job of this kind is doing, to open a sentence.
        /// Mirrors `environmentJobTitle` in `@ion/shared`.
        var title: String {
            switch self {
            case .clone: return "Cloning"
            case .setup: return "Setting up"
            case .purge: return "Purging"
            case .create: return "Creating"
            }
        }
    }

    enum Phase: String, Decodable, Sendable {
        case running, done, failed, cancelled
    }

    let id: String
    let kind: Kind
    /// The project directory the job produces or acts on.
    let dir: String
    let phase: Phase
    /// Short human stage: `receiving objects`, `running setup`.
    let stage: String
    /// 0...100 when the stage reports progress.
    let percent: Double?
    let detail: String?
    let error: String?
    let startedAt: Double
    let endedAt: Double?
    /// For a clone: the URL it clones.
    let url: String?
    /// For a create: the conversation it opened, once it is open.
    let tabId: String?
}
