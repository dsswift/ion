import Foundation

/// What one step of a run did: an action's outcome, or the branch it took.
indirect enum AutomationStepDecision: Codable, Equatable, Sendable {
    case action(kind: String, outcome: String, error: String?)
    case branch(condition: AutomationConditionDecision, selected: String, steps: [AutomationStepDecision])

    private enum CodingKeys: String, CodingKey { case type, kind, outcome, error, condition, selected, steps }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "action":
            self = .action(
                kind: try container.decode(String.self, forKey: .kind),
                outcome: try container.decode(String.self, forKey: .outcome),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )
        case "branch":
            self = .branch(
                condition: try container.decode(AutomationConditionDecision.self, forKey: .condition),
                selected: try container.decode(String.self, forKey: .selected),
                steps: try container.decode([AutomationStepDecision].self, forKey: .steps)
            )
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "unknown step decision \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .action(kind, outcome, error):
            try container.encode("action", forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encode(outcome, forKey: .outcome)
            try container.encodeIfPresent(error, forKey: .error)
        case let .branch(condition, selected, steps):
            try container.encode("branch", forKey: .type)
            try container.encode(condition, forKey: .condition)
            try container.encode(selected, forKey: .selected)
            try container.encode(steps, forKey: .steps)
        }
    }
}
