import XCTest
import UIKit
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

    /// Every icon name Studio's two tables accept, read from the desktop source,
    /// has an SF Symbol that exists, so the phone never drops to a fallback
    /// for a name the desktop draws.
    func testEveryStudioIconNameHasARealSymbol() throws {
        let renderer = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("desktop/src/renderer/components")
        let tables = [
            (file: "QuickToolsTray.tsx", table: "const ICON_MAP"),
            (file: "composer/useComposerActions.tsx", table: "const ACTION_ICONS"),
        ]
        var names: Set<String> = []
        for (file, table) in tables {
            let source = try String(contentsOf: renderer.appendingPathComponent(file), encoding: .utf8)
            let start = try XCTUnwrap(source.range(of: table), "\(table) missing from \(file)")
            let body = try XCTUnwrap(source[start.upperBound...].range(of: "{"))
            let end = try XCTUnwrap(source[body.upperBound...].range(of: "}"))
            let entries = source[body.upperBound..<end.lowerBound]
                .split(whereSeparator: { $0 == "," || $0.isNewline })
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            XCTAssertFalse(entries.isEmpty, "no icon names parsed from \(file)")
            names.formUnion(entries)
        }
        for name in names {
            let symbol = try XCTUnwrap(PhosphorSymbol.systemNames[name], "no SF Symbol for \(name)")
            XCTAssertNotNil(UIImage(systemName: symbol), "\(symbol) is not an SF Symbol")
        }
        for symbol in Set(PhosphorSymbol.systemNames.values) {
            XCTAssertNotNil(UIImage(systemName: symbol), "\(symbol) is not an SF Symbol")
        }
    }

    func testAnUnknownIconNameFallsBackPerKind() {
        XCTAssertEqual(RemoteQuickTool(id: "t", name: "T", icon: "Nope").systemImage, "bolt")
        XCTAssertEqual(RemoteQuickTool(id: "t", name: "T", icon: "Upload").systemImage, "square.and.arrow.up")
        let action = ComposerAction(id: "a", producer: "p", label: "A", icon: "Nope", command: "/a", conversationId: nil)
        XCTAssertEqual(action.systemImage, "puzzlepiece.extension")
    }
}
