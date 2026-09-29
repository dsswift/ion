import XCTest
@testable import IonRemote

/// Behavior and Defaults list the phone's own settings the connected server
/// files on that page, grouped by the page's sections in the server's order.
final class ClientOwnedPageContentTests: XCTestCase {

    func testBehaviorGroupsDeviceSettingsBySectionInPageOrder() {
        let groups = ClientOwnedPageContent.groups(in: SettingsRootFixtures.state(), pageId: "behavior")
        XCTAssertEqual(groups, [
            .init(id: "device-behavior", label: "Conversations and alerts", keys: ["showTodoList"]),
            .init(id: "device-git", label: "Git panel", keys: ["gitChangesTreeView"]),
        ])
    }

    func testDefaultsHoldsOnlyPersonalSettingsOfThatPage() {
        let groups = ClientOwnedPageContent.groups(in: SettingsRootFixtures.state(), pageId: "defaults")
        XCTAssertEqual(groups.flatMap(\.keys), ["aiGeneratedTitles", "defaultThinkingEffort"])
    }

    /// A server setting is never listed under This iPhone or You, whatever page it names.
    func testServerSettingsNeverAppear() {
        let state = SettingsRootFixtures.state()
        let all = ["behavior", "defaults", "notifications", "workflow"].flatMap { ClientOwnedPageContent.groups(in: state, pageId: $0) }
        XCTAssertFalse(all.flatMap(\.keys).contains("inboxAutoSettleDays"))
    }

    func testSectionTheSnapshotDoesNotDescribeStillShows() {
        let base = SettingsRootFixtures.state()
        let state = ServerSettingsState(settings: [:], schema: base.schema, groups: base.groups, pages: [])
        let groups = ClientOwnedPageContent.groups(in: state, pageId: "behavior")
        XCTAssertEqual(groups, [.init(id: "behavior.other", label: nil, keys: ["gitChangesTreeView", "showTodoList"])])
    }
}
