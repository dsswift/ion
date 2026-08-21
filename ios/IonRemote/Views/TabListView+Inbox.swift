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
                        inboxRow(tab, selectionStyle: selectionStyle, project: projectName(for: tab), location: nil, branch: nil)
                    }
                    if settled.count > settledShown {
                        Button("Show \(min(15, settled.count - settledShown)) more") { settledShown += 15 }
                            .font(.caption)
                            .foregroundStyle(theme.accent)
                    }
                }
            } header: {
                HStack {
                    inboxShelfHeader(label: "Settled (\(settled.count))", collapsed: settledShelfCollapsed) {
                        settledShelfCollapsed.toggle()
                    }
                    Spacer()
                    Button("History") { showSettledHistory = true }
                        .font(.caption.weight(.semibold))
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
                    .font(.caption)
                    .foregroundStyle(theme.textSecondary)
            }
            ForEach(projects) { project in
                inboxProject(project, expansion: expansion, selectionStyle: selectionStyle)
            }
        } header: {
            Text(title)
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
            HStack {
                Image(systemName: "folder")
                    .foregroundStyle(theme.accent)
                Text(project.name).font(.subheadline.weight(.semibold))
                // The project header's conversation count — the same metadata
                // the desktop header shows beside the folder name.
                Text("\(project.conversationCount)")
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary)
                Spacer()
                Image(systemName: projectExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(project.name)
        .accessibilityValue(projectExpanded ? "Expanded" : "Collapsed")
        // The header's own tap can cycle conversations in the side-by-side
        // layout, so expand/collapse stays reachable as an explicit action.
        .accessibilityAction(named: projectExpanded ? "Collapse project" : "Expand project") {
            toggle(projectKey, in: expansion)
        }

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
                    activeTabId: currentTabId,
                    expanded: expansion,
                    cyclesOnHeaderTap: cyclesOnTap,
                    row: { tab in
                        inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: "Integration Bench", branch: nil)
                    }
                )
            }
            // Worktree groups keep conversation-owned paths in encounter order,
            // then append inventory-only non-landed worktrees. This matches the
            // desktop's complete workspace navigator while preserving the order
            // of rows that do contain conversations.
            ForEach(InboxNavigator.orderedWorktrees(for: project), id: \.worktreePath) { worktree in
                InboxWorktreeGroup(
                    repoPath: project.id,
                    worktree: worktree,
                    tabs: project.worktreeTabs[worktree.worktreePath] ?? [],
                    activeTabId: currentTabId,
                    expanded: expansion,
                    cyclesOnHeaderTap: cyclesOnTap,
                    row: { tab in
                        inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: worktree.displayName, branch: worktree.branchName)
                    }
                )
                .padding(.leading, IonSpace.contentGap)
            }
            if !project.sourceTabs.isEmpty {
                let sourceKey = "source:\(project.id)"
                inboxDisclosure(title: "Source Repository", icon: "archivebox", key: sourceKey, expansion: expansion)
                if expansion.wrappedValue.contains(sourceKey) {
                    ForEach(project.sourceTabs) { tab in
                        inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: "Source Repository", branch: nil)
                            .padding(.leading, IonSpace.sectionGap)
                    }
                }
            }
            // A plain project — no worktree inventory, no bench — has no band
            // for its conversations, so they render directly under the header
            // (the desktop's flatTabs).
            ForEach(project.directTabs) { tab in
                inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: nil, branch: nil)
                    .padding(.leading, IonSpace.sectionGap)
            }
        } else {
            ForEach(InboxNavigator.collapsedRows(project.allTabs, activeTabId: currentTabId)) { tab in
                inboxRow(tab, selectionStyle: selectionStyle, project: project.name, location: nil, branch: nil)
                    .padding(.leading, IonSpace.sectionGap)
            }
        }
    }

    private var inboxProjectFilterLabel: String {
        guard inboxProjectFilter != "all" else { return "All projects" }
        return InboxNavigator.projects(tabs: viewModel.tabs, states: viewModel.worktreeStates)
            .first(where: { $0.id == inboxProjectFilter })?.name ?? "Project"
    }

    /// Projects always sort alphabetically (the navigator already returns them
    /// that way) — the desktop never reorders projects by the sort mode; the
    /// sort mode orders conversations. This only applies the scope filter.
    private func filteredInboxProjects(_ projects: [InboxNavigator.Project]) -> [InboxNavigator.Project] {
        inboxProjectFilter == "all" ? projects : projects.filter { $0.id == inboxProjectFilter }
    }

    private func sortedInboxTabs(_ tabs: [RemoteTabState]) -> [RemoteTabState] {
        InboxNavigator.sorted(tabs, by: inboxSort)
    }

    private func isInSelectedInboxProject(_ tab: RemoteTabState) -> Bool {
        guard inboxProjectFilter != "all" else { return true }
        return InboxNavigator.projects(tabs: [tab], states: viewModel.worktreeStates)
            .contains { $0.id == inboxProjectFilter }
    }

    @ViewBuilder
    var inboxControls: some View {
        Section {
            HStack(spacing: 12) {
                inboxProjectScopeMenu
                Menu {
                    ForEach(InboxNavigator.Sort.allCases) { sort in
                        Button {
                            inboxSort = sort
                            UserDefaults.standard.set(sort.rawValue, forKey: "inboxSort")
                        } label: {
                            if inboxSort == sort {
                                Label(sort.label, systemImage: "checkmark")
                            } else {
                                Text(sort.label)
                            }
                        }
                    }
                } label: {
                    Label(inboxSort.label, systemImage: "arrow.up.arrow.down")
                }
                Spacer()
                Button { toggleAllInboxGroups() } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .accessibilityLabel("Collapse or expand inbox groups")
            }
            .font(.caption)
            .buttonStyle(.plain)
        }
    }

    /// Collapse or expand EVERY inbox group in one action: the projects and
    /// their bands in the Active tree, the same in the Snoozed tree, and the
    /// Settled shelf. One decision drives all three, so the control can never
    /// leave the view half open (the desktop's collapseAll/expandAll writes the
    /// active set, the snoozed set, and the settled shelf together).
    ///
    /// The Active and Snoozed headings themselves are not collapsible on either
    /// client, so they have no key here.
    ///
    /// Both trees are keyed from their OWN rendered projects. The snoozed tree
    /// is built with `.conversationsOnly`, so it contributes keys only while
    /// something is actually snoozed.
    private func toggleAllInboxGroups() {
        let activeKeys = InboxNavigator.expansionKeys(for: InboxNavigator.projects(
            tabs: viewModel.tabs.filter { $0.inboxState != "snoozed" && $0.inboxState != "settled" },
            states: viewModel.worktreeStates
        ))
        let snoozedKeys = InboxNavigator.expansionKeys(for: InboxNavigator.projects(
            tabs: viewModel.tabs.filter { $0.inboxState == "snoozed" },
            states: viewModel.worktreeStates,
            buckets: .conversationsOnly
        ))
        // "Anything still shut" means expand; only a fully open view collapses.
        // The settled shelf votes too, so pressing this with just that shelf
        // closed opens it rather than reading as "already expanded".
        let hasCollapsed = settledShelfCollapsed
            || activeKeys.contains { !activeInboxExpansion.contains($0) }
            || snoozedKeys.contains { !snoozedInboxExpansion.contains($0) }
        activeInboxExpansion = hasCollapsed ? Set(activeKeys) : []
        snoozedInboxExpansion = hasCollapsed ? Set(snoozedKeys) : []
        settledShelfCollapsed = !hasCollapsed
        DiagnosticLog.log("inbox groups toggled", tag: "view.inbox", fields: [
            "expanded": String(hasCollapsed),
            "active_keys": String(activeKeys.count),
            "snoozed_keys": String(snoozedKeys.count)
        ])
    }

    /// Enriched project scope picker: "All projects" with the total, then one
    /// entry per project with its conversation count — the desktop's
    /// InboxProjectScopePicker card content in menu form. Selection persists
    /// (the desktop persists its filter too; this menu used to read the key at
    /// launch and never write it back).
    private var inboxProjectScopeMenu: some View {
        // Counts come from a navigator over ALL live tabs (no scope applied):
        // active + snoozed conversations, terminals excluded — the same input
        // the desktop's projectOptions uses.
        let projects = InboxNavigator.projects(
            tabs: viewModel.tabs.filter { $0.inboxState != "settled" },
            states: viewModel.worktreeStates
        )
        let total = projects.reduce(0) { $0 + $1.conversationCount }
        return Menu {
            Button {
                setInboxProjectFilter("all")
            } label: {
                if inboxProjectFilter == "all" {
                    Label("All projects (\(total))", systemImage: "checkmark")
                } else {
                    Text("All projects (\(total))")
                }
            }
            Divider()
            ForEach(projects) { project in
                Button {
                    setInboxProjectFilter(project.id)
                } label: {
                    if inboxProjectFilter == project.id {
                        Label("\(project.name) (\(project.conversationCount))", systemImage: "checkmark")
                    } else {
                        Text("\(project.name) (\(project.conversationCount))")
                    }
                }
            }
        } label: {
            Label(inboxProjectFilterLabel, systemImage: "folder")
        }
    }

    private func setInboxProjectFilter(_ value: String) {
        inboxProjectFilter = value
        UserDefaults.standard.set(value, forKey: "inboxProjectFilter")
        DiagnosticLog.log("project scope applied", tag: "view.inbox", fields: ["scope": value])
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
            HStack {
                Image(systemName: icon).foregroundStyle(.secondary)
                Text(title)
                Spacer()
                Image(systemName: expansion.wrappedValue.contains(key) ? "chevron.down" : "chevron.right")
                    .font(.caption)
            }
        }
        .buttonStyle(.plain)
        .padding(.leading, IonSpace.contentGap)
    }

    private func toggle(_ key: String, in expansion: Binding<Set<String>>) {
        if expansion.wrappedValue.contains(key) {
            expansion.wrappedValue.remove(key)
        } else {
            expansion.wrappedValue.insert(key)
        }
    }

    private var filteredTabsForInbox: [RemoteTabState] {
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
        branch: String?
    ) -> some View {
        let row = InboxRowView(tab: tab)
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
                Button(tab.pinnedAt == nil ? "Pin" : "Unpin") {
                    if tab.pinnedAt == nil { viewModel.pinTab(tabId: tab.id) } else { viewModel.unpinTab(tabId: tab.id) }
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
                Button("Copy working path") { UIPasteboard.general.string = tab.workingDirectory }
                if let branch = branch { Button("Copy worktree branch") { UIPasteboard.general.string = branch } }
                if let conversationId = tab.conversationId, !conversationId.isEmpty {
                    Button("Copy conversation ID") { UIPasteboard.general.string = conversationId }
                }
                // Routed through the shared close gate so a worktree that
                // still holds work warns here exactly as it does in Classic.
                Button("Delete conversation", role: .destructive) { requestCloseTab(tab) }
            }
        if tab.inboxState == "settled" && !viewModel.tabs.contains(where: { $0.id == tab.id }) {
            if tab.canRestoreSettled != false {
                Button { viewModel.reviewSettledTab(tabId: tab.id) } label: { row }
                    .buttonStyle(.plain)
            } else {
                row
            }
        } else {
            switch selectionStyle {
            case .navigation: NavigationLink(value: tab.id) { row }
            case .selection: row.onTapGesture { selectedTabId = tab.id }
            }
        }
    }

    private func projectName(for tab: RemoteTabState) -> String {
        InboxNavigator.projects(tabs: [tab], states: viewModel.worktreeStates).first?.name ?? tab.workingDirectory
    }

    @ViewBuilder
    private func inboxShelfHeader(label: String, collapsed: Bool, onToggle: @escaping () -> Void) -> some View {
        Button(action: onToggle) {
            HStack(spacing: 4) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down").font(.caption2)
                Text(label).font(.caption.weight(.semibold))
            }
            .foregroundStyle(theme.textSecondary)
        }
        .buttonStyle(.plain)
    }
}

enum InboxSnoozePresets {
    struct Preset { let label: String; let untilMs: Double }

    /// The desktop's preset list (inbox-snooze-presets.ts), including the
    /// 20-minute minimum lead: a preset waking sooner than that is noise.
    static func available(now: Date = Date()) -> [Preset] {
        var out: [Preset] = []
        let calendar = Calendar.current
        func add(_ label: String, _ date: Date) {
            if date.timeIntervalSince(now) >= 20 * 60 {
                out.append(Preset(label: label, untilMs: date.timeIntervalSince1970 * 1000))
            }
        }
        add("In 1 hour", now.addingTimeInterval(3_600))
        add("In 3 hours", now.addingTimeInterval(10_800))
        if let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now) { add("This evening (18:00)", evening) }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), let morning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) { add("Tomorrow (09:00)", morning) }
        // Next Monday (09:00) — the desktop's fifth preset.
        if let nextMonday = calendar.nextDate(after: now, matching: DateComponents(hour: 9, minute: 0, weekday: 2), matchingPolicy: .nextTime) {
            add("Next Monday (09:00)", nextMonday)
        }
        return out
    }
}
