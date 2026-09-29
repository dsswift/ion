import Foundation

/// The chain of automations that led to a run, used to stop cycles.
struct AutomationCausation: Codable, Equatable, Sendable {
    let rootId: String
    let chain: [String]
    let depth: Int
}
