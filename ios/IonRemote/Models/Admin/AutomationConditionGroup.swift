import Foundation

/// Conditions joined by `all` (every one matches) and `any` (at least one does).
struct AutomationConditionGroup: Codable, Equatable, Sendable {
    var all: [AutomationConditionExpression]?
    var any: [AutomationConditionExpression]?
}
