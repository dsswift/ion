import Foundation
import SwiftUI

// MARK: - Resource types

/// A single resource item delivered by the engine resource broker.
struct ResourceItem: Identifiable, Codable, Equatable {
    let id: String
    let kind: String
    /// Engine-assigned extension identity. Together with `id`, this is the
    /// resource identity because different producers can use the same item ID.
    let producer: String
    let title: String?
    var content: String
    let createdAt: String
    let conversationId: String?
    let metadata: [String: String]
    let updatedAt: String?
    let read: Bool

    /// Stable client-local identity for all resource mutations and read state.
    var compositeId: String { Self.compositeId(kind: kind, producer: producer, id: id) }

    static func compositeId(kind: String, producer: String, id: String) -> String { "\(kind)\u{0}\(producer)\u{0}\(id)" }

    init(from dict: [String: AnyCodable]) {
        id = dict["id"]?.value as? String ?? UUID().uuidString
        kind = dict["kind"]?.value as? String ?? ""
        producer = dict["producer"]?.value as? String ?? ""
        title = dict["title"]?.value as? String
        content = dict["content"]?.value as? String ?? ""
        createdAt = dict["createdAt"]?.value as? String ?? ""
        conversationId = dict["conversationId"]?.value as? String
        updatedAt = dict["updatedAt"]?.value as? String
        read = dict["read"]?.value as? Bool ?? false
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

    /// Producer-qualified IDs the user has opened. Client-local read tracking.
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
            .filter { ($0.conversationId == nil || $0.conversationId?.isEmpty == true) && !readIds.contains($0.compositeId) }
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
    func applySnapshot(kind: String, rawItems: [[String: AnyCodable]], producers: [String]? = nil, complete: Bool = true) {
        let parsed = rawItems.map { ResourceItem(from: $0) }
        let globalCount = parsed.filter { $0.conversationId == nil || $0.conversationId?.isEmpty == true }.count
        let scopedCount = parsed.filter { $0.conversationId != nil && $0.conversationId?.isEmpty == false }.count
        DiagnosticLog.log("resource store apply snapshot", tag: "resource.store", fields: [
            "kind": kind,
            "count": String(parsed.count),
            "global": String(globalCount),
            "scoped": String(scopedCount)
        ])

        let existing = items[kind] ?? []
        let covered: Set<String>?
        let mode: String
        if complete {
            covered = nil
            mode = "complete"
        } else if let producers {
            covered = Set(producers)
            mode = "explicit"
        } else if parsed.contains(where: { !$0.producer.isEmpty }) {
            covered = Set(parsed.map(\.producer).filter { !$0.isEmpty })
            mode = "inferred"
        } else if !parsed.isEmpty {
            covered = nil
            mode = "legacy-full"
        } else {
            covered = Set()
            mode = "ambiguous-empty-retain"
        }
        let retained = covered.map { coveredSet in
            existing.filter { $0.producer.isEmpty || !coveredSet.contains($0.producer) }
        } ?? []
        let existingById = Dictionary(existing.map { ($0.compositeId, $0) }, uniquingKeysWith: { _, new in new })

        // Preserve locally-fetched content for items that the snapshot
        // carries without content (manifest-only with metadata).
        let finalItems = parsed.map { item -> ResourceItem in
            if item.content.isEmpty, let prev = existingById[item.compositeId], !prev.content.isEmpty {
                var copy = item
                copy.content = prev.content
                return copy
            }
            return item
        }
        // Normalize by producer-qualified identity. Multiple producers can
        // legitimately publish the same ID under one kind. Last occurrence
        // wins only for duplicate items from the same producer.
        var seenIds = Set<String>()
        var deduped: [ResourceItem] = []
        for item in (retained + finalItems).reversed() {
            if seenIds.insert(item.compositeId).inserted {
                deduped.append(item)
            }
        }
        deduped.reverse()
        items[kind] = deduped
        DiagnosticLog.log("resource store snapshot applied", tag: "resource.store", fields: [
            "kind": kind,
            "mode": mode,
            "replaced": String(existing.count - retained.count),
            "retained": String(retained.count),
            "final": String(deduped.count)
        ])
        // Snapshot read state is authoritative only for producers covered by
        // this snapshot. Preserve read state owned by retained producers.
        let affectedItems = covered.map { coveredSet in
            deduped.filter { !$0.producer.isEmpty && coveredSet.contains($0.producer) }
        } ?? deduped
        let kindItemIds = Set(affectedItems.map(\.compositeId))
        let legacyReadIds = Set(affectedItems.compactMap { item in
            item.producer.isEmpty || !readIds.contains(item.id) ? nil : item.id
        })
        let finalReadById = Dictionary(
            parsed.map { ($0.compositeId, $0.read) },
            uniquingKeysWith: { _, new in new }
        )
        let snapshotReadIds = Set(affectedItems.compactMap { item in
            finalReadById[item.compositeId] == true || legacyReadIds.contains(item.id) ? item.compositeId : nil
        })
        readIds = readIds.filter { !kindItemIds.contains($0) && !legacyReadIds.contains($0) }.union(snapshotReadIds)
        saveItems()
        saveReadIds()
    }

    /// Apply the desktop's complete resource catalog. Kinds absent from the
    /// manifest are authoritatively empty.
    func applyCompleteManifest(_ manifest: [String: [[String: AnyCodable]]]) {
        let allKinds = Set(items.keys).union(manifest.keys)
        for kind in allKinds {
            applySnapshot(kind: kind, rawItems: manifest[kind] ?? [], complete: true)
        }
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
            if let idx = current.firstIndex(where: { $0.compositeId == delta.item.compositeId }) {
                current[idx] = delta.item
            } else {
                current.append(delta.item)
            }
        case "update":
            if let idx = current.firstIndex(where: { $0.compositeId == delta.item.compositeId }) {
                current[idx] = delta.item
            }
        case "delete":
            current.removeAll { $0.compositeId == delta.item.compositeId }
            readIds.remove(delta.item.compositeId)
        case "mark_read":
            readIds.insert(delta.item.compositeId)
        default:
            break
        }
        items[kind] = current
        saveItems()
        saveReadIds()
    }

    func markRead(_ item: ResourceItem) {
        readIds.insert(item.compositeId)
        saveReadIds()
    }

    /// Mark multiple resources as read in one batched mutation. Used by the
    /// notifications panel's "Clear All" action. Unions every id into readIds
    /// and persists once (not once per id). Engine fan-out — the per-item
    /// mark_read command that informs the desktop and other subscribers — is
    /// the caller's responsibility; this method only owns the local read set.
    func markAllRead(_ items: [ResourceItem]) {
        guard !items.isEmpty else { return }
        readIds.formUnion(items.map(\.compositeId))
        saveReadIds()
        DiagnosticLog.log("resource store mark all read", tag: "resource.store", fields: [
            "count": String(items.count)
        ])
    }

    /// Permanently remove a single resource item from the local store.
    /// Called when the user deletes a notification in the iOS UI. The caller
    /// is responsible for also sending a `deleteResource` command to the
    /// desktop so the delete fans out to all subscribers via the engine.
    func deleteItem(kind: String, producer: String?, resourceId: String) {
        var current = items[kind] ?? []
        let compositeId = ResourceItem.compositeId(kind: kind, producer: producer ?? "", id: resourceId)
        current.removeAll { $0.compositeId == compositeId }
        items[kind] = current
        readIds.remove(compositeId)
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
    func updateContent(kind: String, producer: String, resourceId: String, content: String) {
        // Always record that a response arrived so the UI can exit loading state.
        let compositeId = ResourceItem.compositeId(kind: kind, producer: producer, id: resourceId)
        contentResponseIds.insert(compositeId)
        guard var kindItems = items[kind] else { return }
        if let idx = kindItems.firstIndex(where: { $0.compositeId == compositeId }) {
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
