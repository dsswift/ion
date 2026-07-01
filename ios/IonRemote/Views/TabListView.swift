import SwiftUI

struct TabListView: View {
    @Environment(\.appTheme) private var theme
    // Internal (not private) so the same-module TabListView+Helpers extension
    // can read it — the helper extraction (ca74c229) moved viewModel-reading
    // helpers out but left this `private`, which doesn't cross file boundaries
    // and broke the build. Matches the extraction's documented intent that the
    // state the helpers read is internal.
    @Environment(SessionViewModel.self) var viewModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var showSettings = false
    @State private var showNotifications = false
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
    // When non-nil, the new-conversation profile picker is shown.
    // Holds the target directory for tab creation and optional group pin id.
    // These four are read by the TabListView+Helpers.swift extension, so they
    // are internal (not private — private is file-scoped and the extension
    // lives in another file).
    @State var conversationPickerDirectory: String? = nil
    @State var conversationPickerPinToGroupId: String? = nil
    @State private var renamingTabId: String?
    @State private var renameText: String = ""
    @State var collapsedGroupIds: Set<String> = {
        Set(UserDefaults.standard.stringArray(forKey: "collapsedGroupIds") ?? [])
    }()
    @State var searchText: String = ""

    // iPad: selection-based navigation
    @State private var selectedTabId: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    // iPhone: path-based navigation
    @State private var navigationPath = NavigationPath()
    @State private var flickerOpacity: Double = 1.0

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
        .sheet(isPresented: $showNotifications) {
            NotificationsView(resourceStore: viewModel.resourceStore, viewModel: viewModel)
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
                onNewConversation: { dir, pin in
                    requestNewConversation(directory: dir, pinToGroupId: pin)
                },
                onCreateTerminalTab: { dir in
                    viewModel.createTerminalTab(workingDirectory: dir)
                }
            )
        }
        // New-conversation profile picker. Shown when `resolveNewConversationAction`
        // returns `.showPicker` — i.e. multiple profiles exist and no default is set.
        // Includes "Plain conversation" at top (matches desktop picker behaviour).
        .confirmationDialog(
            "New Conversation",
            isPresented: Binding(
                get: { conversationPickerDirectory != nil },
                set: { if !$0 { conversationPickerDirectory = nil; conversationPickerPinToGroupId = nil } }
            ),
            titleVisibility: .visible
        ) {
            // Plain conversation option — always first (mirrors desktop picker).
            Button("Plain conversation") {
                let dir = conversationPickerDirectory
                let pin = conversationPickerPinToGroupId
                conversationPickerDirectory = nil
                conversationPickerPinToGroupId = nil
                DiagnosticLog.log("NEW-CONV: picker selected plain dir=\(dir?.prefix(40) ?? "nil")")
                viewModel.createTab(workingDirectory: dir, pinToGroupId: pin)
            }
            // Engine profiles.
            ForEach(viewModel.engineProfiles) { profile in
                Button(profile.name) {
                    let dir = conversationPickerDirectory
                    let pin = conversationPickerPinToGroupId
                    conversationPickerDirectory = nil
                    conversationPickerPinToGroupId = nil
                    DiagnosticLog.log("NEW-CONV: picker selected profile=\(profile.id.prefix(8)) dir=\(dir?.prefix(40) ?? "nil")")
                    viewModel.createTab(workingDirectory: dir, pinToGroupId: pin, profileId: profile.id)
                }
            }
            Button("Cancel", role: .cancel) {
                conversationPickerDirectory = nil
                conversationPickerPinToGroupId = nil
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
                        HStack(spacing: IonTheme.sm) {
                            Button {
                                showSettings = true
                            } label: {
                                Image(systemName: "gearshape")
                            }
                            NotificationsBellButton(resourceStore: viewModel.resourceStore) {
                                showNotifications = true
                            }
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
                DiagnosticLog.log("NAV: iPad pendingNavigation -> selectedTabId=\(tabId.prefix(8))")
                selectedTabId = tabId
                viewModel.pendingNavigationTabId = nil
            }
        }
        .onChange(of: selectedTabId) { old, tabId in
            DiagnosticLog.log("NAV: iPad selectedTabId changed old=\(old?.prefix(8) ?? "nil") new=\(tabId?.prefix(8) ?? "nil")")
            // Notify the desktop which tab is focused so it can route
            // intercept events to this device correctly.
            viewModel.sendReportFocus(tabId: tabId)
        }
    }

    // MARK: - iPhone Layout (NavigationStack)

    private var iPhoneLayout: some View {
        ZStack {
            if theme.backgroundView != nil {
                Color(red: 4/255, green: 14/255, blue: 28/255).ignoresSafeArea()
            }
            if let bg = theme.backgroundView {
                bg.ignoresSafeArea().opacity(0.9)
                let _ = DiagnosticLog.log("THEME-BG: rendering backgroundView for theme \(theme.id)")
            }
            NavigationStack(path: $navigationPath) {
                List {
                    tabGroupSections(selectionStyle: .navigation)
                }
                .scrollContentBackground(.hidden)
                .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tabs…")
                .navigationTitle("")
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        if theme.backgroundView != nil {
                            Text("J A R V I S")
                                .font(.headline.weight(.black))
                                .kerning(4)
                                .foregroundStyle(theme.accent)
                                .shadow(color: theme.accent.opacity(0.9), radius: 4)
                                .shadow(color: theme.accent.opacity(0.6), radius: 10)
                                .shadow(color: theme.accent.opacity(0.3), radius: 20)
                                .opacity(flickerOpacity)
                        } else {
                            DesktopPickerMenu(showPairingSheet: $showPairingSheet)
                        }
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
                            NotificationsBellButton(resourceStore: viewModel.resourceStore) {
                                showNotifications = true
                            }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        newTabButton
                    }
                }
                .navigationDestination(for: String.self) { tabId in
                    let tab = viewModel.tab(for: tabId)
                    let _ = DiagnosticLog.log("NAV: iPhone push tabId=\(tabId.prefix(8)) isEngine=\(tab?.hasEngineExtension ?? false) isTerminal=\(tab?.isTerminalOnly ?? false)")
                    destinationView(for: tabId)
                        .onAppear {
                            DiagnosticLog.log("NAV: iPhone onAppear tabId=\(tabId.prefix(8))")
                            viewModel.sendReportFocus(tabId: tabId)
                        }
                        .onDisappear {
                            // Only clear focus if we're popping back to the list,
                            // not when a child sheet appears over the conversation.
                            if navigationPath.isEmpty {
                                DiagnosticLog.log("NAV: iPhone onDisappear tabId=\(tabId.prefix(8)) popped to list")
                                viewModel.sendReportFocus(tabId: nil)
                            }
                        }
                }
                .refreshable {
                    Haptic.light()
                    viewModel.sync(intent: .userInitiated)
                }
                .onChange(of: viewModel.pendingNavigationTabId) { _, tabId in
                    if let tabId {
                        DiagnosticLog.log("NAV: iPhone pendingNavigation push tabId=\(tabId.prefix(8))")
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
                .toolbarBackground(
                    theme.backgroundView != nil
                        ? Color(red: 4/255, green: 14/255, blue: 28/255).opacity(0.95)
                        : Color.clear,
                    for: .navigationBar
                )
                .toolbarColorScheme(
                    theme.backgroundView != nil ? .dark : nil,
                    for: .navigationBar
                )
                .task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(Double.random(in: 3.0...9.0)))
                        guard !Task.isCancelled else { break }
                        withAnimation(.easeInOut(duration: 0.05)) { flickerOpacity = 0.55 }
                        try? await Task.sleep(for: .milliseconds(60))
                        withAnimation(.easeInOut(duration: 0.05)) { flickerOpacity = 1.0 }
                        try? await Task.sleep(for: .milliseconds(90))
                        withAnimation(.easeInOut(duration: 0.04)) { flickerOpacity = 0.75 }
                        try? await Task.sleep(for: .milliseconds(50))
                        withAnimation(.easeInOut(duration: 0.1)) { flickerOpacity = 1.0 }
                    }
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
            .scrollContentBackground(.hidden)
            .refreshable {
                Haptic.light()
                viewModel.sync(intent: .userInitiated)
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
                                        },
                                        engineProfiles: viewModel.engineProfiles
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
                                    },
                                    engineProfiles: viewModel.engineProfiles
                                )
                                .tag(tab.id)
                            }
                        }
                        // Apply a tinted cell background only when this tab has a
                        // pill color and the setting is enabled. We resolve the color
                        // before calling .listRowBackground so we never pass nil/EmptyView
                        // to it — doing so would strip the List's default cell material
                        // from uncolored rows, leaving them solid black.
                        .ifLet(activePillColor(for: tab)) { view, color in
                            view.listRowBackground(
                                color.opacity(0.12)
                                    .overlay(alignment: .leading) {
                                        color.opacity(0.65).frame(width: 3)
                                    }
                            )
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
                        // Context menu extracted to TabRowContextMenu.swift to keep
                        // this file under the Swift 600-line cap.
                        .modifier(TabRowContextMenu(
                            tab: tab,
                            renamingTabId: $renamingTabId,
                            renameText: $renameText
                        ))
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

    /// Returns the resolved Color for a tab's pill color when the Show Tab Colors
    /// setting is enabled and the tab has a non-empty pillColor string. Returns nil
    /// otherwise so the caller can skip applying listRowBackground entirely (passing
    /// nil or EmptyView to listRowBackground strips the default cell material).
    private func activePillColor(for tab: RemoteTabState) -> Color? {
        guard viewModel.showTabColorInTabList,
              let hex = tab.pillColor, !hex.isEmpty else { return nil }
        return Color(hex: hex)
    }

    private func groupHeader(_ group: (label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])) -> some View {
        // under the Swift 600-line cap. See CLAUDE.md → "When a file
        // exceeds the cap". The wrapper function is kept so existing
        // callers (the List's `header:` parameter) don't need to change.
        TabListGroupHeader(
            group: group,
            isCollapsed: collapsedGroupIds.contains(group.id),
            tabGroupMode: viewModel.tabGroupMode,
            pendingPinToGroupId: $pendingPinToGroupId,
            showNewTab: $showNewTab,
            onNewConversation: { dir, pin in
                requestNewConversation(directory: dir, pinToGroupId: pin)
            },
            onCreateTerminalTab: { dir in
                viewModel.createTerminalTab(workingDirectory: dir)
            },
            onToggleCollapsed: {
                toggleGroupCollapsed(group.id)
            }
        )
    }

    // MARK: - Detail / Destination

    @ViewBuilder
    private func destinationView(for tabId: String) -> some View {
        if viewModel.tab(for: tabId)?.isTerminalOnly == true {
            RemoteTerminalView(tabId: tabId)
        } else {
            // One unified conversation view for every non-terminal tab — plain
            // or extension (#256). Engine-only chrome self-gates on
            // `tabHasExtensions` inside the view.
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
                // No directories known yet: route immediately (will create plain).
                requestNewConversation(directory: nil, pinToGroupId: nil)
            } else {
                showNewTab = true
            }
        } label: {
            Image(systemName: "plus")
        }
        .contextMenu {
            if let defaultDir = allDirectories.first {
                Button { requestNewConversation(directory: defaultDir.fullPath, pinToGroupId: nil) } label: {
                    Label("New Tab", systemImage: "plus")
                }
                Button { viewModel.createTerminalTab(workingDirectory: defaultDir.fullPath) } label: {
                    Label("New Terminal", systemImage: "terminal")
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
                    .foregroundStyle(theme.accent)
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
    // newTabSheet was extracted to TabListNewTabSheet.swift to keep this
    // file under the Swift 600-line cap. See CLAUDE.md → "When a file
    // exceeds the cap". The sheet is now presented inline in `body`'s
    // `.sheet(isPresented:onDismiss:)` modifier above.
    //
    // The search-filter (filteredDisplayGroups), collapsed-group persistence,
    // new-conversation routing (requestNewConversation), and directory-list
    // helpers were extracted to TabListView+Helpers.swift for the same reason.
}

// MARK: - Tab Selection Style

private enum TabSelectionStyle {
    case navigation  // iPhone: NavigationLink(value:)
    case selection   // iPad: List(selection:) with .tag()
}
