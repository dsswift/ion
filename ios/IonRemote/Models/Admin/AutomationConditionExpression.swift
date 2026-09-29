import Foundation

/// A condition or a nested group. On the wire a condition is the member with a `path`.
enum AutomationConditionExpression: Codable, Equatable, Sendable {
    case condition(AutomationCondition)
    case group(AutomationConditionGroup)

    private enum Probe: String, CodingKey { case path }

    init(from decoder: Decoder) throws {
        if try decoder.container(keyedBy: Probe.self).contains(.path) {
            self = .condition(try AutomationCondition(from: decoder))
        } else {
            self = .group(try AutomationConditionGroup(from: decoder))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .condition(let condition): try condition.encode(to: encoder)
        case .group(let group): try group.encode(to: encoder)
        }
    }
}
