import SwiftUI

// MARK: - Inbox navigator
//
// The desktop classifies lifecycle and projects worktree inventory. iOS joins
// those authoritative records into Active and Snoozed filing trees. Settled is
// intentionally a separate reverse-time stack with no group state.
//
// Parity contract (desktop: studio/inbox/InboxSidebar.tsx + InboxNavigatorGroups):
//   - Projects always sort alphabetically; the sort control orders the
//     CONVERSATIONS inside groups (created / activity / title).
//   - The snoozed shelf keeps lifecycle order (soonest wake first) regardless
//     of the active sort.
//   - Band order inside a project: Bench, then worktrees (tab-encounter
//     order), then Source Repository.
//   - The bench group renders whenever a bench exists, conversations or not.
//   - Every conversation row — top-level, under a worktree, under a bench —
//     carries the identical action set (one `inboxRow` builder).
extension TabListView {

    @ViewBuilder
    func inboxSections(selectionStyle: TabSelectionStyle) -> some View {
        let activeTabs = sortedInboxTabs(filteredTabsForInbox.filter { $0.inboxState != "snoozed" && $0.inboxState != "settled" })
        // Lifecycle order for the snoozed shelf: soonest wake first, never the
        // active sort (desktop InboxControls.tsx: "snoozed and settled shelves
        // keep lifecycle ordering regardless").
        let snoozedTabs = InboxNavigator.snoozedOrder(filteredTabsForInbox.filter { $0.inboxState == "snoozed" })
        let activeProjects = filteredInboxProjects(InboxNavigator.projects(tabs: activeTabs, states: viewModel.worktreeStates))
        // Conversations-only: the Snoozed shelf is a lifecycle list, not the
        // repo's home, so a bench with nothing snoozed must not conjure a
        // project heading under it (the desktop renders this shelf only while
        // snoozed conversations exist).
        let snoozedProjects = filteredInboxProjects(InboxNavigator.projects(
            tabs: snoozedTabs,
            states: viewModel.worktreeStates,
            buckets: .conversationsOnly
        ))
        let settled = InboxNavigator.settledStack(liveTabs: filteredTabsForInbox, coldTabs: viewModel.settledTabs)
            .filter(isInSelectedInboxProject)

        inboxLifecycleTree(
            title: "Active",
            projects: activeProjects,
            expansion: $activeInboxExpansion,
            selectionStyle: selectionStyle
        )
        if !snoozedProjects.isEmpty {
            inboxLifecycleTree(
                title: "Snoozed",
                projects: snoozedProjects,
                expansion: $snoozedInboxExpansion,
                selectionStyle: selectionStyle
            )
        }
        if !settled.isEmpty {
            Section {
                if !settledShelfCollapsed {
                    ForEach(settled.prefix(settledShown)) { tab in
                        inboxRow(tab, selectionStyle: selectionStyle, project: projectName(for: tab), location: nil, branch: nil, level: 0, showsProject: true)
                    }
                    if settled.count > settledShown {
                        Button("Show \(min(15, settled.count - settledShown)) more") { settledShown += 15 }
                            .font(IonType.meaning)
                            .foregroundStyle(theme.accent)
                            .inboxRow(level: 0)
                    }
                }
            } header: {
                HStack {
                    inboxShelfHeader(label: "Settled", count: settled.count, collapsed: settledShelfCollapsed) {
                        settledShelfCollapsed.toggle()
                    }
                    Spacer()
                    Button("History") { showSettledHistory = true }
                        .font(IonType.sectionLabel)
                        .buttonStyle(.plain)
                        .foregroundStyle(theme.accent)
                }
            }
        }
    }

    @ViewBuilder
    private func inboxLifecycleTree(
        title: String,
        projects: [InboxNavigator.Project],
        expansion: Binding<Set<String>>,
        selectionStyle: TabSelectionStyle
    ) -> some View {
        Section {
            if projects.isEmpty {
                Text(title == "Active" ? "Inbox zero." : "No snoozed conversations.")
                    .font(IonType.meaning)
                    .foregroundStyle(theme.textTertiary)
                    .inboxRow(level: 0)
            }
            ForEach(projects) { project in
                inboxProject(project, expansion: expansion, selectionStyle: selectionStyle)
            }
        } header: {
            // The Active header carries the list's filter controls. They ride
            // the section header rather than a row of their own, so they cost
            // no height and stay pinned while the list scrolls.
            HStack(spacing: IonSpace.compactGap) {
                Text(title)
                    .font(IonType.sectionLabel)
                    .foregroundStyle(theme.textSecondary)
                Spacer(minLength: IonSpace.compactGap)
                if title == "Active" {
                    inboxHeaderControls
                }
            }
        }
    }

    @ViewBuilder
    private func inboxProject(
        _ project: InboxNavigator.Project,
        expansion: Binding<Set<String>>,
        selectionStyle: TabSelectionStyle
    ) -> some View {
        let projectKey = InboxNavigator.projectExpansionKey(project.id)
        let projectExpanded = expansion.wrappedValue.contains(projectKey)
        let cyclesOnTap = InboxNavigator.headerTapCycles(selectionStyle)
        // A collapsed project can still show rows (pinned, selected, or
        // working ones), and then it is a card with a body, not a lone header.
        let collapsedRows = InboxNavigator.collapsedRows(project.allTabs, activeTabId: currentTabId)
        let hasRowsBeneath = projectExpanded || !collapsedRows.isEmpty
        // ONE button spanning the whole row. The folder icon, the name, the
        // count, the gap, and the chevron are all label content, so every part
        // of the row is the same target — the row is the largest surface
        // available and missing it by a few points used to do nothing at all.
        //
        // `contentShape` makes the gap between the count and the chevron hit,
        // not just the drawn glyphs: without it the Spacer is empty space and a
        // tap there falls through the button.
        Button {
            // Side-by-side layout: cycle the project's conversations in
            // place. Pushed layout: expand/collapse, because a tap that
            // navigates away cannot read as a cycle.
            if cyclesOnTap {
                cycleProject(project, expansion: expansion)
            } else {
                toggle(projectKey, in: expansion)
            }
        } label: {
            // The count is the project's conversation count — the same
            // metadata the desktop header shows beside the folder name.
            InboxDisclosureHeader(
                title: project.name,
                systemImage: "folder",
                count: project.conversationCount,
                isExpanded: projectExpanded,
                emphasis: .primary
            ) {
                InboxProjectRollup(counts: InboxProjectRollup.counts(for: project.allTabs))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(project.name)
        .accessibilityValue(projectExpanded ? "Expanded" : "Collapsed")
        // The header's own tap can cycle conversations in the side-by-side
        // layout, so expand/collapse stays reachable as an explicit action.
        .accessibilityAction(named: projectExpanded ? "Collapse project" : "Expand project") {
            toggle(projectKey, in: expansion)
        }
        .contextMenu {
            Button {
                requestNewConversation(directory: project.id)
            } label: {
                Label("New conversation", systemImage: "plus.bubble")
            }
            if viewModel.developerSurfaces.worktrees {
            Button {
                let effectiveDirectory: String
                if let policy = viewModel.enterpriseNewConversationPolicy,
                   policy.locked,
                   !policy.baseDirectory.isEmpty {
                    effectiveDirectory = policy.baseDirectory
                } else {
                    effectiveDirectory = project.id
                }
                // When the desktop already records a default source branch for
                // this repo, create the worktree conversation directly with it
                // -- exactly as the desktop does -- rather than prompting. The
                // picker is only for a repo with no recorded default.
                if let defaultBranch = viewModel.worktreeState(for: effectiveDirectory)?.defaultSourceBranch,
                   !defaultBranch.isEmpty {
                    DiagnosticLog.log("creating worktree conversation from recorded default", tag: "view.inbox", fields: [
                        "repo_path": effectiveDirectory,
                        "source_branch": defaultBranch
                    ])
                    viewModel.createTab(workingDirectory: effectiveDirectory, useWorktree: true, sourceBranch: defaultBranch)
                } else {
                    viewModel.pendingBranchPickerRepo = effectiveDirectory
                    viewModel.requestGitBranches(directory: effectiveDirectory)
                }
            } label: {
                Label("New worktree conversation", systemImage: "arrow.triangle.branch")
            }
            }
        }
        .inboxRow(level: 0, kind: hasRowsBeneath ? .cardHeader : .cardHeaderAlone)

        if projectExpanded {
            // Every band is rendered unconditionally over its own (possibly
            // empty) collection, so no conversation class can be dropped. The
            // previous shape chose ONE of two branches — bands, or direct rows
            // — and a project that had a state record but no worktrees fell into
            // the band branch with nothing to render, so its conversations
            // disappeared while the chevron still toggled.
            if let state = project.state, !state.benches.isEmpty {
                // The bench is a permanent structural bucket: render it
                // whenever one exists, conversations or not — the desktop's
                // singleton-bucket rule (inbox-navigator.ts:80-90).
                InboxBenchGroup(
                    state: state,
                    tabsByBenchPath: benchTabsByPath(project.benchTabs, state: state),
                    terminalTabsByID: Dictionary(uniqueKeysWithValues: project.benchTerminals.map { ($0.id, $0) }),
                    activeTabId: currentTabId,
                    row: { tab in
                        inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: "Integration Bench", branch: nil, level: 2)
                    }
                )
            }
            // Bench members render together first in merge order. Other
            // conversation-owned worktrees keep encounter order, followed by
            // inventory-only active worktrees.
            ForEach(InboxNavigator.orderedWorktrees(for: project), id: \.worktreePath) { worktree in
                InboxWorktreeGroup(
                    repoPath: project.id,
                    worktree: worktree,
                    tabs: project.worktreeTabs[worktree.worktreePath] ?? [],
                    activeTabId: currentTabId,
                    expanded: expansion,
                    cyclesOnHeaderTap: cyclesOnTap,
                    row: { tab in
                        inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: worktree.displayName, branch: worktree.branchName, level: 2)
                    }
                )
            }
            if !project.sourceTabs.isEmpty {
                let sourceKey = "source:\(project.id)"
                inboxDisclosure(title: "Source Repository", icon: "archivebox", key: sourceKey, expansion: expansion)
                // Collapsed, the group keeps its pinned, selected, and working
                // rows, the same rule every other group follows. It used to
                // hide all of them, so a pinned conversation vanished the
                // moment its group was closed.
                let sourceRows = expansion.wrappedValue.contains(sourceKey)
                    ? project.sourceTabs
                    : InboxNavigator.collapsedRows(project.sourceTabs, activeTabId: currentTabId)
                ForEach(sourceRows) { tab in
                    inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: "Source Repository", branch: nil, level: 2)
                }
            }
            // A plain project — no worktree inventory, no bench — has no band
            // for its conversations, so they render directly under the header
            // (the desktop's flatTabs).
            ForEach(project.directTabs) { tab in
                inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: nil, branch: nil, level: 1)
            }
        } else {
            ForEach(collapsedRows) { tab in
                if tab.isTerminalOnly == true {
                    InboxBenchTerminalRow(tab: tab)
                        .inboxRow(level: 1)
                } else {
                    inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: nil, branch: nil, level: 1)
                }
            }
        }
        // The card's bottom edge, and the gap before the next project.
        Color.clear
            .inboxRow(level: 0, kind: hasRowsBeneath ? .cardFooter : .cardGap)
            .accessibilityHidden(true)
    }

    /// Projects always sort alphabetically (the navigator already returns them
    /// that way) — the desktop never reorders projects by the sort mode; the
    /// sort mode orders conversations. This only applies the scope filter.
    private func filteredInboxProjects(_ projects: [InboxNavigator.Project]) -> [InboxNavigator.Project] {
        inboxProjectFilter == "all" ? projects : projects.filter { $0.id == inboxProjectFilter }
    }

    private func sortedInboxTabs(_ tabs: [RemoteTabState]) -> [RemoteTabState] {
        InboxNavigator.sorted(tabs, by: inboxSort, workingLast: inboxWorkingLast)
    }

    private func isInSelectedInboxProject(_ tab: RemoteTabState) -> Bool {
        guard inboxProjectFilter != "all" else { return true }
        return InboxNavigator.projects(tabs: [tab], states: viewModel.worktreeStates)
            .contains { $0.id == inboxProjectFilter }
    }

    private var currentTabId: String? {
        selectedTabId ?? navigationPath.last
    }

    private func cycle(_ tabs: [RemoteTabState]) {
        guard let next = InboxNavigator.nextGroupTab(tabs, currentTabId: currentTabId) else { return }
        viewModel.navigateToTab(next.id)
    }

    /// Makes the project's conversation rows visible before selecting the next
    /// conversation — the project-header counterpart to
    /// InboxNavigator.prepareWorktreeCycle. Without this, tapping a collapsed
    /// project's header opened a conversation that stayed buried, exactly the
    /// bug that expand-before-cycle already fixed for worktree groups.
    private func cycleProject(_ project: InboxNavigator.Project, expansion: Binding<Set<String>>) {
        let cycle = InboxNavigator.prepareProjectCycle(
            project.allTabs,
            currentTabId: currentTabId,
            projectId: project.id,
            expansion: &expansion.wrappedValue
        )
        if cycle.didExpand {
            DiagnosticLog.log("expanded project before cycling conversations", tag: "view.inbox", fields: [
                "project_id": project.id,
                "conversation_count": String(project.allTabs.count)
            ])
        }
        if let next = cycle.next {
            viewModel.navigateToTab(next.id)
        }
    }


    private func benchTabsByPath(_ tabs: [RemoteTabState], state: RemoteWorktreeState) -> [String: [RemoteTabState]] {
        Dictionary(grouping: tabs) { tab in
            state.benches.first(where: { $0.benchPath == tab.workingDirectory })?.benchPath ?? tab.workingDirectory
        }
    }

    @ViewBuilder
    private func inboxDisclosure(title: String, icon: String, key: String, expansion: Binding<Set<String>>) -> some View {
        Button { toggle(key, in: expansion) } label: {
            InboxDisclosureHeader(title: title, systemImage: icon, isExpanded: expansion.wrappedValue.contains(key))
        }
        .buttonStyle(.plain)
        .inboxRow(level: 1, kind: .groupHeader)
    }

    private func toggle(_ key: String, in expansion: Binding<Set<String>>) {
        if expansion.wrappedValue.contains(key) {
            expansion.wrappedValue.remove(key)
        } else {
            expansion.wrappedValue.insert(key)
        }
    }

    var filteredTabsForInbox: [RemoteTabState] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return viewModel.tabs }
        return viewModel.tabs.filter {
            $0.displayTitle.lowercased().contains(query)
                || $0.workingDirectory.lowercased().contains(query)
                || InboxNavigator.projects(tabs: [$0], states: viewModel.worktreeStates)
                    .contains { $0.name.lowercased().contains(query) }
        }
    }

    @ViewBuilder
    func inboxRow(
        _ tab: RemoteTabState,
        selectionStyle: TabSelectionStyle,
        project: String,
        location: String?,
        branch: String?,
        level: Int,
        showsProject: Bool = false
    ) -> some View {
        // A branch name is repository status, which the server may not offer.
        let branch = viewModel.developerSurfaces.repositoryStatus ? branch : nil
        let row = InboxRowView(tab: tab, showsProject: showsProject)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if tab.inboxState == "settled" {
                    if tab.canRestoreSettled != false {
                        Button("Un-settle") { viewModel.unsettleTab(tabId: tab.id) }.tint(theme.accent)
                    }
                } else {
                    // The verb names its consequence: settling an ephemeral
                    // role ends the conversation rather than shelving it, and
                    // Un-settle is absent afterwards.
                    Button(viewModel.settlingIsPermanent(tab) ? "Settle for good" : "Settle") {
                        viewModel.settleTab(tabId: tab.id)
                    }.tint(theme.statusIdle)
                }
                Button("Unread") { viewModel.markTabUnread(tabId: tab.id) }.tint(theme.statusDone)
            }
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if tab.inboxState == "settled" && tab.canRestoreSettled != false {
                    Button("Open review") { viewModel.reviewSettledTab(tabId: tab.id) }
                }
                if tab.inboxState == "snoozed" {
                    Button("Wake") { viewModel.unsnoozeTab(tabId: tab.id) }.tint(theme.statusWarning)
                } else if !viewModel.isBenchConversation(tab) {
                    // Absent, not disabled, for a bench conversation: the next
                    // assembly deletes it, so there is no later to park it for.
                    Button("Snooze") { snoozeSheetTabId = tab.id }.tint(theme.statusWarning)
                }
            }
            .contextMenu {
                InboxConversationPreview(tab: tab, projectName: project, location: location, branch: branch)
                Divider()
                // A usage limit holds the conversation, or the server holds a
                // prompt for it: the server acts on these with the app closed.
                if InboxRowView.limitedUntil(tab) != nil, tab.deferredRelease == nil {
                    Button("Resume at reset") { viewModel.resumeAtLimitReset(tabId: tab.id) }
                }
                if InboxRowView.limitedUntil(tab) != nil, tab.inboxState != "snoozed", !viewModel.isBenchConversation(tab) {
                    Button("Snooze until reset") { viewModel.snoozeUntilLimitReset(tabId: tab.id) }
                }
                if tab.deferredRelease != nil {
                    Button("Send queued prompt now") { viewModel.sendHeldPromptNow(tabId: tab.id) }
                    Button("Cancel queued prompt", role: .destructive) { viewModel.cancelHeldPrompt(tabId: tab.id) }
                }
                if tab.inboxState == "snoozed" {
                    Button("Un-snooze") { viewModel.unsnoozeTab(tabId: tab.id) }
                } else if !viewModel.isBenchConversation(tab) {
                    Menu("Snooze") {
                        ForEach(InboxSnoozePresets.available(), id: \.label) { preset in
                            Button(preset.label) { viewModel.snoozeTab(tabId: tab.id, untilMs: preset.untilMs) }
                        }
                    }
                }
                Button("Mark unread") { viewModel.markTabUnread(tabId: tab.id) }
                if !viewModel.isBenchConversation(tab) || tab.pinnedAt != nil {
                    Button(tab.pinnedAt == nil ? "Pin" : "Unpin") {
                        if tab.pinnedAt == nil { viewModel.pinTab(tabId: tab.id) } else { viewModel.unpinTab(tabId: tab.id) }
                    }
                }
                if tab.inboxState == "settled" {
                    if tab.canRestoreSettled != false {
                        Button("Un-settle") { viewModel.unsettleTab(tabId: tab.id) }
                    }
                } else {
                    Button(viewModel.settlingIsPermanent(tab) ? "Settle permanently" : "Settle") {
                        viewModel.settleTab(tabId: tab.id)
                    }
                }
                Button("Rename") {
                    inboxRenameTitle = tab.displayTitle
                    inboxRenameTabId = tab.id
                }
                Button("Regenerate title") { viewModel.regenerateTabTitle(tabId: tab.id) }
                // Same gate TabRowContextMenu uses for the classic tab list:
                // absent once the tab already has an explicit worktree
                // identity, present only when the desktop has projected
                // worktree state for this directory (i.e. it is a known git
                // repo). One mechanism, two menus.
                if tab.worktree == nil && viewModel.worktreeStates[tab.workingDirectory] != nil {
                    Button("Move conversation into a worktree") {
                        viewModel.convertConversationToWorktree(tabId: tab.id)
                    }
                }
                ConversationClipboardActions(tab: tab)
                Button("Copy working path") { UIPasteboard.general.string = tab.workingDirectory }
                if let branch = branch { Button("Copy worktree branch") { UIPasteboard.general.string = branch } }
                Button(role: .destructive) {
                    DiagnosticLog.log("conversation delete confirmation opened", tag: "inbox", level: .info, fields: ["tab_id": tab.id])
                    pendingInboxDeleteTab = tab
                } label: {
                    Label("Delete conversation…", systemImage: "trash")
                }
            }
        Group {
            if tab.inboxState == "settled" && !viewModel.tabs.contains(where: { $0.id == tab.id }) {
                if tab.canRestoreSettled != false {
                    Button { viewModel.reviewSettledTab(tabId: tab.id) } label: { row }
                        .buttonStyle(.plain)
                } else {
                    row
                }
            } else {
                switch selectionStyle {
                // The link sits behind the row rather than wrapping it: a
                // wrapping NavigationLink draws its own disclosure chevron on
                // the trailing edge, beside the status pill, on every row.
                case .navigation:
                    row.background(NavigationLink(value: tab.id) { EmptyView() }.opacity(0))
                case .selection:
                    row.onTapGesture {
                        selectedTabId = tab.id
                        viewModel.sendReportFocus(tabId: tab.id)
                    }
                }
            }
        }
        .inboxRow(level: level, highlighted: selectionStyle == .selection && tab.id == currentTabId)
    }

    private func projectName(for tab: RemoteTabState) -> String {
        InboxNavigator.projects(tabs: [tab], states: viewModel.worktreeStates).first?.name ?? tab.workingDirectory
    }

    @ViewBuilder
    private func inboxShelfHeader(label: String, count: Int, collapsed: Bool, onToggle: @escaping () -> Void) -> some View {
        Button(action: onToggle) {
            HStack(spacing: IonSpace.hairlineGap) {
                InboxChevron(isExpanded: !collapsed)
                Text(label)
                    .font(IonType.sectionLabel)
                Text("\(count)")
                    .font(IonType.microLabel)
                    .foregroundStyle(theme.textTertiary)
            }
            .foregroundStyle(theme.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
