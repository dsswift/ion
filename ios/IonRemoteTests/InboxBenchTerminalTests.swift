import XCTest
@testable import IonRemote

final class InboxBenchTerminalTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testRecognizesOnlyProjectedBenchTerminalAndKeepsItOutOfConversationCount() throws {
        let state = try worktreeState(terminalTabId: "terminal")
        let conversation = try tab(id: "talk")
        let terminal = try tab(id: "terminal", pinned: true, terminal: true)
        let unrelated = try tab(id: "other-terminal", terminal: true)

        let project = try XCTUnwrap(InboxNavigator.projects(
            tabs: [conversation, terminal, unrelated],
            states: [state.repoPath: state]
        ).first)

        XCTAssertEqual(project.benchTabs.map(\.id), ["talk"])
        XCTAssertEqual(project.benchTerminals.map(\.id), ["terminal"])
        XCTAssertEqual(project.conversationCount, 1)
        XCTAssertEqual(InboxNavigator.collapsedRows(project.allTabs, activeTabId: nil).map(\.id), ["terminal"])
    }

    func testCollapsedBenchHidesIdleUnselectedUnpinnedTerminal() throws {
        let terminal = try tab(id: "terminal", terminal: true)
        XCTAssertTrue(InboxNavigator.collapsedRows([terminal], activeTabId: "outside").isEmpty)
    }

    func testCollapsedBenchOccupantsKeepSelectedTerminalAndWorkingConversation() throws {
        let selectedTerminal = try tab(id: "terminal", terminal: true)
        let workingConversation = try tab(id: "working", status: "running")
        let idleConversation = try tab(id: "idle")

        XCTAssertEqual(
            InboxNavigator.collapsedRows(
                [idleConversation, selectedTerminal, workingConversation],
                activeTabId: "terminal"
            ).map(\.id),
            ["terminal", "working"]
        )
    }

    func testBenchHeaderOmitsZeroConversationCountButKeepsPositiveCount() throws {
        let source = try self.source("IonRemote/Views/InboxBenchGroup.swift")
        XCTAssertTrue(source.contains("if !bench.openConversations.isEmpty"))
        XCTAssertTrue(source.contains("Text(\"\\(bench.openConversations.count)\")"))
    }

    func testTerminalUsesTerminalOnlyActionsAndBenchConversationCannotBeNewlyPinned() throws {
        let terminalSource = try source("IonRemote/Views/InboxBenchTerminalRow.swift")
        XCTAssertTrue(terminalSource.contains("viewModel.pinTab(tabId: tab.id)"))
        XCTAssertTrue(terminalSource.contains("viewModel.unpinTab(tabId: tab.id)"))
        XCTAssertTrue(terminalSource.contains("viewModel.closeTab(tab.id)"))
        XCTAssertTrue(terminalSource.contains("Pin Terminal"))
        XCTAssertTrue(terminalSource.contains("Unpin Terminal"))
        XCTAssertTrue(terminalSource.contains("Close Terminal"))
        XCTAssertFalse(terminalSource.contains("Settle"))
        XCTAssertFalse(terminalSource.contains("Snooze"))

        let inboxSource = try source("IonRemote/Views/TabListView+Inbox.swift")
        XCTAssertTrue(inboxSource.contains("if !viewModel.isBenchConversation(tab) || tab.pinnedAt != nil"))
    }

    private func source(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func tab(
        id: String,
        pinned: Bool = false,
        terminal: Bool = false,
        status: String = "idle"
    ) throws -> RemoteTabState {
        let pinField = pinned ? ",\"pinnedAt\":1" : ""
        let terminalField = terminal ? ",\"isTerminalOnly\":true" : ""
        let data = """
        {"id":"\(id)","title":"\(id)","status":"\(status)","workingDirectory":"/bench/main",
        "permissionMode":"auto","permissionQueue":[]\(pinField)\(terminalField)}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteTabState.self, from: data)
    }

    private func worktreeState(terminalTabId: String) throws -> RemoteWorktreeState {
        let data = """
        {"repoPath":"/repo","worktrees":[],"benches":[{"repoPath":"/repo","sourceBranch":"main",
        "benchPath":"/bench/main","benchBranch":"bench/main","baseSha":"abc","lastBuiltAt":0,
        "baseDrifted":false,"benchTerminalTabId":"\(terminalTabId)"}]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: data)
    }
}
