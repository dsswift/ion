import Foundation

/// How a run's conditions decided: one comparison, a group of decisions, or
/// no conditions at all. Mirrors `AutomationConditionDecisionResult`.
indirect enum AutomationConditionDecision: Codable, Equatable, Sendable {
    case condition(path: String, operator: String, expected: JSONValue?, actual: JSONValue?, matched: Bool)
    case group(all: [AutomationConditionDecision], any: [AutomationConditionDecision], matched: Bool)
    case none

    private enum CodingKeys: String, CodingKey { case type, path, `operator`, expected, actual, matched, all, any }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "condition":
            self = .condition(
                path: try container.decode(String.self, forKey: .path),
                operator: try container.decode(String.self, forKey: .operator),
                expected: try container.decodeJSONIfPresent(forKey: .expected),
                actual: try container.decodeJSONIfPresent(forKey: .actual),
                matched: try container.decode(Bool.self, forKey: .matched)
            )
        case "group":
            self = .group(
                all: try container.decode([AutomationConditionDecision].self, forKey: .all),
                any: try container.decode([AutomationConditionDecision].self, forKey: .any),
                matched: try container.decode(Bool.self, forKey: .matched)
            )
        case "none":
            self = .none
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "unknown condition decision \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .condition(path, op, expected, actual, matched):
            try container.encode("condition", forKey: .type)
            try container.encode(path, forKey: .path)
            try container.encode(op, forKey: .operator)
            try container.encodeIfPresent(expected, forKey: .expected)
            try container.encodeIfPresent(actual, forKey: .actual)
            try container.encode(matched, forKey: .matched)
        case let .group(all, any, matched):
            try container.encode("group", forKey: .type)
            try container.encode(all, forKey: .all)
            try container.encode(any, forKey: .any)
            try container.encode(matched, forKey: .matched)
        case .none:
            try container.encode("none", forKey: .type)
            try container.encode(true, forKey: .matched)
        }
    }
}
