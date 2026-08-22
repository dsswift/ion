import Foundation

/// Pure Inbox filing model. The desktop supplies both tabs and worktree state;
/// this type only joins those authoritative records for the iOS hierarchy.
///
/// Parity contract (desktop: studio/inbox/inbox-navigator.ts):
///   - A tab's project is its worktree's SOURCE repository when the desktop
///     stamped `tab.worktree` (explicit identity, never path guessing), else
///     the owning repo resolved through the worktree/bench path tables, else
///     the working directory itself.
///   - Band order inside a project is FIXED: Bench, then worktrees, then
///     Source Repository — never encounter order.
///   - Worktree groups include every non-landed inventory worktree in the Active
///     tree, even with zero conversations. The worktree row owns its empty-state
///     action, so the same workspace remains discoverable on both clients.
///   - Projects sort alphabetically by name (desktop inbox-navigator.ts:197).
///   - Terminal-only tabs never earn a group; the bench terminal is rendered
///     from `bench.benchTerminalTabId`, not from the tab list.
///   - A bench is a permanent structural bucket: it is visible whenever an
///     IntegrationWorkspace exists, even with zero open conversations.
struct InboxNavigator {
    struct Project: Identifiable {
        let id: String
        let name: String
        let state: RemoteWorktreeState?
        let directTabs: [RemoteTabState]
        let benchTabs: [RemoteTabState]
        let sourceTabs: [RemoteTabState]
        let worktreeTabs: [String: [RemoteTabState]]
        /// Worktree paths in rendered order. Conversation-owned paths preserve
        /// encounter order; inventory-only non-landed paths follow so every
        /// active worktree remains discoverable even when it has no tab.
        let worktreeOrder: [String]

        var allTabs: [RemoteTabState] {
            InboxNavigator.sorted(directTabs + benchTabs + sourceTabs + worktreeTabs.values.flatMap { $0 })
        }
        /// The project header's conversation count (desktop: flatTabs + group tabs).
        var conversationCount: Int {
            directTabs.count + benchTabs.count + sourceTabs.count + worktreeTabs.values.reduce(0) { $0 + $1.count }
        }
    }

    /// Which structural buckets a tree keeps when they hold no conversation.
    ///
    /// The Active tree is the repo's home, so a bench there is a permanent
    /// bucket that stays visible with zero conversations (desktop
    /// inbox-navigator.ts:80-90). The Snoozed shelf is a lifecycle list: the
    /// desktop renders it only while snoozed conversations exist, so an empty
    /// snoozed set must produce NO projects at all. Passing `.structural` for
    /// the shelf drew an "ion" project and its Integration Bench under a
    /// Snoozed heading with nothing snoozed.
    enum BucketPolicy {
        /// Keep a repo's bench even with no conversation. The Active tree.
        case structural
        /// Only conversations create entries. Snoozed and any other
        /// lifecycle-scoped list.
        case conversationsOnly
    }

    static func projects(
        tabs: [RemoteTabState],
        states: [String: RemoteWorktreeState],
        buckets: BucketPolicy = .structural
    ) -> [Project] {
        var tabsByProject: [String: [RemoteTabState]] = [:]
        for tab in tabs {
            // Terminal-only tabs never earn a project entry (desktop
            // inbox-navigator.ts:100). The bench terminal is reachable through
            // bench.benchTerminalTabId instead.
            if tab.isTerminalOnly == true { continue }
            // WorktreeProjectIdentity prefers the desktop-stamped identity,
            // then uses authoritative containment. Its owner table tolerates a
            // legacy snapshot that repeats a worktree under checkout aliases.
            let project = WorktreeProjectIdentity.projectPath(for: tab, states: states)
            tabsByProject[project, default: []].append(tab)
        }
        // The Active tree is also a worktree navigator. A non-landed inventory
        // row needs no conversation to earn its project, matching desktop's
        // inventory-backed Inbox groups. Snoozed uses conversationsOnly below.
        if buckets == .structural {
            for state in states.values {
                for worktree in state.worktrees where !worktree.isLanded {
                    // Older snapshots can repeat one inventory record under an
                    // alias checkout. Resolve the worktree path back through
                    // the same canonical-owner table tabs use, so inventory
                    // presence never creates a duplicate project.
                    let project = WorktreeProjectIdentity.projectPath(forDirectory: worktree.worktreePath, states: states)
                        ?? state.repoPath
                    if tabsByProject[project] == nil {
                        tabsByProject[project] = []
                    }
                }
            }
        }
        // A repo whose bench has no open conversation still gets a project
        // entry: the bench is a permanent structural bucket (desktop
        // inbox-navigator.ts:110-116).
        if buckets == .structural {
            for state in states.values where !state.benches.isEmpty {
                if tabsByProject[state.repoPath] == nil {
                    tabsByProject[state.repoPath] = []
                }
            }
        }

        return tabsByProject.map { repoPath, projectTabs in
            let state = states[repoPath]
            var directTabs: [RemoteTabState] = []
            var benchTabs: [RemoteTabState] = []
            var sourceTabs: [RemoteTabState] = []
            var worktreeTabs: [String: [RemoteTabState]] = [:]
            var worktreeOrder: [String] = []
            let benchPaths = Set(state?.benches.map(\.benchPath) ?? [])
            let worktreePaths = Set(state?.worktrees.map(\.worktreePath) ?? [])
            // Desktop parity (inbox-navigator.ts:187): a conversation earns the
            // Source Repository band only when the project HAS worktree
            // inventory or a bench. A plain project files its conversations
            // flat, exactly as the desktop's flatTabs does.
            //
            // This used to key on "a state record exists" instead. Every
            // project with a live conversation gets a record — refreshAllWorktrees
            // asks for one per project and the desktop always answers, with
            // empty arrays for a repo that has no worktrees — so a plain project
            // filed all of its conversations under a band that never rendered.
            let isManaged = !(state?.worktrees.isEmpty ?? true) || !(state?.benches.isEmpty ?? true)
            func containedPath(for path: String, paths: Set<String>) -> String? {
                paths.filter { path == $0 || path.hasPrefix($0 + "/") }.max { $0.count < $1.count }
            }

            for tab in projectTabs {
                // Bench containment outranks the stamped worktree identity,
                // matching the desktop's assignment priority: a conversation
                // whose cwd is inside a bench belongs to the bench.
                if let benchPath = containedPath(for: tab.workingDirectory, paths: benchPaths) {
                    _ = benchPath
                    benchTabs.append(tab)
                } else if let worktreePath = tab.worktree?.worktreePath
                    ?? containedPath(for: tab.workingDirectory, paths: worktreePaths) {
                    if worktreeTabs[worktreePath] == nil { worktreeOrder.append(worktreePath) }
                    worktreeTabs[worktreePath, default: []].append(tab)
                } else if isManaged {
                    sourceTabs.append(tab)
                } else {
                    directTabs.append(tab)
                }
            }
            for worktree in state?.worktrees ?? [] where !worktree.isLanded {
                if worktreeTabs[worktree.worktreePath] == nil {
                    worktreeTabs[worktree.worktreePath] = []
                    worktreeOrder.append(worktree.worktreePath)
                }
            }
            return Project(
                id: repoPath,
                name: label(for: repoPath),
                state: state,
                directTabs: sorted(directTabs),
                benchTabs: sorted(benchTabs),
                sourceTabs: sorted(sourceTabs),
                worktreeTabs: worktreeTabs.mapValues(sorted),
                worktreeOrder: worktreeOrder
            )
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func worktreeExpansionKey(_ worktreePath: String) -> String {
        "worktree:\(worktreePath)"
    }

    /// The worktree records for a project's worktree band. Conversation-owned
    /// paths retain their encounter order; inventory-only active worktrees then
    /// follow. Every rendered path resolves to an inventory record or to a
    /// stamped-tab fallback, so empty worktrees and fresh unreported worktrees
    /// both keep a usable header.
    static func orderedWorktrees(for project: Project) -> [RemoteWorktree] {
        project.worktreeOrder.map { path in
            if let entry = project.state?.worktrees.first(where: { $0.worktreePath == path }) {
                return entry
            }
            return fallbackWorktree(path: path, tabs: project.worktreeTabs[path] ?? [])
        }
    }

    /// A placeholder record for a worktree the inventory has not reported yet.
    /// Every appraisal field is the conservative "nothing known" value, so the
    /// row offers no verb that needs an answer iOS does not have.
    private static func fallbackWorktree(path: String, tabs: [RemoteTabState]) -> RemoteWorktree {
        let stamp = tabs.compactMap(\.worktree).first { $0.worktreePath == path } ?? tabs.compactMap(\.worktree).first
        return RemoteWorktree.placeholder(
            worktreePath: path,
            branchName: stamp?.branchName ?? "",
            label: label(for: path),
            sourceBranch: stamp?.sourceBranch,
            landedAt: stamp?.landedAt
        )
    }

    /// Whether tapping a GROUP HEADER (project, worktree, bench) should cycle
    /// through that group's conversations, or just expand/collapse it.
    ///
    /// Only the side-by-side layout cycles. Cycling is useful when the list and
    /// the conversation are visible at once (iPad, and the desktop this mirrors):
    /// the selection changes in place and the list stays put. On iPhone the list
    /// is a single view that PUSHES the conversation, so a header tap navigates
    /// away, and returning for a second tap means backing out first — the cycle
    /// can never be seen as a cycle, only as a jarring round trip. There the
    /// header does the one thing a header should do: open and close its group.
    ///
    /// No capability is lost on iPhone. Every explicit open verb stays reachable:
    /// the worktree row's "Open conversation" / "New conversation here" context
    /// menu items, the bench overflow's "Open Bench Conversation", and the
    /// conversation rows themselves.
    static func headerTapCycles(_ style: TabSelectionStyle) -> Bool {
        switch style {
        case .selection: return true
        case .navigation: return false
        }
    }

    /// The live auto-fix resolver for a directory, or nil. Mirrors the
    /// desktop's findActiveAutoFix (conflict-assist-dedupe.ts): exact
    /// working-directory match on a conflict-auto-fix role tab. Used for the
    /// flashing indicator AND the reactivation block — while this returns a
    /// tab, the conflict indicators focus it instead of launching a second
    /// resolver.
    static func activeAutoFixTab(_ tabs: [RemoteTabState], directory: String) -> RemoteTabState? {
        tabs.first { $0.tabRole == "conflict-auto-fix" && $0.workingDirectory == directory }
    }

    /// Makes the worktree's conversation rows visible before selecting the next
    /// conversation. The returned flag lets the view log only real expansions.
    static func prepareWorktreeCycle(
        _ tabs: [RemoteTabState],
        currentTabId: String?,
        worktreePath: String,
        expansion: inout Set<String>
    ) -> (next: RemoteTabState?, didExpand: Bool) {
        let didExpand = expansion.insert(worktreeExpansionKey(worktreePath)).inserted
        return (nextGroupTab(tabs, currentTabId: currentTabId), didExpand)
    }

    static func projectExpansionKey(_ projectId: String) -> String {
        "project:\(projectId)"
    }

    static func benchExpansionKey(_ benchPath: String) -> String {
        "bench:\(benchPath)"
    }

    static func sourceExpansionKey(_ projectId: String) -> String {
        "source:\(projectId)"
    }

    /// Every expansion key the given trees render, for the collapse/expand-all
    /// control. Derived from the RENDERED bands rather than from inventory: a
    /// worktree the inventory has not reported yet still draws a group, and a
    /// key the control cannot name is a group the control cannot open.
    ///
    /// The lifecycle headings (Active, Snoozed) are deliberately absent. They
    /// are not collapsible; only the projects, benches, worktrees, and source
    /// bands inside them are, which is what the desktop's collapse-all covers.
    static func expansionKeys(for projects: [Project]) -> [String] {
        projects.flatMap { project -> [String] in
            let benchKeys = (project.state?.benches ?? []).map { benchExpansionKey($0.benchPath) }
            let worktreeKeys = project.worktreeOrder.map(worktreeExpansionKey)
            return [projectExpansionKey(project.id), sourceExpansionKey(project.id)] + benchKeys + worktreeKeys
        }
    }

    /// Makes the project's conversation rows visible before selecting the next
    /// conversation — the project-header counterpart to prepareWorktreeCycle.
    /// Without this, tapping a collapsed project's header opened a
    /// conversation that stayed buried: the exact bug expand-before-cycle
    /// already fixed for worktree groups.
    static func prepareProjectCycle(
        _ tabs: [RemoteTabState],
        currentTabId: String?,
        projectId: String,
        expansion: inout Set<String>
    ) -> (next: RemoteTabState?, didExpand: Bool) {
        let didExpand = expansion.insert(projectExpansionKey(projectId)).inserted
        return (nextGroupTab(tabs, currentTabId: currentTabId), didExpand)
    }

    static func collapsedRows(_ tabs: [RemoteTabState], activeTabId: String?) -> [RemoteTabState] {
        tabs.filter { $0.pinnedAt != nil }.sorted {
            let left = $0.pinOrderKey ?? "~\($0.id)"
            let right = $1.pinOrderKey ?? "~\($1.id)"
            return left == right ? $0.id < $1.id : left < right
        }
    }

    static func nextGroupTab(_ tabs: [RemoteTabState], currentTabId: String?) -> RemoteTabState? {
        let ordered = sorted(tabs)
        guard !ordered.isEmpty else { return nil }
        guard let currentTabId,
              let index = ordered.firstIndex(where: { $0.id == currentTabId }) else { return ordered[0] }
        return ordered[(index + 1) % ordered.count]
    }

    /// Bench title navigation is deliberately based on the desktop's bench
    /// conversation projection, not Inbox rows. The latter can include the
    /// singleton terminal, which is a separate navigation target.
    static func nextBenchConversation(
        _ conversations: [RemoteOpenConversation],
        currentTabId: String?
    ) -> RemoteOpenConversation? {
        let ordered = conversations.sorted { $0.index == $1.index ? $0.tabId < $1.tabId : $0.index < $1.index }
        guard !ordered.isEmpty else { return nil }
        guard let currentTabId,
              let index = ordered.firstIndex(where: { $0.tabId == currentTabId }) else { return ordered[0] }
        return ordered[(index + 1) % ordered.count]
    }

    static func settledStack(liveTabs: [RemoteTabState], coldTabs: [RemoteTabState]) -> [RemoteTabState] {
        var byID = Dictionary(uniqueKeysWithValues: coldTabs.map { ($0.id, $0) })
        for tab in liveTabs where tab.inboxState == "settled" {
            byID[tab.id] = tab
        }
        return byID.values.sorted {
            let left = $0.settledAt ?? $0.lastActivityAt ?? 0
            let right = $1.settledAt ?? $1.lastActivityAt ?? 0
            return left == right ? $0.id < $1.id : left > right
        }
    }

    /// The desktop's three active-list sort options (InboxControls.tsx).
    /// Snoozed and settled shelves keep lifecycle ordering regardless.
    enum Sort: String, CaseIterable, Identifiable {
        case created
        case recent
        case title

        var id: String { rawValue }
        var label: String {
            switch self {
            case .created: return "Newest created"
            case .recent: return "Recent activity"
            case .title: return "Title"
            }
        }
    }

    static func sorted(_ tabs: [RemoteTabState], by sort: Sort = .recent) -> [RemoteTabState] {
        tabs.sorted {
            switch sort {
            case .created:
                let left = $0.createdAt ?? 0
                let right = $1.createdAt ?? 0
                return left == right ? $0.id < $1.id : left > right
            case .recent:
                let left = $0.lastActivityAt ?? 0
                let right = $1.lastActivityAt ?? 0
                return left == right ? $0.id < $1.id : left > right
            case .title:
                let comparison = $0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle)
                return comparison == .orderedSame ? $0.id < $1.id : comparison == .orderedAscending
            }
        }
    }

    static func sorted(_ tabs: [RemoteTabState]) -> [RemoteTabState] {
        sorted(tabs, by: .recent)
    }

    /// Snoozed shelf: lifecycle order (soonest wake first), never the active
    /// sort. Mirrors useInboxPartition (snoozedUntil asc).
    static func snoozedOrder(_ tabs: [RemoteTabState]) -> [RemoteTabState] {
        tabs.sorted {
            let left = $0.snoozedUntil ?? 0
            let right = $1.snoozedUntil ?? 0
            return left == right ? $0.id < $1.id : left < right
        }
    }

    private static func label(for path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}
