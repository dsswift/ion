import XCTest
@testable import IonRemote

final class InboxNavigatorTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testSettledStackUsesNewestSettledTimeAcrossColdAndLiveRows() throws {
        let cold = try tab(id: "cold", directory: "/repo", state: "settled", settledAt: 100)
        let live = try tab(id: "live", directory: "/repo", state: "settled", settledAt: 200)
        let stack = InboxNavigator.settledStack(liveTabs: [live], coldTabs: [cold])
        XCTAssertEqual(stack.map(\.id), ["live", "cold"])
    }

    func testNavigatorCreatesAnInventoryProjectForAnEmptyActiveWorktree() throws {
        let state = try worktreeState()
        let projects = InboxNavigator.projects(tabs: [], states: [state.repoPath: state])
        let project = try XCTUnwrap(projects.first)
        XCTAssertEqual(project.id, "/repo")
        XCTAssertEqual(project.conversationCount, 0)
        XCTAssertEqual(project.worktreeOrder, ["/repo/.ion/worktrees/a"])
        XCTAssertEqual(InboxNavigator.orderedWorktrees(for: project).map(\.worktreePath), ["/repo/.ion/worktrees/a"])
    }

    func testNavigatorOmitsLandedInventoryWorktreesWithoutConversations() throws {
        let state = try worktreeState()
        var landed = state.worktrees[0]
        landed.landedAt = 1
        let landedState = RemoteWorktreeState(repoPath: state.repoPath, worktrees: [landed], benches: [])

        XCTAssertTrue(InboxNavigator.projects(tabs: [], states: [landedState.repoPath: landedState]).isEmpty)
    }

    func testNavigatorPlacesWorktreeConversationUnderAuthoritativeWorktree() throws {
        let state = try worktreeState()
        let tab = try tab(id: "conversation", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil)
        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [state.repoPath: state]).first)
        XCTAssertEqual(project.worktreeTabs["/repo/.ion/worktrees/a"]?.map(\.id), ["conversation"])
        XCTAssertTrue(project.sourceTabs.isEmpty)
    }

    func testNavigatorPlacesNestedWorktreeConversationUnderAuthoritativeWorktree() throws {
        let state = try worktreeState()
        let tab = try tab(id: "nested", directory: "/repo/.ion/worktrees/a/packages/app", state: "active", settledAt: nil)
        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [state.repoPath: state]).first)
        XCTAssertEqual(project.worktreeTabs["/repo/.ion/worktrees/a"]?.map(\.id), ["nested"])
        XCTAssertTrue(project.sourceTabs.isEmpty)
    }

    /// A legacy desktop could send the same worktree inventory through source,
    /// worktree, and bench aliases. The Inbox must use one deterministic owner,
    /// not Dictionary(uniqueKeysWithValues:), which traps on repeated paths.
    func testNavigatorGroupsDuplicateAliasStatesUnderCanonicalProject() throws {
        let canonical = try worktreeState()
        let aliasJSON = """
        {"repoPath":"/repo/.ion/worktrees/a","worktrees":[{"worktreePath":"/repo/.ion/worktrees/a",
        "branchName":"wt/a","label":"a","head":"abc","lastCommitSubject":"","isDirty":false,
        "unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true}],"benches":[]}
        """.data(using: .utf8)!
        let alias = try decoder.decode(RemoteWorktreeState.self, from: aliasJSON)
        let tab = try tab(id: "conversation", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil)

        let projects = InboxNavigator.projects(tabs: [tab], states: [
            canonical.repoPath: canonical,
            alias.repoPath: alias
        ])

        XCTAssertEqual(projects.map(\.id), ["/repo"])
        XCTAssertEqual(projects.first?.worktreeTabs["/repo/.ion/worktrees/a"]?.map(\.id), ["conversation"])
    }

    func testCollapsedRowsShowOnlyPins() throws {
        let later = try tab(id: "later", directory: "/repo", state: "active", settledAt: nil, activity: 300, pinnedAt: 2, pinOrderKey: "z")
        let first = try tab(id: "first", directory: "/repo", state: "active", settledAt: nil, activity: 100, pinnedAt: 1, pinOrderKey: "a")
        let active = try tab(id: "active", directory: "/repo", state: "active", settledAt: nil, activity: 200)
        XCTAssertEqual(InboxNavigator.collapsedRows([later, active, first], activeTabId: "active").map(\.id), ["first", "later"])
        XCTAssertEqual(InboxNavigator.collapsedRows([later, first], activeTabId: "later").map(\.id), ["first", "later"])
    }

    func testWorktreeCycleExpandsBeforeSelectingTheNextConversation() throws {
        let newer = try tab(id: "newer", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil, activity: 200)
        let older = try tab(id: "older", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil, activity: 100)
        var expansion: Set<String> = []

        let first = InboxNavigator.prepareWorktreeCycle(
            [older, newer],
            currentTabId: nil,
            worktreePath: "/repo/.ion/worktrees/a",
            expansion: &expansion
        )
        XCTAssertTrue(first.didExpand)
        XCTAssertEqual(first.next?.id, "newer")
        XCTAssertEqual(expansion, ["worktree:/repo/.ion/worktrees/a"])

        let second = InboxNavigator.prepareWorktreeCycle(
            [older, newer],
            currentTabId: "newer",
            worktreePath: "/repo/.ion/worktrees/a",
            expansion: &expansion
        )
        XCTAssertFalse(second.didExpand)
        XCTAssertEqual(second.next?.id, "older")
    }

    /// The project-header counterpart to the worktree-cycle regression above:
    /// tapping a collapsed project header must expand it before selecting the
    /// next conversation, so the newly-opened conversation is actually visible
    /// in the list rather than opening while its group stays shut.
    func testProjectCycleExpandsBeforeSelectingTheNextConversation() throws {
        let newer = try tab(id: "newer", directory: "/repo", state: "active", settledAt: nil, activity: 200)
        let older = try tab(id: "older", directory: "/repo", state: "active", settledAt: nil, activity: 100)
        var expansion: Set<String> = []

        let first = InboxNavigator.prepareProjectCycle(
            [older, newer],
            currentTabId: nil,
            projectId: "/repo",
            expansion: &expansion
        )
        XCTAssertTrue(first.didExpand)
        XCTAssertEqual(first.next?.id, "newer")
        XCTAssertEqual(expansion, ["project:/repo"])

        let second = InboxNavigator.prepareProjectCycle(
            [older, newer],
            currentTabId: "newer",
            projectId: "/repo",
            expansion: &expansion
        )
        XCTAssertFalse(second.didExpand)
        XCTAssertEqual(second.next?.id, "older")
    }

    func testGroupCycleUsesRecentActivityIncludesPinsAndWraps() throws {
        let newestPinned = try tab(id: "new", directory: "/repo", state: "active", settledAt: nil, activity: 300, pinnedAt: 1)
        let middle = try tab(id: "middle", directory: "/repo", state: "active", settledAt: nil, activity: 200)
        let oldestPinned = try tab(id: "old", directory: "/repo", state: "active", settledAt: nil, activity: 100, pinnedAt: 2)
        let tabs = [oldestPinned, newestPinned, middle]
        XCTAssertEqual(InboxNavigator.nextGroupTab(tabs, currentTabId: nil)?.id, "new")
        XCTAssertEqual(InboxNavigator.nextGroupTab(tabs, currentTabId: "new")?.id, "middle")
        XCTAssertEqual(InboxNavigator.nextGroupTab(tabs, currentTabId: "old")?.id, "new")
    }

    func testBenchCycleUsesProjectedConversationsAndLeavesAnEmptyBenchUntouched() {
        let operatorConversation = RemoteOpenConversation(tabId: "talk", title: "Talk", status: "idle", index: 3, tabRole: "bench-conversation")
        let autoFix = RemoteOpenConversation(tabId: "fix", title: "Fix", status: "running", index: 5, tabRole: "conflict-auto-fix")
        let analysis = RemoteOpenConversation(tabId: "analysis", title: "Analysis", status: "idle", index: 7, tabRole: "verification-analysis")

        XCTAssertNil(InboxNavigator.nextBenchConversation([], currentTabId: nil))
        XCTAssertEqual(
            InboxNavigator.nextBenchConversation([analysis, autoFix, operatorConversation], currentTabId: nil)?.tabId,
            "talk"
        )
        XCTAssertEqual(
            InboxNavigator.nextBenchConversation([analysis, autoFix, operatorConversation], currentTabId: "talk")?.tabId,
            "fix"
        )
        XCTAssertEqual(
            InboxNavigator.nextBenchConversation([analysis, autoFix, operatorConversation], currentTabId: "analysis")?.tabId,
            "talk"
        )
    }

    func testInboxSortOrdersByRequestedField() throws {
        let alpha = try tab(id: "a", directory: "/repo", state: "active", settledAt: nil, activity: 100, title: "Alpha")
        let beta = try tab(id: "b", directory: "/repo", state: "active", settledAt: nil, activity: 200, title: "Beta")

        XCTAssertEqual(InboxNavigator.sorted([alpha, beta], by: .recent).map(\.id), ["b", "a"])
        XCTAssertEqual(InboxNavigator.sorted([beta, alpha], by: .title).map(\.id), ["a", "b"])
    }

    /// The desktop's third sort option: "Newest created" over createdAt.
    func testInboxSortByCreatedUsesCreationTimestamp() throws {
        let older = try tab(id: "old", directory: "/repo", state: "active", settledAt: nil, activity: 900, createdAt: 100)
        let newer = try tab(id: "new", directory: "/repo", state: "active", settledAt: nil, activity: 100, createdAt: 200)

        XCTAssertEqual(InboxNavigator.sorted([older, newer], by: .created).map(\.id), ["new", "old"])
    }

    /// Snoozed shelf keeps lifecycle order: soonest wake first, never the
    /// active sort.
    func testSnoozedOrderIsSoonestWakeFirst() throws {
        let late = try tab(id: "late", directory: "/repo", state: "snoozed", settledAt: nil, snoozedUntil: 2_000)
        let soon = try tab(id: "soon", directory: "/repo", state: "snoozed", settledAt: nil, snoozedUntil: 1_000)

        XCTAssertEqual(InboxNavigator.snoozedOrder([late, soon]).map(\.id), ["soon", "late"])
    }

    /// A repo whose bench has no open conversation still earns a project: the
    /// bench is a permanent structural bucket (desktop singleton-bucket rule).
    func testBenchAloneCreatesAProjectEntry() throws {
        let state = try worktreeStateWithBench()
        let projects = InboxNavigator.projects(tabs: [], states: [state.repoPath: state])
        XCTAssertEqual(projects.map(\.id), ["/repo"])
        XCTAssertEqual(projects.first?.conversationCount, 0)
    }

    /// Terminal-only tabs never earn a project or inflate counts (the bench
    /// terminal is reachable through bench.benchTerminalTabId instead).
    func testTerminalOnlyTabsAreExcluded() throws {
        let terminal = try tab(id: "term", directory: "/elsewhere", state: "active", settledAt: nil, isTerminalOnly: true)
        let projects = InboxNavigator.projects(tabs: [terminal], states: [:])
        XCTAssertTrue(projects.isEmpty)
    }

    /// Explicit identity beats path guessing: a tab whose desktop-stamped
    /// worktree names a repo groups there even when the inventory has not
    /// crawled the worktree yet (no RemoteWorktreeState entry contains it).
    func testExplicitWorktreeIdentityGroupsUnderSourceRepo() throws {
        let state = try worktreeState()
        let tab = try tab(
            id: "fresh", directory: "/somewhere/unrelated", state: "active", settledAt: nil,
            worktree: (path: "/somewhere/unrelated", repo: "/repo")
        )
        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [state.repoPath: state]).first)
        XCTAssertEqual(project.id, "/repo")
        XCTAssertEqual(project.worktreeTabs["/somewhere/unrelated"]?.map(\.id), ["fresh"])
    }

    /// Worktree groups keep conversation-owned paths in encounter order. Empty
    /// inventory rows append afterward, so their display does not reshuffle open
    /// conversations.
    func testWorktreeOrderFollowsTabEncounterOrder() throws {
        let state = try worktreeStateWithTwoWorktrees()
        let newerInB = try tab(id: "b1", directory: "/repo/.ion/worktrees/b", state: "active", settledAt: nil, activity: 200)
        let olderInA = try tab(id: "a1", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil, activity: 100)
        // Pre-sorted by activity (desktop sorts before grouping): b first.
        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [newerInB, olderInA], states: [state.repoPath: state]).first)
        XCTAssertEqual(project.worktreeOrder, ["/repo/.ion/worktrees/b", "/repo/.ion/worktrees/a"])
    }

    /// findActiveAutoFix parity: exact directory match on the
    /// conflict-auto-fix role — the flashing indicator and reactivation block
    /// key off this identity.
    func testActiveAutoFixMatchesRoleAndExactDirectory() throws {
        let resolver = try tab(id: "fix", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil, tabRole: "conflict-auto-fix")
        let ordinary = try tab(id: "conv", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil)
        let nested = try tab(id: "nested", directory: "/repo/.ion/worktrees/a/sub", state: "active", settledAt: nil, tabRole: "conflict-auto-fix")

        XCTAssertEqual(InboxNavigator.activeAutoFixTab([ordinary, resolver], directory: "/repo/.ion/worktrees/a")?.id, "fix")
        // Exact match only — a resolver in a subdirectory is a different flow.
        XCTAssertNil(InboxNavigator.activeAutoFixTab([nested], directory: "/repo/.ion/worktrees/a"))
        XCTAssertNil(InboxNavigator.activeAutoFixTab([ordinary], directory: "/repo/.ion/worktrees/a"))
    }

    /// A project with a state record but NO worktrees and NO bench is a plain
    /// project. Its conversations must file flat (directTabs), not into the
    /// Source Repository band. Every project with a live conversation gets a
    /// state record, so keying the band on "a record exists" filed every plain
    /// project's conversations under a band the view never rendered — the
    /// chevron toggled and nothing appeared.
    func testPlainProjectWithAStateRecordFilesConversationsFlat() throws {
        let empty = try emptyWorktreeState(repoPath: "/plain")
        let tab = try tab(id: "conversation", directory: "/plain", state: "active", settledAt: nil)

        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [empty.repoPath: empty]).first)

        XCTAssertEqual(project.directTabs.map(\.id), ["conversation"])
        XCTAssertTrue(project.sourceTabs.isEmpty)
        XCTAssertEqual(project.conversationCount, 1)
    }

    /// The same project with worktree inventory DOES have a Source Repository
    /// band, so a conversation in the source checkout files there.
    func testManagedProjectFilesSourceCheckoutConversationsInTheSourceBand() throws {
        let state = try worktreeState()
        let tab = try tab(id: "conversation", directory: "/repo", state: "active", settledAt: nil)

        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [state.repoPath: state]).first)

        XCTAssertEqual(project.sourceTabs.map(\.id), ["conversation"])
        XCTAssertTrue(project.directTabs.isEmpty)
    }

    /// The inventory crawl can lag a freshly created worktree, and a project's
    /// state record can arrive after its conversations do. The worktree band
    /// must still yield a record for every path that holds a conversation,
    /// otherwise the header and its rows both disappear.
    func testWorktreeBandSynthesisesARecordWhenInventoryHasNotReportedIt() throws {
        let tab = try tab(
            id: "fresh", directory: "/repo/.ion/worktrees/new", state: "active", settledAt: nil,
            worktree: (path: "/repo/.ion/worktrees/new", repo: "/repo")
        )
        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [:]).first)

        let rendered = InboxNavigator.orderedWorktrees(for: project)

        XCTAssertEqual(rendered.map(\.worktreePath), ["/repo/.ion/worktrees/new"])
        XCTAssertEqual(rendered.first?.branchName, "wt/x")
        XCTAssertEqual(rendered.first?.label, "new")
        XCTAssertEqual(project.worktreeTabs["/repo/.ion/worktrees/new"]?.map(\.id), ["fresh"])
    }

    /// The inventory record wins whenever it exists — synthesis is a fallback,
    /// never a replacement for authoritative desktop state.
    func testWorktreeBandPrefersTheInventoryRecord() throws {
        let state = try worktreeState()
        let tab = try tab(id: "conversation", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil)
        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [state.repoPath: state]).first)

        let rendered = InboxNavigator.orderedWorktrees(for: project)

        XCTAssertEqual(rendered.map(\.branchName), ["wt/a"])
        XCTAssertEqual(rendered.first?.head, "abc")
    }

    func testInboxRowUsesTextInsteadOfAnUnreadDot() throws {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/InboxRowView.swift")
        let source = try String(contentsOf: path)
        XCTAssertFalse(source.contains("Circle()"))
        XCTAssertTrue(source.contains(".weight(unread ? .semibold : .regular)"))
    }

    func testManagedProjectRendersSourceAfterWorktrees() throws {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/TabListView+Inbox.swift")
        let source = try String(contentsOf: path)
        let bench = try XCTUnwrap(source.range(of: "InboxBenchGroup"))
        let worktrees = try XCTUnwrap(source.range(of: "ForEach(InboxNavigator.orderedWorktrees"))
        let sourceGroup = try XCTUnwrap(source.range(of: "let sourceKey"))
        let direct = try XCTUnwrap(source.range(of: "ForEach(project.directTabs)"))
        XCTAssertLessThan(bench.lowerBound, worktrees.lowerBound)
        XCTAssertLessThan(worktrees.lowerBound, sourceGroup.lowerBound)
        XCTAssertLessThan(sourceGroup.lowerBound, direct.lowerBound)
    }

    /// Every band renders over its own collection rather than the view choosing
    /// one branch. A project with a state record but no worktrees used to take
    /// the band branch, which had nothing to render, so its conversations
    /// vanished while the chevron still toggled.
    func testExpandedProjectRendersEveryBandUnconditionally() throws {
        let source = try self.source("IonRemote/Views/TabListView+Inbox.swift")
        XCTAssertFalse(source.contains("project.hasWorktrees || !state.benches.isEmpty"),
                       "the expanded project must not choose between bands and direct rows")
        XCTAssertTrue(source.contains("ForEach(project.directTabs)"),
                      "direct rows must render for every expanded project")
    }

    /// Header taps cycle conversations ONLY in the side-by-side layout. On
    /// iPhone the list pushes the conversation, so a cycling header navigates
    /// away and the operator must back out to tap again — the cycle is
    /// invisible and the trip is jarring. There the header expands/collapses.
    func testHeaderTapCyclesOnlyInSideBySideLayout() {
        XCTAssertTrue(InboxNavigator.headerTapCycles(.selection),
                      "iPad selection layout shows list and conversation together, so cycling reads as cycling")
        XCTAssertFalse(InboxNavigator.headerTapCycles(.navigation),
                       "iPhone pushes the conversation; a header tap must only expand or collapse")
    }

    /// The iPhone header must not lose access to conversations: the explicit
    /// open verbs stay in the worktree context menu and the bench overflow.
    func testExplicitOpenVerbsSurviveWithoutHeaderCycling() throws {
        let worktreeRow = try source("IonRemote/Views/WorktreeRowView.swift")
        XCTAssertTrue(worktreeRow.contains("Open conversation"))
        XCTAssertTrue(worktreeRow.contains("New conversation here"))

        let bench = try source("IonRemote/Views/InboxBenchGroup.swift")
        XCTAssertTrue(bench.contains("Open Bench Conversation"))
    }

    /// Both group hosts must honour the layout gate rather than hardcoding a
    /// cycle on tap.
    func testGroupHostsGateHeaderTapOnLayout() throws {
        let worktreeGroup = try source("IonRemote/Views/InboxWorktreeGroup.swift")
        XCTAssertTrue(worktreeGroup.contains("guard cyclesOnHeaderTap else"),
                      "worktree header must fall through to expand/collapse when cycling is off")

        let bench = try source("IonRemote/Views/InboxBenchGroup.swift")
        XCTAssertTrue(bench.contains("if cyclesOnHeaderTap {"),
                      "bench title must branch on the layout gate")

        let inbox = try source("IonRemote/Views/TabListView+Inbox.swift")
        XCTAssertTrue(inbox.contains("InboxNavigator.headerTapCycles(selectionStyle)"),
                      "the inbox must resolve the gate from the active selection style")
        XCTAssertTrue(inbox.contains("cyclesOnHeaderTap: cyclesOnTap"),
                      "both group hosts must receive the resolved gate")
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
        directory: String,
        state: String,
        settledAt: Double?,
        activity: Double? = nil,
        pinnedAt: Double? = nil,
        pinOrderKey: String? = nil,
        title: String = "Test",
        createdAt: Double? = nil,
        snoozedUntil: Double? = nil,
        isTerminalOnly: Bool? = nil,
        tabRole: String? = nil,
        worktree: (path: String, repo: String)? = nil
    ) throws -> RemoteTabState {
        let settled = settledAt.map { ", \"settledAt\": \($0)" } ?? ""
        let activityField = activity.map { ", \"lastActivityAt\": \($0)" } ?? ""
        let pinnedField = pinnedAt.map { ", \"pinnedAt\": \($0)" } ?? ""
        let orderField = pinOrderKey.map { ", \"pinOrderKey\": \"\($0)\"" } ?? ""
        let createdField = createdAt.map { ", \"createdAt\": \($0)" } ?? ""
        let snoozedField = snoozedUntil.map { ", \"snoozedUntil\": \($0)" } ?? ""
        let terminalField = isTerminalOnly.map { ", \"isTerminalOnly\": \($0)" } ?? ""
        let roleField = tabRole.map { ", \"tabRole\": \"\($0)\"" } ?? ""
        let worktreeField = worktree.map {
            ", \"worktree\": {\"worktreePath\": \"\($0.path)\", \"branchName\": \"wt/x\", \"sourceBranch\": \"main\", \"repoPath\": \"\($0.repo)\"}"
        } ?? ""
        let json = """
        {"id":"\(id)","title":"\(title)","status":"idle","workingDirectory":"\(directory)",
        "permissionMode":"auto","permissionQueue":[],"inboxState":"\(state)"\(settled)\(activityField)\(pinnedField)\(orderField)\(createdField)\(snoozedField)\(terminalField)\(roleField)\(worktreeField)}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteTabState.self, from: json)
    }

    private func worktreeState() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/repo","worktrees":[{"worktreePath":"/repo/.ion/worktrees/a",
        "branchName":"wt/a","label":"a","head":"abc","lastCommitSubject":"",
        "isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true}],"benches":[]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }

    /// A project the desktop has crawled and found no worktrees or benches in.
    /// Every project with a live conversation receives one of these.
    private func emptyWorktreeState(repoPath: String) throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"\(repoPath)","worktrees":[],"benches":[]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }

    private func worktreeStateWithTwoWorktrees() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/repo","worktrees":[
        {"worktreePath":"/repo/.ion/worktrees/a","branchName":"wt/a","label":"a","head":"abc",
         "lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true},
        {"worktreePath":"/repo/.ion/worktrees/b","branchName":"wt/b","label":"b","head":"def",
         "lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true}
        ],"benches":[]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }

    // MARK: - Bucket policy (Snoozed shelf)

    /// The Snoozed shelf is a lifecycle list, not the repo's home. A bench with
    /// nothing snoozed must produce NO project at all — the shelf used to draw
    /// an "ion" heading with its Integration Bench under it while nothing was
    /// snoozed, because the bench is a permanent structural bucket in the
    /// ACTIVE tree and both trees shared that rule.
    func testConversationsOnlyBucketsDropAnEmptyBenchProject() throws {
        let state = try worktreeStateWithBench()
        let projects = InboxNavigator.projects(
            tabs: [], states: [state.repoPath: state], buckets: .conversationsOnly
        )
        XCTAssertTrue(projects.isEmpty)
    }

    /// The Active tree keeps the bench bucket: that is the desktop's
    /// singleton-bucket rule and the default.
    func testStructuralBucketsKeepTheEmptyBenchProject() throws {
        let state = try worktreeStateWithBench()
        XCTAssertEqual(InboxNavigator.projects(tabs: [], states: [state.repoPath: state]).map(\.id), ["/repo"])
    }

    /// A real snoozed conversation still earns its project under either policy.
    func testConversationsOnlyKeepsProjectsThatHoldConversations() throws {
        let state = try worktreeStateWithBench()
        let snoozed = try tab(id: "parked", directory: "/repo", state: "snoozed", settledAt: nil)
        let projects = InboxNavigator.projects(
            tabs: [snoozed], states: [state.repoPath: state], buckets: .conversationsOnly
        )
        XCTAssertEqual(projects.map(\.id), ["/repo"])
        XCTAssertEqual(projects.first?.conversationCount, 1)
    }

    // MARK: - Collapse / expand all

    /// The control must name every group the tree RENDERS: the project, its
    /// bench, every active worktree including empty inventory rows, and the
    /// source band. A key it cannot name is a group it cannot open.
    func testExpansionKeysCoverEveryRenderedGroup() throws {
        let state = try worktreeStateWithBenchAndWorktree()
        let worktreeTab = try tab(id: "wt", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil)
        let projects = InboxNavigator.projects(tabs: [worktreeTab], states: [state.repoPath: state])

        XCTAssertEqual(Set(InboxNavigator.expansionKeys(for: projects)), [
            "project:/repo",
            "source:/repo",
            "bench:/bench/main",
            "worktree:/repo/.ion/worktrees/a"
        ])
    }

    /// The lifecycle headings are not collapsible on either client, so the
    /// control must never claim a key for them.
    func testExpansionKeysExcludeTheLifecycleHeadings() throws {
        let state = try worktreeState()
        let conversation = try tab(id: "c", directory: "/repo", state: "active", settledAt: nil)
        let keys = InboxNavigator.expansionKeys(
            for: InboxNavigator.projects(tabs: [conversation], states: [state.repoPath: state])
        )
        XCTAssertFalse(keys.contains { $0.lowercased().contains("active") || $0.lowercased().contains("snoozed") })
    }

    /// A worktree the inventory has not reported yet still renders a group, so
    /// expand-all must reach it. Keying on state.worktrees left it shut.
    func testExpansionKeysReachAnUnreportedWorktree() throws {
        let fresh = try tab(
            id: "fresh", directory: "/repo/.ion/worktrees/new", state: "active", settledAt: nil,
            worktree: (path: "/repo/.ion/worktrees/new", repo: "/repo")
        )
        let keys = InboxNavigator.expansionKeys(for: InboxNavigator.projects(tabs: [fresh], states: [:]))
        XCTAssertTrue(keys.contains("worktree:/repo/.ion/worktrees/new"))
    }

    /// The button drives BOTH trees and the settled shelf from one decision.
    func testToggleAllCoversBothTreesAndTheSettledShelf() throws {
        let source = try self.source("IonRemote/Views/TabListView+Inbox.swift")
        XCTAssertTrue(source.contains("snoozedInboxExpansion = hasCollapsed"),
                      "the control must drive the snoozed tree, not only the active one")
        XCTAssertTrue(source.contains("settledShelfCollapsed = !hasCollapsed"),
                      "the control must drive the settled shelf, as the desktop's expandAll does")
        XCTAssertTrue(source.contains("buckets: .conversationsOnly"),
                      "the snoozed key set must use conversations-only buckets")
    }

    /// The whole project row is one target. Splitting the name and the chevron
    /// into separate buttons left the icon and the gap between them dead, which
    /// is most of the row's width.
    func testProjectHeaderIsOneFullWidthTarget() throws {
        let source = try self.source("IonRemote/Views/TabListView+Inbox.swift")
        XCTAssertTrue(source.contains(".contentShape(Rectangle())"),
                      "the header's empty gap must be hit-testable, not just its glyphs")
        XCTAssertFalse(source.contains("Text(project.name).font(.subheadline.weight(.semibold))\n            } label:"),
                       "the project name must not be its own separate button")
    }

    private func worktreeStateWithBenchAndWorktree() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/repo","worktrees":[{"worktreePath":"/repo/.ion/worktrees/a","branchName":"wt/a",
        "label":"a","head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
        "needsSync":false,"safeToDiscard":true}],
        "benches":[{"repoPath":"/repo","sourceBranch":"main","benchPath":"/bench/main",
        "benchBranch":"bench/main","baseSha":"abc","lastBuiltAt":0,"baseDrifted":false}]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }

    private func worktreeStateWithBench() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/repo","worktrees":[],"benches":[{"repoPath":"/repo","sourceBranch":"main",
        "benchPath":"/bench/main","benchBranch":"bench/main","baseSha":"abc","lastBuiltAt":0,
        "baseDrifted":false}]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }
}
