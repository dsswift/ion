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
            let preferredModel = try container.decodeIfPresent(String.self, forKey: .preferredModel)
            let engineDefaultModel = try container.decodeIfPresent(String.self, forKey: .engineDefaultModel)
            let availableModels = try container.decodeIfPresent([RemoteModelEntry].self, forKey: .availableModels)
            // Per-desktop display override fields (added 2025). All optional;
            // legacy desktops omit them and we treat that as "no override".
            let customName = try container.decodeIfPresent(String.self, forKey: .customName)
            let customIcon = try container.decodeIfPresent(String.self, forKey: .customIcon)
            let updatedAtMs = try container.decodeIfPresent(Double.self, forKey: .remoteDisplayUpdatedAt)
            let updatedAt = updatedAtMs.map { Date(timeIntervalSince1970: $0 / 1000.0) }
            return .snapshot(tabs: tabs, recentDirectories: recentDirs, tabGroupMode: tabGroupMode, tabGroups: tabGroups, preferredModel: preferredModel, engineDefaultModel: engineDefaultModel, availableModels: availableModels, customName: customName, customIcon: customIcon, remoteDisplayUpdatedAt: updatedAt)

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

        case .remoteDisplay:
            // Both fields are nullable on the wire — server normalizes empty
            // strings and unknown icons to `null` before broadcasting.
            let customName = try container.decodeIfPresent(String.self, forKey: .customName)
            let customIcon = try container.decodeIfPresent(String.self, forKey: .customIcon)
            let updatedAtMs = try container.decode(Double.self, forKey: .updatedAt)
            return .remoteDisplay(
                customName: customName,
                customIcon: customIcon,
                updatedAt: Date(timeIntervalSince1970: updatedAtMs / 1000.0),
            )

        case .peerDisconnected:
            return .peerDisconnected

        case .transportReconnecting:
            return .transportReconnecting

        case .heartbeat:
            let senderTs = try container.decodeIfPresent(Double.self, forKey: .ts) ?? 0
            let buffered = try container.decodeIfPresent(Int.self, forKey: .buffered) ?? 0
            return .heartbeat(senderTs: senderTs, buffered: buffered)

        case .error:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let message = try container.decode(String.self, forKey: .message)
            return .error(tabId: tabId, message: message)

        case .requestDiagnosticLogs:
            return .requestDiagnosticLogs

        default:
            return nil
        }
    }

    /// Encode lifecycle events. Returns `true` if the receiver was a lifecycle event.
    func encodeLifecycle(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .snapshot(let tabs, let recentDirectories, let tabGroupMode, let tabGroups, let preferredModel, let engineDefaultModel, let availableModels, let customName, let customIcon, let remoteDisplayUpdatedAt):
            try container.encode(TypeKey.snapshot, forKey: .type)
            try container.encode(tabs, forKey: .tabs)
            if !recentDirectories.isEmpty {
                try container.encode(recentDirectories, forKey: .recentDirectories)
            }
            try container.encodeIfPresent(tabGroupMode, forKey: .tabGroupMode)
            try container.encodeIfPresent(tabGroups, forKey: .tabGroups)
            try container.encodeIfPresent(preferredModel, forKey: .preferredModel)
            try container.encodeIfPresent(engineDefaultModel, forKey: .engineDefaultModel)
            try container.encodeIfPresent(availableModels, forKey: .availableModels)
            try container.encodeIfPresent(customName, forKey: .customName)
            try container.encodeIfPresent(customIcon, forKey: .customIcon)
            if let remoteDisplayUpdatedAt {
                try container.encode(remoteDisplayUpdatedAt.timeIntervalSince1970 * 1000.0, forKey: .remoteDisplayUpdatedAt)
            }
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

        case .remoteDisplay(let customName, let customIcon, let updatedAt):
            try container.encode(TypeKey.remoteDisplay, forKey: .type)
            if let customName {
                try container.encode(customName, forKey: .customName)
            } else {
                try container.encodeNil(forKey: .customName)
            }
            if let customIcon {
                try container.encode(customIcon, forKey: .customIcon)
            } else {
                try container.encodeNil(forKey: .customIcon)
            }
            try container.encode(updatedAt.timeIntervalSince1970 * 1000.0, forKey: .updatedAt)
            return true

        case .peerDisconnected:
            try container.encode(TypeKey.peerDisconnected, forKey: .type)
            return true

        case .transportReconnecting:
            try container.encode(TypeKey.transportReconnecting, forKey: .type)
            return true

        case .heartbeat(let senderTs, let buffered):
            try container.encode(TypeKey.heartbeat, forKey: .type)
            try container.encode(senderTs, forKey: .ts)
            try container.encode(buffered, forKey: .buffered)
            return true

        case .requestDiagnosticLogs:
            try container.encode(TypeKey.requestDiagnosticLogs, forKey: .type)
            return true

        default:
            return false
        }
    }
}
