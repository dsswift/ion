import XCTest
@testable import IonRemote

/// The composer's `+` menu lists the Composer Actions the server offers, read
/// from the snapshot alone, and choosing one sends its slash command.
@MainActor
final class ComposerActionsTests: XCTestCase {

    private func tabJSON(actions: String?) -> Data {
        let field = actions.map { #","composerActions":\#($0)"# } ?? ""
        return Data(#"{"id":"tab-1","title":"T","status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[]\#(field)}"#.utf8)
    }

    private let briefing = #"[{"id":"briefing","producer":"cos2","label":"Briefing","icon":"Newspaper","command":"/briefing"}]"#

    func testATabWithoutActionsOffersNone() throws {
        let vm = SessionViewModel()
        vm.handleSnapshot(snapshotTabs: [try JSONDecoder().decode(RemoteTabState.self, from: tabJSON(actions: nil))], recentDirs: [])
        XCTAssertEqual(vm.composerActions(tabId: "tab-1"), [])
    }

    func testTheSnapshotCarriesTheOfferedActions() throws {
        let vm = SessionViewModel()
        vm.handleSnapshot(snapshotTabs: [try JSONDecoder().decode(RemoteTabState.self, from: tabJSON(actions: briefing))], recentDirs: [])
        XCTAssertEqual(vm.composerActions(tabId: "tab-1"), [
            ComposerAction(id: "briefing", producer: "cos2", label: "Briefing", icon: "Newspaper", command: "/briefing", conversationId: nil),
        ])
    }

    func testChoosingAnActionSendsItsCommand() throws {
        let vm = SessionViewModel()
        vm.handleSnapshot(snapshotTabs: [try JSONDecoder().decode(RemoteTabState.self, from: tabJSON(actions: briefing))], recentDirs: [])
        let action = try XCTUnwrap(vm.composerActions(tabId: "tab-1").first)

        vm.runComposerAction(tabId: "tab-1", action: action)

        XCTAssertEqual(vm.tab(for: "tab-1")?.status, .connecting)
        XCTAssertEqual(vm.renderedMessages(tabId: "tab-1").last?.content, "/briefing")
    }

    func testTheSnapshotCarriesTheQuickToolsWithoutCommands() throws {
        let vm = SessionViewModel()
        let tools = #"[{"id":"fcea88f3","name":"Land","icon":"Upload"}]"#
        let json = Data(#"{"id":"tab-1","title":"T","status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"quickTools":\#(tools)}"#.utf8)
        vm.handleSnapshot(snapshotTabs: [try JSONDecoder().decode(RemoteTabState.self, from: json)], recentDirs: [])
        XCTAssertEqual(vm.quickTools(tabId: "tab-1"), [RemoteQuickTool(id: "fcea88f3", name: "Land", icon: "Upload")])
        XCTAssertEqual(vm.quickTools(tabId: "other"), [])
    }

    func testMenuKeysStayDistinctAcrossExtensions() {
        let a = ComposerAction(id: "run", producer: "one", label: "Run", icon: "", command: "/run", conversationId: nil)
        let b = ComposerAction(id: "run", producer: "two", label: "Run", icon: "", command: "/go", conversationId: nil)
        XCTAssertNotEqual(a.menuKey, b.menuKey)
    }
}
