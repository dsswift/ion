import Foundation

/// Branch list returned for a repository source-branch picker.
struct GitBranchesResponse: Codable, Sendable {
    let branches: [String]
    let current: String
}
