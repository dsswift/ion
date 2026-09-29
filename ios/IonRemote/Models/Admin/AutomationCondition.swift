import Foundation

/// One comparison of an event field. `value` is absent for a presence operator.
struct AutomationCondition: Codable, Equatable, Sendable {
    var path: String
    var `operator`: AutomationConditionOperator
    var value: JSONValue?

    init(path: String, operator op: AutomationConditionOperator, value: JSONValue? = nil) {
        self.path = path
        self.operator = op
        self.value = value
    }

    private enum CodingKeys: String, CodingKey { case path, `operator`, value }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        self.operator = try container.decode(AutomationConditionOperator.self, forKey: .operator)
        // A JSON `null` is a real value to compare against, kept apart from absent.
        value = try container.decodeJSONIfPresent(forKey: .value)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(path, forKey: .path)
        try container.encode(self.operator, forKey: .operator)
        try container.encodeIfPresent(value, forKey: .value)
    }
}
