import Foundation

// MARK: - Lifecycle / session events

extension RemoteEvent {

    /// Decode snapshot, tab lifecycle, error, unpair, relay config, peer/heartbeat events.
    static func decodeLifecycle(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .settledTabs:
            // Decoded record-by-record like the snapshot's `tabs`, so one
            // malformed settled row cannot cost the whole set.
            let raw = try container.decode([SafeDecodable<RemoteTabState>].self, forKey: .settledTabs)
            let tabs = raw.compactMap(\.value)
            if raw.count != tabs.count {
                DiagnosticLog.log("settled tabs decode failed", tag: "model.snapshot", level: .warn, fields: [
                    "dropped": String(raw.count - tabs.count),
                    "kept": String(tabs.count)
                ])
            }
            return .settledTabs(tabs: tabs)

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
            return .snapshot(tabs: tabs, recentDirectories: recentDirs, availableModels: availableModels, customName: customName, customIcon: customIcon, remoteDisplayUpdatedAt: updatedAt, resources: resources, projects: projects, worktreeStates: worktreeStates, settledTabs: settledTabs)

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
            // Volatile conversation fields (B6-1) — additive; a desktop that
            // predates them simply omits the keys and decode yields nil.
            let lastActivityAt = try container.decodeIfPresent(Double.self, forKey: .lastActivityAt)
            let lastMessageAt = try container.decodeIfPresent(Double.self, forKey: .lastMessageAt)
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
            return .tabMeta(tabId: tabId, title: title, totalCostUsd: resolvedCost, lastActivityAt: lastActivityAt, lastMessageAt: lastMessageAt, lastMessage: lastMessage, messageCount: messageCount, pillColor: pillColor)

        case .unpair:
            return .unpair

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

        case .requestDiagnosticLogs:
            let sinceSeq = try container.decodeIfPresent(Int.self, forKey: .sinceSeq) ?? 0
            return .requestDiagnosticLogs(sinceSeq: sinceSeq)

        case .desktopSlashModelTierIgnored:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let command = try container.decode(String.self, forKey: .command)
            let requested = try container.decode(String.self, forKey: .slashModelTierRequested)
            let serving = try container.decode(String.self, forKey: .slashModelTierServing)
            return .desktopSlashModelTierIgnored(tabId: tabId, instanceId: instanceId, command: command, slashModelTierRequested: requested, slashModelTierServing: serving)
        case .promptResult:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let clientMsgId = try container.decode(String.self, forKey: .clientMsgId)
            let status = try container.decode(String.self, forKey: .status)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            return .promptResult(tabId: tabId, clientMsgId: clientMsgId, status: status, error: error)

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
        case .settledTabs(let tabs):
            try container.encode(TypeKey.settledTabs, forKey: .type)
            try container.encode(tabs, forKey: .settledTabs)
            return true

        case .snapshot(let tabs, let recentDirectories, let availableModels, let customName, let customIcon, let remoteDisplayUpdatedAt, let resources, let projects, let worktreeStates, let settledTabs):
            try container.encode(TypeKey.snapshot, forKey: .type)
            try container.encode(tabs, forKey: .tabs)
            if !recentDirectories.isEmpty {
                try container.encode(recentDirectories, forKey: .recentDirectories)
            }
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

        case .tabMeta(let tabId, let title, let totalCostUsd, let lastActivityAt, let lastMessageAt, let lastMessage, let messageCount, let pillColor):
            try container.encode(TypeKey.tabMeta, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(title, forKey: .title)
            // Encode both runCostUsd (canonical) and totalCostUsd (deprecated compat)
            // so a downstream decoder that only reads one or the other still works.
            try container.encodeIfPresent(totalCostUsd, forKey: .runCostUsd)
            try container.encodeIfPresent(totalCostUsd, forKey: .totalCostUsd)
            try container.encodeIfPresent(lastActivityAt, forKey: .lastActivityAt)
            try container.encodeIfPresent(lastMessageAt, forKey: .lastMessageAt)
            try container.encodeIfPresent(lastMessage, forKey: .lastMessage)
            try container.encodeIfPresent(messageCount, forKey: .messageCount)
            if let pillColor {
                try container.encode(pillColor, forKey: .pillColor)
            }
            return true

        case .unpair:
            try container.encode(TypeKey.unpair, forKey: .type)
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

        case .requestDiagnosticLogs(let sinceSeq):
            try container.encode(TypeKey.requestDiagnosticLogs, forKey: .type)
            if sinceSeq > 0 {
                try container.encode(sinceSeq, forKey: .sinceSeq)
            }
            return true

        case .desktopSlashModelTierIgnored(let tabId, let instanceId, let command, let requested, let serving):
            try container.encode(TypeKey.desktopSlashModelTierIgnored, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(command, forKey: .command)
            try container.encode(requested, forKey: .slashModelTierRequested)
            try container.encode(serving, forKey: .slashModelTierServing)
            return true
        case .promptResult(let tabId, let clientMsgId, let status, let error):
            try container.encode(TypeKey.promptResult, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(clientMsgId, forKey: .clientMsgId)
            try container.encode(status, forKey: .status)
            try container.encodeIfPresent(error, forKey: .error)
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
