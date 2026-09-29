import Foundation

/// What one connection to one paired server may do: the scopes its welcome
/// granted, and a sentence for each action it may not.
struct ServerAdminAccess: Equatable, Sendable {
    /// The server's name as the person knows it.
    let serverLabel: String
    /// The welcome's scopes. Nil until the connection is welcomed.
    let scopes: [String]?

    /// True when the connection is welcomed and holds the action's scope.
    func allows(_ action: PhoneAction) -> Bool { allows(scope: action.requiredScope) }

    /// Why `action` is refused, or nil when it is allowed or the scopes are not known yet.
    func denialReason(_ action: PhoneAction) -> String? { denialReason(scope: action.requiredScope) }

    /// True when the connection is welcomed and holds `scope`. For a write the
    /// server gates inside one action, such as an Environment key in `settings.save`.
    func allows(scope: StudioScope) -> Bool {
        guard let scopes else { return false }
        return scope.isSatisfied(by: scopes)
    }

    /// Why a write that needs `scope` is refused, or nil when it is allowed or the scopes are not known yet.
    func denialReason(scope: StudioScope) -> String? {
        guard let scopes, !scope.isSatisfied(by: scopes) else { return nil }
        return "Needs \(Self.accessName(scope)) on \(serverLabel). Pair again with a link that grants it."
    }

    private static func accessName(_ scope: StudioScope) -> String {
        switch scope {
        case .admin: return "admin access"
        case .gitWrite: return "git write access"
        case .terminalOperate: return "terminal access"
        case .conversationsOperate: return "permission to run conversations"
        case .conversationsRead: return "read access"
        }
    }
}
