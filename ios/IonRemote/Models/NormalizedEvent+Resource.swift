import Foundation

// MARK: - Resource subsystem events (D-007) and Notification events (D-009)
//
// engine_resource_snapshot / engine_resource_delta: iOS observes but does
// not act on these events in Phase 1 — decoding keeps the wire uniform so
// future handlers have a clean landing point.
//
// engine_notification: emitted when an extension calls ctx.notify(). The
// relay handles APNs push delivery; iOS decodes for diagnostic visibility.
//
// Split from NormalizedEvent+Engine.swift to keep that file under the cap.

extension RemoteEvent {

    static func decodeResource(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .engineResourceSnapshot:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let resourceKind = try container.decodeIfPresent(String.self, forKey: .resourceKind) ?? ""
            let resourceSubId = try container.decodeIfPresent(String.self, forKey: .resourceSubId) ?? ""
            let resourceItems = try container.decodeIfPresent([[String: AnyCodable]].self, forKey: .resourceItems) ?? []
            return .engineResourceSnapshot(
                tabId: tabId,
                instanceId: instanceId,
                resourceKind: resourceKind,
                resourceSubId: resourceSubId,
                resourceItems: resourceItems
            )

        case .engineResourceDelta:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let resourceKind = try container.decodeIfPresent(String.self, forKey: .resourceKind) ?? ""
            let resourceSubId = try container.decodeIfPresent(String.self, forKey: .resourceSubId) ?? ""
            let resourceDelta = try container.decodeIfPresent([String: AnyCodable].self, forKey: .resourceDelta) ?? [:]
            return .engineResourceDelta(
                tabId: tabId,
                instanceId: instanceId,
                resourceKind: resourceKind,
                resourceSubId: resourceSubId,
                resourceDelta: resourceDelta
            )

        case .engineNotification:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let notifyKind = try container.decodeIfPresent(String.self, forKey: .notifyKind) ?? ""
            let notifyTitle = try container.decodeIfPresent(String.self, forKey: .notifyTitle) ?? ""
            let notifyBody = try container.decodeIfPresent(String.self, forKey: .notifyBody) ?? ""
            let notifySound = try container.decodeIfPresent(String.self, forKey: .notifySound)
            let notifyScope = try container.decodeIfPresent(String.self, forKey: .notifyScope)
            return .engineNotification(
                tabId: tabId,
                instanceId: instanceId,
                notifyKind: notifyKind,
                notifyTitle: notifyTitle,
                notifyBody: notifyBody,
                notifySound: notifySound,
                notifyScope: notifyScope
            )

        default:
            return nil
        }
    }

    func encodeResource(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .engineResourceSnapshot(let tabId, let instanceId, let resourceKind, let resourceSubId, let resourceItems):
            try container.encode(TypeKey.engineResourceSnapshot, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(resourceKind, forKey: .resourceKind)
            try container.encode(resourceSubId, forKey: .resourceSubId)
            try container.encode(resourceItems, forKey: .resourceItems)
            return true

        case .engineResourceDelta(let tabId, let instanceId, let resourceKind, let resourceSubId, let resourceDelta):
            try container.encode(TypeKey.engineResourceDelta, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(resourceKind, forKey: .resourceKind)
            try container.encode(resourceSubId, forKey: .resourceSubId)
            try container.encode(resourceDelta, forKey: .resourceDelta)
            return true

        case .engineNotification(let tabId, let instanceId, let notifyKind, let notifyTitle, let notifyBody, let notifySound, let notifyScope):
            try container.encode(TypeKey.engineNotification, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(notifyKind, forKey: .notifyKind)
            try container.encode(notifyTitle, forKey: .notifyTitle)
            try container.encode(notifyBody, forKey: .notifyBody)
            try container.encodeIfPresent(notifySound, forKey: .notifySound)
            try container.encodeIfPresent(notifyScope, forKey: .notifyScope)
            return true

        default:
            return false
        }
    }
}
