import XCTest
@testable import IonRemote

/// Behavior tests for ResourceStore.markAllRead — the batched mark-all-read
/// operation backing the notifications panel "Clear All" action.
///
/// Pins:
///   - markAllRead unions every passed id into readIds in one mutation.
///   - already-read ids are preserved (additive union).
///   - after marking, unreadCount drops to 0 for the marked global items.
///   - an empty list is a no-op.
///
/// These fail on the unfixed code (markAllRead absent). Engine fan-out (the
/// per-item .markResourceRead command sent by NotificationsView) is the view's
/// responsibility and is exercised separately; this pins the store's local
/// read-state contract.
@MainActor
final class ResourceStoreMarkAllReadTests: XCTestCase {

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

    private func makeRawItem(id: String, producer: String = "producer-a", kind: String = "briefing") -> [String: AnyCodable] {
        [
            "id": AnyCodable(id),
            "kind": AnyCodable(kind),
            "producer": AnyCodable(producer),
            "content": AnyCodable("body"),
            "createdAt": AnyCodable("2026-01-01T00:00:00.000Z"),
        ]
    }

    func testMarkAllReadUnionsEveryId() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [makeRawItem(id: "a"), makeRawItem(id: "b"), makeRawItem(id: "c")])
        let items = store.items["briefing"] ?? []
        store.markAllRead(items)
        XCTAssertTrue(store.readIds.contains(items[0].compositeId))
        XCTAssertTrue(store.readIds.contains(items[1].compositeId))
        XCTAssertTrue(store.readIds.contains(items[2].compositeId))
    }

    func testMarkAllReadPreservesExistingReadIds() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [makeRawItem(id: "existing"), makeRawItem(id: "new-1"), makeRawItem(id: "new-2")])
        let items = store.items["briefing"] ?? []
        store.markRead(items[0])
        store.markAllRead(Array(items.dropFirst()))
        XCTAssertTrue(store.readIds.contains(items[0].compositeId))
        XCTAssertTrue(store.readIds.contains(items[1].compositeId))
        XCTAssertTrue(store.readIds.contains(items[2].compositeId))
    }

    func testMarkAllReadDropsUnreadCountToZero() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [
            makeRawItem(id: "g-1"),
            makeRawItem(id: "g-2"),
        ])
        XCTAssertEqual(store.unreadCount, 2)

        store.markAllRead(store.items["briefing"] ?? [])
        XCTAssertEqual(store.unreadCount, 0)
    }

    func testMarkAllReadEmptyListIsNoOp() {
        let store = makeStore()
        store.wipe()
        store.applySnapshot(kind: "briefing", rawItems: [makeRawItem(id: "x")])
        store.markRead(store.items["briefing"]![0])
        let before = store.readIds
        store.markAllRead([])
        XCTAssertEqual(store.readIds, before)
    }
}
