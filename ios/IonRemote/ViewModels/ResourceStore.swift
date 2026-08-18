import Foundation
import SwiftUI

// MARK: - Resource types

/// A single resource item delivered by the engine resource broker.
struct ResourceItem: Identifiable, Codable, Equatable {
    let id: String
    let kind: String
    let title: String?
    var content: String
    let createdAt: String
    let conversationId: String?
    let metadata: [String: String]

    init(from dict: [String: AnyCodable]) {
        id = dict["id"]?.value as? String ?? UUID().uuidString
        kind = dict["kind"]?.value as? String ?? ""
        title = dict["title"]?.value as? String
        content = dict["content"]?.value as? String ?? ""
        createdAt = dict["createdAt"]?.value as? String ?? ""
        conversationId = dict["conversationId"]?.value as? String
        if let meta = dict["metadata"]?.value as? [String: AnyCodable] {
            metadata = meta.compactMapValues { $0.value as? String }
        } else {
            metadata = [:]
        }
    }
}

/// A single incremental change delivered by the engine resource broker.
struct ResourceDelta {
    let op: String
    let item: ResourceItem

    init?(from dict: [String: AnyCodable]) {
        guard let op = dict["op"]?.value as? String,
              let itemDict = dict["item"]?.value as? [String: AnyCodable] else { return nil }
        self.op = op
        self.item = ResourceItem(from: itemDict)
    }
}


/// Persistence dependencies for ResourceStore. Production uses Documents and
/// standard defaults; tests inject isolated locations and a private suite.
struct ResourceStoreStorage {
    let itemsFileURL: URL
    let defaults: UserDefaults
    let readIdsKey: String
    let defaultsSuiteName: String?

    static let live = ResourceStoreStorage(
        itemsFileURL: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("resource-store-items.json"),
        defaults: .standard,
        readIdsKey: "resourceStore.readIds",
        defaultsSuiteName: nil
    )
}

// MARK: - ResourceStore

/// Observable store for workspace-level resources. Accumulates snapshot
/// and delta events from the engine's global resource broker.
///
/// Persistence: items and readIds survive app relaunches. Items are written
/// to a JSON file in the Documents directory; readIds are stored in
/// UserDefaults. Both are restored on init so the notifications panel shows
/// correct state immediately, before the first snapshot from the desktop
/// arrives.
@Observable
final class ResourceStore {

    // MARK: - State

    private let storage: ResourceStoreStorage

    /// Resources keyed by kind. Each kind maps to its item array.
    var items: [String: [ResourceItem]] = [:]

    /// IDs the user has opened. Client-local read tracking.
    var readIds: Set<String> = []

    /// IDs for which a content-fetch response has arrived (success or empty).
    /// Used by the UI to distinguish "still loading" from "response received
    /// but content was empty." Not persisted — reset on app relaunch.
    var contentResponseIds: Set<String> = []

    // MARK: - Derived

    /// Unread count across all kinds for workspace-scoped (global) items only.
    /// Conversation-scoped items (conversationId set) belong in the per-conversation
    /// attachments panel and must not inflate the global bell badge.
    var unreadCount: Int {
        items.values.flatMap { $0 }
            .filter { ($0.conversationId == nil || $0.conversationId?.isEmpty == true) && !readIds.contains($0.id) }
            .count
    }

    // MARK: - Init

    init(storage: ResourceStoreStorage = .live) {
        self.storage = storage
        readIds = loadReadIds()
        items = loadItems()
        DiagnosticLog.log("resource store restored", tag: "resource.store", fields: [
            "count": String(readIds.count),
            "kind": items.keys.joined(separator: ",")
        ])
    }

    // MARK: - Mutations

    /// Replace the entire collection for a kind (snapshot semantics).
    ///
    /// The desktop snapshot is authoritative for both items and read state.
    /// Items are replaced entirely; read state for items in this kind is
    /// replaced from the snapshot's `read` flags. Read IDs for other kinds
    /// are preserved so cross-kind state isn't lost.
    func applySnapshot(kind: String, rawItems: [[String: AnyCodable]]) {
        let parsed = rawItems.map { ResourceItem(from: $0) }
        let globalCount = parsed.filter { $0.conversationId == nil || $0.conversationId?.isEmpty == true }.count
        let scopedCount = parsed.filter { $0.conversationId != nil && $0.conversationId?.isEmpty == false }.count
        DiagnosticLog.log("resource store apply snapshot", tag: "resource.store", fields: [
            "kind": kind,
            "count": String(parsed.count),
            "global": String(globalCount),
            "scoped": String(scopedCount)
        ])

        // The desktop snapshot is authoritative. Always replace.
        // iOS is a thin client — it shows exactly what the desktop sends.
        // No merge guards needed here (those are for the desktop's engine
        // subscription path where partial/empty snapshots can arrive from
        // flaky extension subprocesses).
        let existing = items[kind] ?? []
        let existingById = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })

        // Preserve locally-fetched content for items that the snapshot
        // carries without content (manifest-only with metadata).
        let finalItems = parsed.map { item -> ResourceItem in
            if item.content.isEmpty, let prev = existingById[item.id], !prev.content.isEmpty {
                var copy = item
                copy.content = prev.content
                return copy
            }
            return item
        }
        // Normalize: deduplicate by ID so duplicate-ID items from a buggy
        // producer or a race between snapshot and delta never stack. Last
        // occurrence wins (consistent with desktop resource-slice).
        var seenIds = Set<String>()
        var deduped: [ResourceItem] = []
        for item in finalItems.reversed() {
            if seenIds.insert(item.id).inserted {
                deduped.append(item)
            }
        }
        deduped.reverse()
        items[kind] = deduped
        // Desktop snapshot is authoritative for read state of items in this kind.
        // Remove local read IDs for items in this snapshot, then add back only
        // those the desktop says are read. Read IDs for other kinds are preserved.
        let kindItemIds = Set(deduped.map { $0.id })
        let finalReadById = rawItems.reduce(into: [String: Bool]()) { reads, raw in
            guard let id = raw["id"]?.value as? String else { return }
            reads[id] = raw["read"]?.value as? Bool ?? false
        }
        let snapshotReadIds = Set(deduped.compactMap { item in
            finalReadById[item.id] == true ? item.id : nil
        })
        readIds = readIds.filter { !kindItemIds.contains($0) }.union(snapshotReadIds)
        saveItems()
        saveReadIds()
    }

    /// Apply an incremental delta (create/update/delete/mark_read).
    func applyDelta(kind: String, rawDelta: [String: AnyCodable]) {
        guard let delta = ResourceDelta(from: rawDelta) else {
            DiagnosticLog.log("resource store delta parse failed", tag: "resource.store", level: .warn, fields: [
                "kind": kind
            ])
            return
        }
        DiagnosticLog.log("resource store apply delta", tag: "resource.store", fields: [
            "kind": kind,
            "op": delta.op,
            "item_id": delta.item.id
        ])
        var current = items[kind] ?? []
        switch delta.op {
        case "create":
            if let idx = current.firstIndex(where: { $0.id == delta.item.id }) {
                current[idx] = delta.item
            } else {
                current.append(delta.item)
            }
        case "update":
            if let idx = current.firstIndex(where: { $0.id == delta.item.id }) {
                current[idx] = delta.item
            }
        case "delete":
            current.removeAll { $0.id == delta.item.id }
            readIds.remove(delta.item.id)
        case "mark_read":
            readIds.insert(delta.item.id)
        default:
            break
        }
        items[kind] = current
        saveItems()
        saveReadIds()
    }

    func markRead(_ id: String) {
        readIds.insert(id)
        saveReadIds()
    }

    /// Mark multiple resources as read in one batched mutation. Used by the
    /// notifications panel's "Clear All" action. Unions every id into readIds
    /// and persists once (not once per id). Engine fan-out — the per-item
    /// mark_read command that informs the desktop and other subscribers — is
    /// the caller's responsibility; this method only owns the local read set.
    func markAllRead(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        readIds.formUnion(ids)
        saveReadIds()
        DiagnosticLog.log("resource store mark all read", tag: "resource.store", fields: [
            "count": String(ids.count)
        ])
    }

    /// Permanently remove a single resource item from the local store.
    /// Called when the user deletes a notification in the iOS UI. The caller
    /// is responsible for also sending a `deleteResource` command to the
    /// desktop so the delete fans out to all subscribers via the engine.
    func deleteItem(kind: String, resourceId: String) {
        var current = items[kind] ?? []
        current.removeAll { $0.id == resourceId }
        items[kind] = current
        readIds.remove(resourceId)
        saveItems()
        saveReadIds()
        DiagnosticLog.log("resource store delete item", tag: "resource.store", fields: [
            "kind": kind,
            "item_id": resourceId
        ])
    }

    /// Populate the full content for a resource item fetched on demand.
    /// Called when a `resource_content` event arrives in response to a
    /// `request_resource_content` command iOS sent after the user tapped
    /// a card to expand it. The snapshot carries metadata only; this
    /// write fills in the body.
    func updateContent(kind: String, resourceId: String, content: String) {
        // Always record that a response arrived so the UI can exit loading state.
        contentResponseIds.insert(resourceId)
        guard var kindItems = items[kind] else { return }
        if let idx = kindItems.firstIndex(where: { $0.id == resourceId }) {
            kindItems[idx].content = content
            items[kind] = kindItems
            saveItems()
        }
    }

    /// Clear all in-memory and persisted state. Called on device switch or
    /// unpair so stale resources from the old desktop don't bleed into the
    /// new pairing's initial render.
    func wipe() {
        items = [:]
        readIds = []
        contentResponseIds = []
        deletePersistedItems()
        deletePersistedReadIds()
        DiagnosticLog.log("RESOURCE-STORE: wiped")
    }

    // MARK: - Persistence

    private func saveReadIds() {
        storage.defaults.set(Array(readIds), forKey: storage.readIdsKey)
    }

    private func saveItems() {
        do {
            let data = try JSONEncoder().encode(items)
            try data.write(to: storage.itemsFileURL, options: .atomic)
        } catch {
            DiagnosticLog.log("resource store save items failed", tag: "resource.store", level: .error, fields: [
                "error": error.localizedDescription
            ])
        }
    }

    private func loadReadIds() -> Set<String> {
        let arr = storage.defaults.stringArray(forKey: storage.readIdsKey) ?? []
        return Set(arr)
    }

    private func loadItems() -> [String: [ResourceItem]] {
        guard let data = try? Data(contentsOf: storage.itemsFileURL) else { return [:] }
        return (try? JSONDecoder().decode([String: [ResourceItem]].self, from: data)) ?? [:]
    }

    private func deletePersistedItems() {
        try? FileManager.default.removeItem(at: storage.itemsFileURL)
    }

    private func deletePersistedReadIds() {
        storage.defaults.removeObject(forKey: storage.readIdsKey)
    }
}
