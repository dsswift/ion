import Foundation

// MARK: - Terminal events

extension RemoteEvent {

    /// Decode terminal output, exit, and instance lifecycle events.
    static func decodeTerminal(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .terminalOutput:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let data = try container.decode(String.self, forKey: .data)
            return .terminalOutput(tabId: tabId, instanceId: instanceId, data: data)

        case .terminalExit:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let exitCode = try container.decode(Int.self, forKey: .exitCode)
            return .terminalExit(tabId: tabId, instanceId: instanceId, exitCode: exitCode)

        case .terminalInstanceAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instance = try container.decode(TerminalInstanceInfo.self, forKey: .instance)
            return .terminalInstanceAdded(tabId: tabId, instance: instance)

        case .terminalInstanceRemoved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            return .terminalInstanceRemoved(tabId: tabId, instanceId: instanceId)

        case .terminalSnapshot:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instances = try container.decode([TerminalInstanceInfo].self, forKey: .instances)
            let activeInstanceId = try container.decodeIfPresent(String.self, forKey: .activeInstanceId)
            let buffers = try container.decodeIfPresent([String: String].self, forKey: .buffers)
            return .terminalSnapshot(tabId: tabId, instances: instances, activeInstanceId: activeInstanceId, buffers: buffers)

        default:
            return nil
        }
    }

    /// Encode terminal events. Returns `true` if the receiver was a terminal event.
    func encodeTerminal(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .terminalOutput(let tabId, let instanceId, let data):
            try container.encode(TypeKey.terminalOutput, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(data, forKey: .data)
            return true

        case .terminalExit(let tabId, let instanceId, let exitCode):
            try container.encode(TypeKey.terminalExit, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(exitCode, forKey: .exitCode)
            return true

        case .terminalInstanceAdded(let tabId, let instance):
            try container.encode(TypeKey.terminalInstanceAdded, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instance, forKey: .instance)
            return true

        case .terminalInstanceRemoved(let tabId, let instanceId):
            try container.encode(TypeKey.terminalInstanceRemoved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            return true

        case .terminalSnapshot(let tabId, let instances, let activeInstanceId, let buffers):
            try container.encode(TypeKey.terminalSnapshot, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instances, forKey: .instances)
            try container.encodeIfPresent(activeInstanceId, forKey: .activeInstanceId)
            try container.encodeIfPresent(buffers, forKey: .buffers)
            return true

        default:
            return false
        }
    }
}
