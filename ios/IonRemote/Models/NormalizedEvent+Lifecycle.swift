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
            // Decode tabs individually so a single malformed tab doesn't kill
            // the entire snapshot. SafeDecodable performs a best-effort decode
            // and surfaces nil for failures.
            let rawTabs = try container.decode([SafeDecodable<RemoteTabState>].self, forKey: .tabs)
            let tabs = rawTabs.compactMap(\.value)
            if rawTabs.count != tabs.count {
                DiagnosticLog.log("snapshot decode tabs failed", tag: "model.snapshot", level: .warn, fields: [
                    "count": String(rawTabs.count - tabs.count),
                    "max": String(tabs.count)
                ])
            }
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
            let resources = try container.decodeIfPresent([String: [[String: AnyCodable]]].self, forKey: .resources)
            let projects = try container.decodeIfPresent([RemoteProject].self, forKey: .projects) ?? []
            // Worktree/bench state and settled-tab history, additive to the
            // core tab list. worktreeStates feeds SessionViewModel's
            // per-repo worktree cache (SessionViewModel+WorktreeCommands);
            // settledTabs feeds the Inbox's settled-shelf history
            // (SessionViewModel+InboxCommands). Both absent on a desktop
            // snapshot that carries neither (e.g. no worktrees configured).
            // settledTabs is decoded tab-by-tab via SafeDecodable so one
            // malformed settled record can't fail the whole snapshot,
            // matching the primary `tabs` decode above.
            let worktreeStates = try container.decodeIfPresent([RemoteWorktreeState].self, forKey: .worktreeStates)
            let settledTabs = try container.decodeIfPresent([SafeDecodable<RemoteTabState>].self, forKey: .settledTabs)?.compactMap(\.value)
            return .snapshot(tabs: tabs, recentDirectories: recentDirs, tabGroupMode: tabGroupMode, tabGroups: tabGroups, preferredModel: preferredModel, engineDefaultModel: engineDefaultModel, availableModels: availableModels, customName: customName, customIcon: customIcon, remoteDisplayUpdatedAt: updatedAt, resources: resources, projects: projects, worktreeStates: worktreeStates, settledTabs: settledTabs)

        case .tabCreated:
            let tab = try container.decode(RemoteTabState.self, forKey: .tab)
            let clientCmdId = try container.decodeIfPresent(String.self, forKey: .clientCmdId)
            return .tabCreated(tab: tab, clientCmdId: clientCmdId)

        case .tabClosed:
            let tabId = try container.decode(String.self, forKey: .tabId)
            return .tabClosed(tabId: tabId)

        case .tabStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let status = try container.decode(TabStatus.self, forKey: .status)
            let resync = try container.decodeIfPresent(Bool.self, forKey: .resync) ?? false
            return .tabStatus(tabId: tabId, status: status, resync: resync)

        case .tabMeta:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let title = try container.decodeIfPresent(String.self, forKey: .title)
            // runCostUsd is the canonical field; fall back to totalCostUsd
            // (deprecated) for snapshots sent by older desktops before this rename.
            let runCostUsd = try container.decodeIfPresent(Double.self, forKey: .runCostUsd)
            let totalCostUsd = try container.decodeIfPresent(Double.self, forKey: .totalCostUsd)
            let resolvedCost = runCostUsd ?? totalCostUsd
            let groupId = try container.decodeIfPresent(String.self, forKey: .groupId)
            // Volatile conversation fields (B6-1) — additive; a desktop that
            // predates them simply omits the keys and decode yields nil.
            let convFingerprint = try container.decodeIfPresent(String.self, forKey: .convFingerprint)
            let lastActivityAt = try container.decodeIfPresent(Double.self, forKey: .lastActivityAt)
            let lastMessage = try container.decodeIfPresent(String.self, forKey: .lastMessage)
            let messageCount = try container.decodeIfPresent(Int.self, forKey: .messageCount)
            // Preserve omitted versus explicit-null fields: omitted metadata
            // must not overwrite current customization, while JSON null clears it.
            let pillColor: String??
            if container.contains(.pillColor) {
                pillColor = try container.decode(String?.self, forKey: .pillColor)
            } else {
                pillColor = Optional<Optional<String>>.none
            }
            let pillIcon: String??
            if container.contains(.pillIcon) {
                pillIcon = try container.decode(String?.self, forKey: .pillIcon)
            } else {
                pillIcon = Optional<Optional<String>>.none
            }
            return .tabMeta(tabId: tabId, title: title, totalCostUsd: resolvedCost, groupId: groupId, convFingerprint: convFingerprint, lastActivityAt: lastActivityAt, lastMessage: lastMessage, messageCount: messageCount, pillColor: pillColor, pillIcon: pillIcon)

        case .unpair:
            return .unpair

        case .relayConfig:
            let relayUrl = try container.decode(String.self, forKey: .relayUrl)
            let relayApiKey = try container.decode(String.self, forKey: .relayApiKey)
            // Enterprise Relay Phase 1 additive fields. Pre-enterprise desktops omit
            // them; decoding must succeed without them (backward compat).
            let authMode = try container.decodeIfPresent(String.self, forKey: .authMode)
            let relayOidcIssuer = try container.decodeIfPresent(String.self, forKey: .relayOidcIssuer)
            let relayOidcAudience = try container.decodeIfPresent(String.self, forKey: .relayOidcAudience)
            let relayOidcRequiredScope = try container.decodeIfPresent(String.self, forKey: .relayOidcRequiredScope)
            let relayOidcClientId = try container.decodeIfPresent(String.self, forKey: .relayOidcClientId)
            return .relayConfig(
                relayUrl: relayUrl,
                relayApiKey: relayApiKey,
                authMode: authMode,
                relayOidcIssuer: relayOidcIssuer,
                relayOidcAudience: relayOidcAudience,
                relayOidcRequiredScope: relayOidcRequiredScope,
                relayOidcClientId: relayOidcClientId
            )

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

        case .lanAuthRejected:
            return .lanAuthRejected

        case .heartbeat:
            let senderTs = try container.decodeIfPresent(Double.self, forKey: .ts) ?? 0
            let buffered = try container.decodeIfPresent(Int.self, forKey: .buffered) ?? 0
            return .heartbeat(senderTs: senderTs, buffered: buffered)

        case .resendUnavailable:
            let fromSeq = try container.decodeIfPresent(UInt64.self, forKey: .fromSeq) ?? 0
            return .resendUnavailable(fromSeq: fromSeq)

        case .error:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let message = try container.decode(String.self, forKey: .message)
            return .error(tabId: tabId, message: message)

        case .requestDiagnosticLogs:
            let sinceSeq = try container.decodeIfPresent(Int.self, forKey: .sinceSeq) ?? 0
            return .requestDiagnosticLogs(sinceSeq: sinceSeq)

        case .promptResult:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let clientMsgId = try container.decode(String.self, forKey: .clientMsgId)
            let status = try container.decode(String.self, forKey: .status)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            return .promptResult(tabId: tabId, clientMsgId: clientMsgId, status: status, error: error)

        case .backgroundWorkDelivered:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decode(Message.self, forKey: .message)
            return .backgroundWorkDelivered(tabId: tabId, instanceId: instanceId, message: message)

        case .backgroundTaskStopResult:
            return .backgroundTaskStopResult(
                requestId: try container.decode(String.self, forKey: .requestId),
                taskId: try container.decode(String.self, forKey: .taskId),
                status: try container.decode(String.self, forKey: .status),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )


        default:
            return nil
        }
    }

    /// Encode lifecycle events. Returns `true` if the receiver was a lifecycle event.
    func encodeLifecycle(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .snapshot(let tabs, let recentDirectories, let tabGroupMode, let tabGroups, let preferredModel, let engineDefaultModel, let availableModels, let customName, let customIcon, let remoteDisplayUpdatedAt, let resources, let projects, let worktreeStates, let settledTabs):
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
            try container.encodeIfPresent(resources, forKey: .resources)
            try container.encode(projects, forKey: .projects)
            try container.encodeIfPresent(worktreeStates, forKey: .worktreeStates)
            try container.encodeIfPresent(settledTabs, forKey: .settledTabs)
            return true

        case .tabCreated(let tab, let clientCmdId):
            try container.encode(TypeKey.tabCreated, forKey: .type)
            try container.encode(tab, forKey: .tab)
            try container.encodeIfPresent(clientCmdId, forKey: .clientCmdId)
            return true

        case .tabClosed(let tabId):
            try container.encode(TypeKey.tabClosed, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            return true

        case .tabStatus(let tabId, let status, let resync):
            try container.encode(TypeKey.tabStatus, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(status, forKey: .status)
            if resync {
                try container.encode(true, forKey: .resync)
            }
            return true

        case .tabMeta(let tabId, let title, let totalCostUsd, let groupId, let convFingerprint, let lastActivityAt, let lastMessage, let messageCount, let pillColor, let pillIcon):
            try container.encode(TypeKey.tabMeta, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(title, forKey: .title)
            // Encode both runCostUsd (canonical) and totalCostUsd (deprecated compat)
            // so a downstream decoder that only reads one or the other still works.
            try container.encodeIfPresent(totalCostUsd, forKey: .runCostUsd)
            try container.encodeIfPresent(totalCostUsd, forKey: .totalCostUsd)
            try container.encodeIfPresent(groupId, forKey: .groupId)
            try container.encodeIfPresent(convFingerprint, forKey: .convFingerprint)
            try container.encodeIfPresent(lastActivityAt, forKey: .lastActivityAt)
            try container.encodeIfPresent(lastMessage, forKey: .lastMessage)
            try container.encodeIfPresent(messageCount, forKey: .messageCount)
            if let pillColor {
                try container.encode(pillColor, forKey: .pillColor)
            }
            if let pillIcon {
                try container.encode(pillIcon, forKey: .pillIcon)
            }
            return true

        case .error(let tabId, let message):
            try container.encode(TypeKey.error, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(message, forKey: .message)
            return true

        case .unpair:
            try container.encode(TypeKey.unpair, forKey: .type)
            return true

        case .relayConfig(let relayUrl, let relayApiKey, let authMode, let relayOidcIssuer, let relayOidcAudience, let relayOidcRequiredScope, let relayOidcClientId):
            try container.encode(TypeKey.relayConfig, forKey: .type)
            try container.encode(relayUrl, forKey: .relayUrl)
            try container.encode(relayApiKey, forKey: .relayApiKey)
            try container.encodeIfPresent(authMode, forKey: .authMode)
            try container.encodeIfPresent(relayOidcIssuer, forKey: .relayOidcIssuer)
            try container.encodeIfPresent(relayOidcAudience, forKey: .relayOidcAudience)
            try container.encodeIfPresent(relayOidcRequiredScope, forKey: .relayOidcRequiredScope)
            try container.encodeIfPresent(relayOidcClientId, forKey: .relayOidcClientId)
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

        case .lanAuthRejected:
            try container.encode(TypeKey.lanAuthRejected, forKey: .type)
            return true

        case .heartbeat(let senderTs, let buffered):
            try container.encode(TypeKey.heartbeat, forKey: .type)
            try container.encode(senderTs, forKey: .ts)
            try container.encode(buffered, forKey: .buffered)
            return true

        case .resendUnavailable(let fromSeq):
            try container.encode(TypeKey.resendUnavailable, forKey: .type)
            try container.encode(fromSeq, forKey: .fromSeq)
            return true

        case .requestDiagnosticLogs(let sinceSeq):
            try container.encode(TypeKey.requestDiagnosticLogs, forKey: .type)
            if sinceSeq > 0 {
                try container.encode(sinceSeq, forKey: .sinceSeq)
            }
            return true

        case .promptResult(let tabId, let clientMsgId, let status, let error):
            try container.encode(TypeKey.promptResult, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(clientMsgId, forKey: .clientMsgId)
            try container.encode(status, forKey: .status)
            try container.encodeIfPresent(error, forKey: .error)
            return true

        case .backgroundWorkDelivered(let tabId, let instanceId, let message):
            try container.encode(TypeKey.backgroundWorkDelivered, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            return true

        case .backgroundTaskStopResult(let requestId, let taskId, let status, let error):
            try container.encode(TypeKey.backgroundTaskStopResult, forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(taskId, forKey: .taskId)
            try container.encode(status, forKey: .status)
            try container.encodeIfPresent(error, forKey: .error)
            return true

        default:
            return false
        }
    }
}
