import Foundation

/// `environment.server.logTail`: the last lines of one of the server's logs.
struct EnvironmentLogTail: Decodable, Equatable, Sendable {
    /// Which log: the file name the action takes.
    enum File: String, CaseIterable, Sendable, Identifiable {
        case engine
        case server
        var id: String { rawValue }
        var fileName: String { "\(rawValue).jsonl" }
    }

    /// The log's path on the server's host.
    let path: String
    let lines: [String]
}
