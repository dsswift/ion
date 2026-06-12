import Foundation

// MARK: - Permission events

extension RemoteEvent {

    /// Decode permission request and resolution events.
    static func decodePermission(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .permissionRequest:
            let tabId = try container.decode(String.self, forKey: .tabId)
            // Engine sub-tab scoping — absent for CLI tabs and for older
            // desktops; nil keeps the legacy "show on the whole tab"
            // behavior (see EngineView.pendingPermission filter).
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let toolInput = try container.decodeIfPresent([String: AnyCodable].self, forKey: .toolInput)
            let options = try container.decode([PermissionOption].self, forKey: .options)
            return .permissionRequest(tabId: tabId, instanceId: instanceId, questionId: questionId, toolName: toolName, toolInput: toolInput, options: options)

        case .permissionResolved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            return .permissionResolved(tabId: tabId, questionId: questionId)

        default:
            return nil
        }
    }

    /// Encode permission events. Returns `true` if the receiver was a permission event.
    func encodePermission(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .permissionRequest(let tabId, let instanceId, let questionId, let toolName, let toolInput, let options):
            try container.encode(TypeKey.permissionRequest, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(questionId, forKey: .questionId)
            try container.encode(toolName, forKey: .toolName)
            try container.encodeIfPresent(toolInput, forKey: .toolInput)
            try container.encode(options, forKey: .options)
            return true

        case .permissionResolved(let tabId, let questionId):
            try container.encode(TypeKey.permissionResolved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(questionId, forKey: .questionId)
            return true

        default:
            return false
        }
    }
}

// MARK: - PermissionOption

struct PermissionOption: Codable, Identifiable, Sendable {
    let id: String
    let label: String
    let kind: String?
}
