import SwiftUI

struct TabListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var showSettings = false
    @State private var showNewTab = false
    // When the new-tab sheet was opened from a group header's `+` button,
    // this holds the target group's id so we can stamp `pinToGroupId` on
    // the outbound createTab command (fix for issue: per-group `+` would
    // create tabs that the first prompt's auto-movement immediately
    // yanked into the planning group). nil when the sheet was opened from
    // the global toolbar `+`, in which case we want the legacy behavior.
    // Reset to nil on every sheet close so the global toolbar `+` is
    // never accidentally treated as a per-group request.
    @State private var pendingPinToGroupId: String? = nil
    @State private var showPairingSheet = false
    @State private var enginePickerDirectory: String? = nil
    @State private var renamingTabId: String?
    @State private var renameText: String = ""
    @State private var collapsedGroupIds: Set<String> = {
        Set(UserDefaults.standard.stringArray(forKey: "collapsedGroupIds") ?? [])
    }()
    @State private var searchText: String = ""

    // iPad: selection-based navigation
    @State private var selectedTabId: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    // iPhone: path-based navigation
    @State private var navigationPath = NavigationPath()

    var body: some View {
        Group {
            if sizeClass == .regular {
                iPadLayout
            } else {
                iPhoneLayout
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onAppear {
            // Always refresh git info for every tab dir on appear — covers
            // the silent-staleness case where the desktop watcher stopped
            // delivering events. Cheap (one git status per dir) and only
            // fires when the list becomes visible.
            if viewModel.showGitInfoInTabList { viewModel.requestAllGitChanges() }
        }
        .onChange(of: viewModel.showGitInfoInTabList) { _, enabled in
            if enabled { viewModel.requestAllGitChanges() }
        }
        .sheet(isPresented: $showPairingSheet) {
            PairingView()
        }
        .sheet(isPresented: $showNewTab, onDismiss: {
            // Always clear the per-group pin target on dismiss so a
            // subsequent toolbar `+` doesn't inherit it. Required because
            // the sheet has multiple dismissal paths (Cancel button, tap
            // on a row's `+`, swipe-down).
            pendingPinToGroupId = nil
        }) {
            TabListNewTabSheet(
                directories: allDirectories,
                pendingPinToGroupId: pendingPinToGroupId,
                isPresented: $showNewTab,
                onCreateConversationTab: { dir, pinToGroupId in
                    viewModel.createTab(workingDirectory: dir, pinToGroupId: pinToGroupId)
                },
                onCreateTerminalTab: { dir in
                    viewModel.createTerminalTab(workingDirectory: dir)
                },
                onCreateEngineTab: { dir in
                    requestEngineTab(directory: dir)
                }
            )
        }
        .confirmationDialog(
            "Select Engine Profile",
            isPresented: Binding(
                get: { enginePickerDirectory != nil },
                set: { if !$0 { enginePickerDirectory = nil } }
            ),
            titleVisibility: .visible
        ) {
            ForEach(viewModel.engineProfiles) { profile in
                Button(profile.name) {
                    let dir = enginePickerDirectory
                    enginePickerDirectory = nil
                    viewModel.createEngineTab(workingDirectory: dir, profileId: profile.id)
                }
            }
            Button("Cancel", role: .cancel) {
                enginePickerDirectory = nil
            }
        }
        .alert("Rename Tab", isPresented: .init(
            get: { renamingTabId != nil },
            set: { if !$0 { renamingTabId = nil } }
        )) {
            TextField("Name", text: $renameText)
            Button("Rename") {
                if let id = renamingTabId {
                    let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    viewModel.renameTab(tabId: id, customTitle: title.isEmpty ? nil : title)
                }
                renamingTabId = nil
            }
            Button("Cancel", role: .cancel) {
                renamingTabId = nil
            }
        } message: {
            Text("Enter a new name for this tab.")
        }
    }

    // MARK: - iPad Layout (NavigationSplitView)

    private var iPadLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebarContent
                .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tabs…")
                .navigationTitle("")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        newTabButton
                    }
                }
        } detail: {
            detailView
        }
        .navigationSplitViewStyle(.balanced)
        .onChange(of: viewModel.pendingNavigationTabId) { _, tabId in
            if let tabId {
                selectedTabId = tabId
                viewModel.pendingNavigationTabId = nil
            }
        }
    }

    // MARK: - iPhone Layout (NavigationStack)

    private var iPhoneLayout: some View {
        NavigationStack(path: $navigationPath) {
            List {
                tabGroupSections(selectionStyle: .navigation)
            }
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tabs…")
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    DesktopPickerMenu(showPairingSheet: $showPairingSheet)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 12) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        ConnectionQualityView(compact: true)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    newTabButton
                }
            }
            .navigationDestination(for: String.self) { tabId in
                destinationView(for: tabId)
            }
            .refreshable {
                Haptic.light()
                viewModel.sync()
            }
            .onChange(of: viewModel.pendingNavigationTabId) { _, tabId in
                if let tabId {
                    navigationPath.append(tabId)
                    viewModel.pendingNavigationTabId = nil
                }
            }
            .overlay {
                emptyStateOverlay
            }
            .overlay {
                searchEmptyStateOverlay
            }
            .overlay(alignment: .top) {
                if viewModel.voiceService.isSpeaking {
                    VoicePlaybackBar(
                        onSkip: { viewModel.voiceService.skip() },
                        onStopAll: { viewModel.voiceService.stop() },
                        hasPending: viewModel.voiceService.hasPending
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .animation(IonTheme.snappySpring, value: viewModel.voiceService.isSpeaking)
                }
            }
        }
    }

    // MARK: - Sidebar Content

    private var sidebarContent: some View {
        VStack(spacing: 0) {
            // Device picker + connection quality always visible in sidebar
            HStack(spacing: 8) {
                DesktopPickerMenu(showPairingSheet: $showPairingSheet)
                Spacer()
                ConnectionQualityView(compact: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            List(selection: $selectedTabId) {
                tabGroupSections(selectionStyle: .selection)
            }
            .refreshable {
                Haptic.light()
                viewModel.sync()
            }
            .overlay {
                emptyStateOverlay
            }
            .overlay {
                searchEmptyStateOverlay
            }
            .overlay(alignment: .top) {
                if viewModel.voiceService.isSpeaking {
                    VoicePlaybackBar(
                        onSkip: { viewModel.voiceService.skip() },
                        onStopAll: { viewModel.voiceService.stop() },
                        hasPending: viewModel.voiceService.hasPending
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .animation(IonTheme.snappySpring, value: viewModel.voiceService.isSpeaking)
                }
            }
        }
    }

    // MARK: - Tab Group Sections

    @ViewBuilder
    private func tabGroupSections(selectionStyle: TabSelectionStyle) -> some View {
        let isSearching = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ForEach(filteredDisplayGroups, id: \.id) { group in
            Section {
                if isSearching || !collapsedGroupIds.contains(group.id) {
                    ForEach(group.tabs) { tab in
                        Group {
                            switch selectionStyle {
                            case .navigation:
                                NavigationLink(value: tab.id) {
                                    TabRowView(
                                        tab: tab,
                                        showDirectory: viewModel.tabGroupMode == "manual",
                                        showGitInfo: viewModel.showGitInfoInTabList,
                                        idleSince: viewModel.tabIdleSince[tab.id],
                                        isSpeaking: viewModel.voiceService.speakingTabId == tab.id && viewModel.voiceService.isSpeaking,
                                        gitChanges: viewModel.gitChanges[tab.workingDirectory],
                                        onOpenGit: {
                                            viewModel.pendingGitPaneTabId = tab.id
                                            viewModel.pendingNavigationTabId = tab.id
                                        }
                                    )
                                }
                            case .selection:
                                TabRowView(
                                    tab: tab,
                                    showDirectory: viewModel.tabGroupMode == "manual",
                                    showGitInfo: viewModel.showGitInfoInTabList,
                                    idleSince: viewModel.tabIdleSince[tab.id],
                                    isSpeaking: viewModel.voiceService.speakingTabId == tab.id && viewModel.voiceService.isSpeaking,
                                    gitChanges: viewModel.gitChanges[tab.workingDirectory],
                                    onOpenGit: {
                                        viewModel.pendingGitPaneTabId = tab.id
                                        viewModel.pendingNavigationTabId = tab.id
                                    }
                                )
                                .tag(tab.id)
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button {
                                renameText = tab.displayTitle
                                renamingTabId = tab.id
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            .tint(.orange)
                        }
                        .contextMenu {
                            Button {
                                renameText = tab.displayTitle
                                renamingTabId = tab.id
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            if viewModel.tabGroupMode == "manual" {
                                Button {
                                    viewModel.toggleTabGroupPin(tabId: tab.id)
                                } label: {
                                    Label(
                                        tab.groupPinned == true ? "Unpin from Group" : "Pin to Group",
                                        systemImage: tab.groupPinned == true ? "pin.slash" : "pin"
                                    )
                                }
                                let targets = viewModel.tabGroups.filter { $0.id != tab.groupId }
                                if !targets.isEmpty {
                                    Menu {
                                        ForEach(targets) { target in
                                            Button(target.label) {
                                                viewModel.moveTabToGroup(tabId: tab.id, groupId: target.id)
                                            }
                                        }
                                    } label: {
                                        Label("Move to Group", systemImage: "arrow.right.arrow.left")
                                    }
                                    // Combined "Move to Group AND Pin": same target list as the
                                    // plain "Move to Group" submenu above, but each selection
                                    // routes through moveTabToGroupAndPin which also sets
                                    // groupPinned=true so the destination tab is protected from
                                    // any subsequent auto-group-movement. Mirrors the desktop
                                    // pattern (TabStripTabContextMenu's PushPin row).
                                    Menu {
                                        ForEach(targets) { target in
                                            Button(target.label) {
                                                viewModel.moveTabToGroupAndPin(tabId: tab.id, groupId: target.id)
                                            }
                                        }
                                    } label: {
                                        Label("Move to Group and Pin", systemImage: "pin")
                                    }
                                }
                            }
                        }
                    }
                    .onDelete { offsets in
                        let ids = offsets.map { group.tabs[$0].id }
                        for id in ids {
                            viewModel.closeTab(id)
                        }
                    }
                }
            } header: {
                groupHeader(group)
            }
        }
    }

    private func groupHeader(_ group: (label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])) -> some View {
        // Body extracted to TabListGroupHeader.swift to keep this file
        // under the Swift 600-line cap. See CLAUDE.md → "When a file
        // exceeds the cap". The wrapper function is kept so existing
        // callers (the List's `header:` parameter) don't need to change.
        TabListGroupHeader(
            group: group,
            isCollapsed: collapsedGroupIds.contains(group.id),
            tabGroupMode: viewModel.tabGroupMode,
            pendingPinToGroupId: $pendingPinToGroupId,
            showNewTab: $showNewTab,
            onCreateConversationTab: { dir, pin in
                viewModel.createTab(workingDirectory: dir, pinToGroupId: pin)
            },
            onCreateTerminalTab: { dir in
                viewModel.createTerminalTab(workingDirectory: dir)
            },
            onCreateEngineTab: { dir in
                requestEngineTab(directory: dir)
            },
            onToggleCollapsed: {
                toggleGroupCollapsed(group.id)
            }
        )
    }

    // MARK: - Detail / Destination

    @ViewBuilder
    private func destinationView(for tabId: String) -> some View {
        if viewModel.tab(for: tabId)?.isEngine == true {
            EngineView(tabId: tabId)
        } else if viewModel.tab(for: tabId)?.isTerminalOnly == true {
            RemoteTerminalView(tabId: tabId)
        } else {
            ConversationView(tabId: tabId)
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let tabId = selectedTabId, viewModel.tab(for: tabId) != nil {
            destinationView(for: tabId)
                .id(tabId)
        } else {
            VStack(spacing: 12) {
                Image(systemName: "sidebar.leading")
                    .font(.system(size: 40))
                    .foregroundStyle(.tertiary)
                Text("Select a tab")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("Choose a conversation from the sidebar.")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Shared Components

    private var newTabButton: some View {
        Button {
            if allDirectories.isEmpty {
                viewModel.createTab()
            } else {
                showNewTab = true
            }
        } label: {
            Image(systemName: "plus")
        }
        .contextMenu {
            if let defaultDir = allDirectories.first {
                Button { viewModel.createTab(workingDirectory: defaultDir.fullPath) } label: {
                    Label("New Tab", systemImage: "plus")
                }
                Button { viewModel.createTerminalTab(workingDirectory: defaultDir.fullPath) } label: {
                    Label("New Terminal", systemImage: "terminal")
                }
                Button { requestEngineTab(directory: defaultDir.fullPath) } label: {
                    Label("New Engine", systemImage: "bolt.fill")
                }
            }
        }
    }

    @ViewBuilder
    private var emptyStateOverlay: some View {
        if viewModel.tabs.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "terminal")
                    .font(.system(size: 40))
                    .foregroundStyle(IonTheme.accent)
                Text("No Tabs")
                    .font(.title3.weight(.semibold))
                Text("Tap + to create a new tab or pull to refresh.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
    }

    @ViewBuilder
    private var searchEmptyStateOverlay: some View {
        let isSearching = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if isSearching && filteredDisplayGroups.isEmpty && !viewModel.tabs.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 40))
                    .foregroundStyle(.tertiary)
                Text("No Results")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("No tabs match \"\(searchText.trimmingCharacters(in: .whitespacesAndNewlines))\".")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
    }

    // MARK: - Filtered Display Groups

    /// Returns `viewModel.displayGroups` filtered by `searchText`.
    /// When search is empty, returns the full list unchanged (zero cost).
    /// Groups with zero matching tabs are dropped entirely.
    private var filteredDisplayGroups: [(label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return viewModel.displayGroups }

        return viewModel.displayGroups.compactMap { group in
            let matchingTabs = group.tabs.filter { tab in
                let compoundKey = viewModel.engineCompoundKey(tabId: tab.id)
                return TabSearchHelper.matches(
                    tab: tab,
                    query: query,
                    messages: viewModel.messages[tab.id],
                    engineMessages: viewModel.engineMessages[compoundKey],
                    attachments: viewModel.tabAttachmentCache[tab.id]
                )
            }
            guard !matchingTabs.isEmpty else { return nil }
            return (label: group.label, id: group.id, icon: group.icon, directory: group.directory, tabs: matchingTabs)
        }
    }

    // newTabSheet was extracted to TabListNewTabSheet.swift to keep this
    // file under the Swift 600-line cap. See CLAUDE.md → "When a file
    // exceeds the cap". The sheet is now presented inline in `body`'s
    // `.sheet(isPresented:onDismiss:)` modifier above.

    // MARK: - Helpers

    /// Toggle a group's collapsed state and persist to UserDefaults.
    private func toggleGroupCollapsed(_ groupId: String) {
        if collapsedGroupIds.contains(groupId) {
            collapsedGroupIds.remove(groupId)
        } else {
            collapsedGroupIds.insert(groupId)
        }
        persistCollapsedGroups()
    }

    private func persistCollapsedGroups() {
        UserDefaults.standard.set(Array(collapsedGroupIds), forKey: "collapsedGroupIds")
    }

    /// Handle engine tab creation with profile selection.
    /// - 0 profiles: auto-create without a profileId (engine uses default)
    /// - 1 profile: auto-select the only profile
    /// - 2+ profiles: show a confirmation dialog picker
    private func requestEngineTab(directory: String) {
        let profiles = viewModel.engineProfiles
        switch profiles.count {
        case 0:
            viewModel.createEngineTab(workingDirectory: directory)
        case 1:
            viewModel.createEngineTab(workingDirectory: directory, profileId: profiles[0].id)
        default:
            enginePickerDirectory = directory
        }
    }

    /// Ordered list of directories: default base directory first, then recent directories (deduplicated).
    private var allDirectories: [(label: String, fullPath: String)] {
        var seen = Set<String>()
        var result: [(label: String, fullPath: String)] = []

        if let base = viewModel.defaultBaseDirectory, !base.isEmpty {
            seen.insert(base)
            result.append((label: directoryLabel(base), fullPath: base))
        }

        for dir in viewModel.recentDirectories where !seen.contains(dir) {
            seen.insert(dir)
            result.append((label: directoryLabel(dir), fullPath: dir))
        }

        return result
    }

    private func directoryLabel(_ path: String) -> String {
        let base = (path as NSString).lastPathComponent
        if base.isEmpty || path == "/" || path == "~" {
            return "Home"
        }
        return base
    }
}

// MARK: - Tab Selection Style

private enum TabSelectionStyle {
    case navigation  // iPhone: NavigationLink(value:)
    case selection   // iPad: List(selection:) with .tag()
}
