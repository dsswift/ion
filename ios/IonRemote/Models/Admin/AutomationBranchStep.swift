import Foundation

/// A conditional step: `then` runs when `condition` matches, else `else`.
struct AutomationBranchStep: Codable, Equatable, Sendable {
    var type: String = "branch"
    var condition: AutomationConditionGroup
    var then: [AutomationStep]
    var `else`: [AutomationStep]?

    private enum CodingKeys: String, CodingKey { case type, condition, then, `else` }
}
