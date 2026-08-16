import XCTest
@testable import IonRemote

/// Behavior tests for ResourceStore duplicate-ID idempotency.
///
/// Pins:
///   - applySnapshot deduplicates items by ID (last occurrence wins).
///   - applyDelta create op upserts when an item with the same ID exists.
///   - create op appends normally when no duplicate exists.
///   - update, delete, mark_read ops are unaffected.
@MainActor
final class ResourceStoreDeltaTests: XCTestCase {

    private var storage: ResourceStoreStorage!

    override func setUp() {
        super.setUp()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("resource-store-tests-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let suiteName = "resource-store-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        storage = ResourceStoreStorage(
            itemsFileURL: directory.appendingPathComponent("items.json"),
            defaults: defaults,
            readIdsKey: "readIds",
            defaultsSuiteName: suiteName
        )
    }

    override func tearDown() {
        if let suiteName = storage.defaultsSuiteName {
            storage.defaults.removePersistentDomain(forName: suiteName)
        }
        try? FileManager.default.removeItem(at: storage.itemsFileURL.deletingLastPathComponent())
        storage = nil
        super.tearDown()
    }

    private func makeStore() -> ResourceStore {
        ResourceStore(storage: storage)
    }

    private func makeRawItem(id: String, kind: String = "briefing", content: String = "body", read: Bool = false) -> [String: AnyCodable] {
        [
            "id": AnyCodable(id),
            "kind": AnyCodable(kind),
            "content": AnyCodable(content),
            "createdAt": AnyCodable("2026-01-01T00:00:00.000Z"),
            "read": AnyCodable(read),
        ]
    }

    private func makeRawDelta(op: String, id: String, content: String = "body") -> [String: AnyCodable] {
        [
            "op": AnyCodable(op),
            "item": AnyCodable([
                "id": AnyCodable(id),
                "kind": AnyCodable("briefing"),
                "content": AnyCodable(content),
                "createdAt": AnyCodable("2026-01-01T00:00:00.000Z"),
            ] as [String: AnyCodable]),
        ]
    }

    // MARK: - Snapshot normalization

    func testSnapshotDeduplicatesByIdLastWins() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "a", content: "old-a"),
            makeRawItem(id: "b"),
            makeRawItem(id: "a", content: "new-a"),
        ])
        let briefings = store.items["briefing"] ?? []
        XCTAssertEqual(briefings.count, 2)
        let aItem = briefings.first { $0.id == "a" }
        XCTAssertEqual(aItem?.content, "new-a")
    }

    func testSnapshotUsesFinalDuplicateReadState() {
        let store = makeStore()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "a", content: "stale-read", read: true),
            makeRawItem(id: "a", content: "final-unread", read: false),
        ])
        XCTAssertEqual(store.items["briefing"]?.first?.content, "final-unread")
        XCTAssertFalse(store.readIds.contains("a"))
    }

    func testSnapshotPreservesOrderAfterDedup() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "x", content: "x1"),
            makeRawItem(id: "y", content: "y1"),
            makeRawItem(id: "x", content: "x2"),
        ])
        let ids = (store.items["briefing"] ?? []).map { $0.id }
        XCTAssertEqual(ids, ["y", "x"])
    }

    func testSnapshotNoOpOnUniqueIds() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "a"),
            makeRawItem(id: "b"),
            makeRawItem(id: "c"),
        ])
        XCTAssertEqual(store.items["briefing"]?.count, 3)
    }

    // MARK: - Create upsert

    func testCreateAppendsWhenNoExistingId() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [makeRawItem(id: "a")])
        store.applyDelta(kind: "briefing", rawDelta: makeRawDelta(op: "create", id: "b", content: "new"))
        XCTAssertEqual(store.items["briefing"]?.count, 2)
        XCTAssertEqual(store.items["briefing"]?.last?.id, "b")
    }

    func testCreateUpsertsWhenIdExists() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "a"),
            makeRawItem(id: "b", content: "old-b"),
        ])
        store.applyDelta(kind: "briefing", rawDelta: makeRawDelta(op: "create", id: "b", content: "new-b"))
        let briefings = store.items["briefing"] ?? []
        XCTAssertEqual(briefings.count, 2)
        let bItem = briefings.first { $0.id == "b" }
        XCTAssertEqual(bItem?.content, "new-b")
    }

    func testCreateUpsertPreservesPosition() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "a"),
            makeRawItem(id: "b", content: "old"),
            makeRawItem(id: "c"),
        ])
        store.applyDelta(kind: "briefing", rawDelta: makeRawDelta(op: "create", id: "b", content: "updated"))
        let ids = (store.items["briefing"] ?? []).map { $0.id }
        XCTAssertEqual(ids, ["a", "b", "c"])
    }

    // MARK: - Existing ops unchanged

    func testUpdateReplacesMatchingItem() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [makeRawItem(id: "a", content: "old")])
        store.applyDelta(kind: "briefing", rawDelta: makeRawDelta(op: "update", id: "a", content: "new"))
        XCTAssertEqual(store.items["briefing"]?.first?.content, "new")
    }

    func testDeleteRemovesMatchingItem() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "a"),
            makeRawItem(id: "b"),
        ])
        store.applyDelta(kind: "briefing", rawDelta: makeRawDelta(op: "delete", id: "a"))
        XCTAssertEqual(store.items["briefing"]?.count, 1)
        XCTAssertEqual(store.items["briefing"]?.first?.id, "b")
    }

    func testMarkReadSetsReadState() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [makeRawItem(id: "a")])
        store.applyDelta(kind: "briefing", rawDelta: makeRawDelta(op: "mark_read", id: "a"))
        XCTAssertTrue(store.readIds.contains("a"))
    }
}
