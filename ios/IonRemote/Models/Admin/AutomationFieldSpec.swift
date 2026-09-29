import Foundation

/// An event field a condition may compare, and the operators it allows.
struct AutomationFieldSpec: Codable, Equatable, Sendable {
    let path: String
    let label: String
    let type: AutomationFieldType
    let operators: [AutomationConditionOperator]
    /// The finite values of an enum field, in display order.
    let values: [AutomationFieldChoice]?

    init(path: String, label: String, type: AutomationFieldType, operators: [AutomationConditionOperator], values: [AutomationFieldChoice]? = nil) {
        self.path = path
        self.label = label
        self.type = type
        self.operators = operators
        self.values = values
    }
}
