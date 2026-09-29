import XCTest
@testable import IonRemote

/// The notification kinds editor: which kinds it offers, and that a change is
/// saved as this phone's own Personal preference.
@MainActor
final class NotificationKindsTests: XCTestCase {

    private let storedKey = "clientSetting.excludedResourceKinds"

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: storedKey)
        super.tearDown()
    }

    private func item(kind: String, conversationId: String? = nil) -> ResourceItem {
        var dict: [String: AnyCodable] = ["id": AnyCodable(UUID().uuidString), "kind": AnyCodable(kind)]
        if let conversationId { dict["conversationId"] = AnyCodable(conversationId) }
        return ResourceItem(from: dict)
    }

    func testOffersSeenWorkspaceKindsAndHiddenOnesSorted() {
        let seen = [
            "briefing": [item(kind: "briefing")],
            "chart": [item(kind: "chart", conversationId: "c1")],
            "ion-studio.menu": [item(kind: "ion-studio.menu")],
            "desktop.focus": [item(kind: "desktop.focus")],
            "alert": [item(kind: "alert")],
        ]
        XCTAssertEqual(NotificationKinds.kinds(seen: seen, excluded: ["quiet"]), ["alert", "briefing", "quiet"])
    }

    func testTogglingKeepsASortedBlocklist() {
        XCTAssertEqual(NotificationKinds.excluded(["b"], setting: "a", shown: false), ["a", "b"])
        XCTAssertEqual(NotificationKinds.excluded(["a", "b"], setting: "a", shown: true), ["b"])
    }

    /// The save goes through the projected-row path: stored on the phone, laid
    /// over the snapshot, and the snapshot keeps its pages.
    func testSaveStaysOnThePhoneAndKeepsThePages() {
        let viewModel = SessionViewModel()
        viewModel.serverSettings = SettingsRootFixtures.state()

        viewModel.setServerSetting(key: NotificationKinds.key, value: NotificationKinds.value(["alert", "briefing"]))

        XCTAssertEqual(NotificationKinds.excluded(in: viewModel.serverSettings), ["alert", "briefing"])
        let stored = PersonalPreferencesStore.value(for: NotificationKinds.key)?.value as? [AnyCodable]
        XCTAssertEqual(stored?.compactMap { $0.value as? String }, ["alert", "briefing"])
        XCTAssertEqual(viewModel.serverSettings?.pages.map(\.id), SettingsRootFixtures.pages.map(\.id))
    }
}
