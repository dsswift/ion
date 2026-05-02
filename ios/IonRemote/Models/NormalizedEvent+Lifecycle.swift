import Foundation

// MARK: - Lifecycle / session events

extension RemoteEvent {

    /// Decode snapshot, tab lifecycle, error, unpair, relay config, peer/heartbeat events.
    static func decodeLifecycle(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .snapshot:
            let tabs = try container.decode([RemoteTabState].self, forKey: .tabs)
            let recentDirs = try container.decodeIfPresent([String].self, forKey: .recentDirectories) ?? []
            let tabGroupMode = try container.decodeIfPresent(String.self, forKey: .tabGroupMode)
            let tabGroups = try container.decodeIfPresent([RemoteTabGroup].self, forKey: .tabGroups)
            return .snapshot(tabs: tabs, recentDirectories: recentDirs, tabGroupMode: tabGroupMode, tabGroups: tabGroups)

        case .tabCreated:
            let tab = try container.decode(RemoteTabState.self, forKey: .tab)
            return .tabCreated(tab: tab)

        case .tabClosed:
            let tabId = try container.decode(String.self, forKey: .tabId)
            return .tabClosed(tabId: tabId)

        case .tabStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let status = try container.decode(TabStatus.self, forKey: .status)
            return .tabStatus(tabId: tabId, status: status)

        case .unpair:
            return .unpair

        case .relayConfig:
            let relayUrl = try container.decode(String.self, forKey: .relayUrl)
            let relayApiKey = try container.decode(String.self, forKey: .relayApiKey)
            return .relayConfig(relayUrl: relayUrl, relayApiKey: relayApiKey)

        case .peerDisconnected:
            return .peerDisconnected

        case .transportReconnecting:
            return .transportReconnecting

        case .heartbeat:
            // Silently absorbed; should not normally reach the decoder.
            return .error(tabId: "", message: "")

        case .error:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let message = try container.decode(String.self, forKey: .message)
            return .error(tabId: tabId, message: message)

        default:
            return nil
        }
    }

    /// Encode lifecycle events. Returns `true` if the receiver was a lifecycle event.
    func encodeLifecycle(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .snapshot(let tabs, let recentDirectories, let tabGroupMode, let tabGroups):
            try container.encode(TypeKey.snapshot, forKey: .type)
            try container.encode(tabs, forKey: .tabs)
            if !recentDirectories.isEmpty {
                try container.encode(recentDirectories, forKey: .recentDirectories)
            }
            try container.encodeIfPresent(tabGroupMode, forKey: .tabGroupMode)
            try container.encodeIfPresent(tabGroups, forKey: .tabGroups)
            return true

        case .tabCreated(let tab):
            try container.encode(TypeKey.tabCreated, forKey: .type)
            try container.encode(tab, forKey: .tab)
            return true

        case .tabClosed(let tabId):
            try container.encode(TypeKey.tabClosed, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            return true

        case .tabStatus(let tabId, let status):
            try container.encode(TypeKey.tabStatus, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(status, forKey: .status)
            return true

        case .error(let tabId, let message):
            try container.encode(TypeKey.error, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(message, forKey: .message)
            return true

        case .unpair:
            try container.encode(TypeKey.unpair, forKey: .type)
            return true

        case .relayConfig(let relayUrl, let relayApiKey):
            try container.encode(TypeKey.relayConfig, forKey: .type)
            try container.encode(relayUrl, forKey: .relayUrl)
            try container.encode(relayApiKey, forKey: .relayApiKey)
            return true

        case .peerDisconnected:
            try container.encode(TypeKey.peerDisconnected, forKey: .type)
            return true

        case .transportReconnecting:
            try container.encode(TypeKey.transportReconnecting, forKey: .type)
            return true

        default:
            return false
        }
    }
}
