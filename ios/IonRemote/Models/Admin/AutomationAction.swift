import Foundation

/// One catalog action and its settings (`payload`).
struct AutomationAction: Codable, Equatable, Sendable {
    var kind: String
    var payload: [String: JSONValue]?
}
