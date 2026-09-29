import Foundation

/// One automation: when `trigger` fires and `condition` matches, run `steps`.
/// Mirrors `AutomationDefinition` in `packages/shared/src/types-automation.ts`.
struct AutomationDefinition: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var enabled: Bool
    var trigger: AutomationTrigger
    var condition: AutomationConditionGroup?
    var steps: [AutomationStep]?
    /// The legacy list, read then migrated to `steps`.
    var actions: [AutomationAction]?
    var createdAt: String
    var updatedAt: String
}
