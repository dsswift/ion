import Foundation

/// How a condition compares an event field. Mirrors `AutomationConditionOperator`
/// in `packages/shared/src/types-automation.ts`.
enum AutomationConditionOperator: String, Codable, CaseIterable, Sendable {
    case equals
    case notEquals = "not-equals"
    case exists
    case notExists = "not-exists"
    case contains
    case notContains = "not-contains"
    case matches
    case greaterThan = "greater-than"
    case greaterThanOrEquals = "greater-than-or-equals"
    case lessThan = "less-than"
    case lessThanOrEquals = "less-than-or-equals"

    /// Presence operators take no value.
    var isPresence: Bool { self == .exists || self == .notExists }
}
