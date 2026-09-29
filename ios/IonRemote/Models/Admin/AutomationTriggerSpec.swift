import Foundation

/// An event an automation may start on, the fields it carries, and which
/// action targets it can supply.
struct AutomationTriggerSpec: Codable, Equatable, Sendable {
    struct Provides: Codable, Equatable, Sendable {
        let worktree: Bool
        let conversation: Bool
    }

    let event: String
    let label: String
    let provides: Provides
    let fields: [AutomationFieldSpec]

    func field(_ path: String) -> AutomationFieldSpec? {
        fields.first { $0.path == path }
    }
}
