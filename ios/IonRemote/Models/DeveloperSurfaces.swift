import Foundation

/// The developer surfaces a server offers this connection, from
/// `studio_welcome.developerSurfaces`. Mirrors `DeveloperSurfaceState` in
/// `packages/shared/src/developer-surfaces.ts`.
///
/// A surface that is off has no controls here: the server refuses its
/// actions and withholds its events, so a control for it could only fail.
struct DeveloperSurfaces: Codable, Equatable, Sendable {
    /// The changes list and every write to a repository.
    var sourceControl: Bool
    /// The commit graph and commit details.
    var commitGraph: Bool
    /// Read-only branch and status indicators.
    var repositoryStatus: Bool
    /// Worktrees and integration benches.
    var worktrees: Bool
    /// A CPU profile or heap snapshot of the server process (`profile.capture`).
    /// This client offers no capture control; it keeps the value so the frame
    /// round-trips whole.
    var profiling: Bool = true

    /// Every surface on: the state before a welcome arrives, and the state a
    /// server that predates developer surfaces is read as.
    static let allEnabled = DeveloperSurfaces(sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true, profiling: true)

    /// The Git pane holds the changes list and the commit graph, so either keeps it.
    var gitPaneOffered: Bool { sourceControl || commitGraph }

    /// Whether any surface reads live repository state. With none, nothing asks for it.
    var repositoryFeedOffered: Bool { sourceControl || commitGraph || repositoryStatus }
}

extension DeveloperSurfaces {
    /// `profiling` is read as on when absent: a server that predates it
    /// sends the first four surfaces only.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sourceControl = try container.decode(Bool.self, forKey: .sourceControl)
        commitGraph = try container.decode(Bool.self, forKey: .commitGraph)
        repositoryStatus = try container.decode(Bool.self, forKey: .repositoryStatus)
        worktrees = try container.decode(Bool.self, forKey: .worktrees)
        profiling = try container.decodeIfPresent(Bool.self, forKey: .profiling) ?? true
    }
}
