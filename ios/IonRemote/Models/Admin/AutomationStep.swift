import Foundation

/// One step of an automation: an action, or a branch. On the wire a branch is
/// the member with a `type`.
enum AutomationStep: Codable, Equatable, Sendable {
    case action(AutomationAction)
    case branch(AutomationBranchStep)

    private enum Probe: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        if try decoder.container(keyedBy: Probe.self).contains(.type) {
            self = .branch(try AutomationBranchStep(from: decoder))
        } else {
            self = .action(try AutomationAction(from: decoder))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .action(let action): try action.encode(to: encoder)
        case .branch(let branch): try branch.encode(to: encoder)
        }
    }
}
