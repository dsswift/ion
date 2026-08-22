import SwiftUI

struct TabListView: View {
    // Internal (not private) so the same-module TabListView+DetailViews
    // extension can read it (the detail/destination + shared-component view
    // builders were extracted there to keep this file under the Swift 600-line
    // cap; private is file-scoped and does not cross the extension boundary).
    @Environment(\.appTheme) var theme
    // Internal (not private) so the same-module TabListView+Helpers extension
    // can read it — the helper extraction (ca74c229) moved viewModel-reading
    // helpers out but left this `private`, which doesn't cross file boundaries
    // and broke the build. Matches the extraction's documented intent that the
    // state the helpers read is internal.
    @Environment(SessionViewModel.self) var viewModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    // Internal (not private) so the same-module TabListView+Layouts extension
    // can read them — the layout roots own the toolbars that set these.
    @State var showSettings = false
    @State var showNotifications = false
    // Internal (not private) so the same-module TabListView+DetailViews
    // extension can read it — see the note on `theme` above.
    @State var showNewTab = false
    // When the new-tab sheet was opened from a group header's `+` button,
    // this holds the target group's id so we can stamp `pinToGroupId` on
    // the outbound createTab command (fix for issue: per-group `+` would
    // create tabs that the first prompt's auto-movement immediately
    // yanked into the planning group). nil when the sheet was opened from
    // the global toolbar `+`, in which case we want the legacy behavior.
    // Reset to nil on every sheet close so the global toolbar `+` is
    // never accidentally treated as a per-group request.
    @State private var pendingPinToGroupId: String? = nil
    // Pending new-conversation request from TabListNewTabSheet. Stored here
    // so `requestNewConversation` fires in `onDismiss` — after the sheet
    // animation completes — rather than mid-animation. SwiftUI silently drops
    // a confirmationDialog that is presented while a sheet is still animating
    // out, which caused the "Plain conversation" tap to appear to do nothing.
    @State private var pendingNewConversationDir: String? = nil
    @State private var pendingNewConversationPin: String? = nil
    // Internal (not private): the DesktopPickerMenu in TabListView+Layouts'
    // toolbars binds to it.
    @State var showPairingSheet = false
    // When non-nil, the new-conversation profile picker is shown.
    // Holds the target directory for tab creation and optional group pin id.
    // These four are read by the TabListView+Helpers.swift extension, so they
    // are internal (not private — private is file-scoped and the extension
    // lives in another file).
    @State var conversationPickerDirectory: String? = nil
    @State var conversationPickerPinToGroupId: String? = nil
    @State private var renamingTabId: String?
    @State private var renameText: String = ""
    /// A close held for confirmation because the tab's worktree still holds work.
    /// Nil for every uneventful close, which proceeds without a prompt.
    /// Internal so the +Inbox extension's requestCloseTab path shares the gate.
    @State var pendingCloseWarning: PendingCloseWarning?
    @State var collapsedGroupIds: Set<String> = {
        Set(UserDefaults.standard.stringArray(forKey: "collapsedGroupIds") ?? [])
    }()
    @State var searchText: String = ""

    // ─── Inbox | Ion Classic view switcher (per-device, persisted) ───────
    // Mirrors the desktop's per-device conversationNav preference: never
    // synced, never projectable — each device picks its own navigation.
    @State var listViewMode: String = UserDefaults.standard.string(forKey: "tabListViewMode") ?? "classic"
    // Inbox shelf UI state (internal: the +Inbox extension reads these).
    @State var activeInboxExpansion: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "inboxActiveExpansion") ?? [])
    @State var snoozedInboxExpansion: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "inboxSnoozedExpansion") ?? [])
    @State var settledShelfCollapsed = UserDefaults.standard.object(forKey: "inboxSettledShelfCollapsed") as? Bool ?? true
    @State var settledShown = 15
    @State var inboxProjectFilter = UserDefaults.standard.string(forKey: "inboxProjectFilter") ?? "all"
    @State var inboxSort = InboxNavigator.Sort(rawValue: UserDefaults.standard.string(forKey: "inboxSort") ?? "recent") ?? .recent
    @State var showSettledHistory = false
    /// Tab awaiting a snooze-preset choice (confirmationDialog).
    @State var snoozeSheetTabId: String? = nil
    @State var inboxRenameTabId: String? = nil
    @State var inboxRenameTitle = ""

    // iPad: selection-based navigation. selectedTabId is internal (not private)
    // so the same-module TabListView+DetailViews extension can read it — see the
    // note on `theme` above.
    @State var selectedTabId: String?
    // columnVisibility, navigationPath, and flickerOpacity are internal for the
    // same reason: TabListView+Layouts owns both size-class layout roots.
    @State var columnVisibility: NavigationSplitViewVisibility = .all

    // iPhone: path-based navigation.
    //
    // Typed as [String] rather than NavigationPath so the pushed tab ids are
    // readable. A NavigationPath is write-only (append/removeLast), which meant
    // nothing could tell whether a pushed destination still referred to a live
    // tab — a conversation closed on the desktop left its id on the stack and
    // ConversationView rendered a titleless, stateless shell for it. The stack
    // has to be inspectable to be revalidated.
    @State var navigationPath: [String] = []
    @State var flickerOpacity: Double = 1.0

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
        // Snooze preset picker (inbox swipe action). confirmationDialog over
        // a sheet: four options, no custom chrome needed.
        .confirmationDialog(
            "Snooze until…",
            isPresented: Binding(get: { snoozeSheetTabId != nil }, set: { if !$0 { snoozeSheetTabId = nil } }),
            titleVisibility: .visible,
        ) {
            ForEach(InboxSnoozePresets.available(), id: \.label) { preset in
                Button(preset.label) {
                    if let tabId = snoozeSheetTabId {
                        viewModel.snoozeTab(tabId: tabId, untilMs: preset.untilMs)
                    }
                    snoozeSheetTabId = nil
                }
            }
            Button("Cancel", role: .cancel) { snoozeSheetTabId = nil }
        }
        .alert("Rename conversation", isPresented: Binding(get: { inboxRenameTabId != nil }, set: { if !$0 { inboxRenameTabId = nil } })) {
            TextField("Conversation name", text: $inboxRenameTitle)
            Button("Save") {
                if let tabId = inboxRenameTabId { viewModel.renameTab(tabId: tabId, customTitle: inboxRenameTitle) }
                inboxRenameTabId = nil
            }
            Button("Cancel", role: .cancel) { inboxRenameTabId = nil }
        }
        .sheet(isPresented: $showSettledHistory) {
            InboxSettledHistorySheet(tabs: InboxNavigator.settledStack(liveTabs: viewModel.tabs, coldTabs: viewModel.settledTabs)) { tab in
                guard tab.canRestoreSettled != false else { return }
                viewModel.reviewSettledTab(tabId: tab.id)
                showSettledHistory = false
            }
        }
        .onChange(of: activeInboxExpansion) { _, value in
            UserDefaults.standard.set(Array(value), forKey: "inboxActiveExpansion")
        }
        .onChange(of: snoozedInboxExpansion) { _, value in
            UserDefaults.standard.set(Array(value), forKey: "inboxSnoozedExpansion")
        }
        .onChange(of: settledShelfCollapsed) { _, value in
            UserDefaults.standard.set(value, forKey: "inboxSettledShelfCollapsed")
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
            // Drain any pending new-conversation request that the sheet
            // stored (instead of calling requestNewConversation immediately).
            // Calling requestNewConversation from inside the sheet button's
            // action (while isPresented=false is mid-animation) causes
            // SwiftUI to silently drop the confirmationDialog presented by
            // the .showPicker routing outcome. onDismiss fires after the
            // animation completes, so the dialog presents cleanly.
            if let dir = pendingNewConversationDir {
                let pin = pendingNewConversationPin
                pendingNewConversationDir = nil
                pendingNewConversationPin = nil
                requestNewConversation(directory: dir, pinToGroupId: pin)
            }
        }) {
            TabListNewTabSheet(
                directories: allDirectories,
                pendingPinToGroupId: pendingPinToGroupId,
                isPresented: $showNewTab,
                onNewConversation: { dir, pin in
                    // Store the request; onDismiss drains it once the sheet
                    // animation completes. This prevents the confirmationDialog
                    // from being presented while the sheet is still animating out
                    // (SwiftUI silently drops overlapping sheet/dialog presentations).
                    pendingNewConversationDir = dir
                    pendingNewConversationPin = pin
                },
                onCreateWorktree: { repoPath, sourceBranch in
                    viewModel.createWorktree(repoPath: repoPath, sourceBranch: sourceBranch)
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
                DiagnosticLog.log("new conv picker selected plain", tag: "view.tablist", fields: [
                    "path": dir?.prefix(40).description ?? "nil"
                ])
                viewModel.createTab(workingDirectory: dir, pinToGroupId: pin)
            }
            // Engine profiles.
            ForEach(viewModel.engineProfiles) { profile in
                Button(profile.name) {
                    let dir = conversationPickerDirectory
                    let pin = conversationPickerPinToGroupId
                    conversationPickerDirectory = nil
                    conversationPickerPinToGroupId = nil
                    DiagnosticLog.log("new conv picker selected profile", tag: "view.tablist", fields: [
                        "reason": String(profile.id.prefix(8)),
                        "path": dir?.prefix(40).description ?? "nil"
                    ])
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
        // Close confirmation for a worktree conversation that still holds work.
        //
        // Only raised when there is something to say (see WorktreeCloseWarning):
        // a plain conversation, and a worktree that is clean and fully landed,
        // still close straight from the swipe with no extra tap. Closing is never
        // destructive — the worktree outlives its conversations — so this informs
        // rather than guards, which is why the confirm is not `.destructive`.
        .alert("Close conversation?", isPresented: .init(
            get: { pendingCloseWarning != nil },
            set: { if !$0 { pendingCloseWarning = nil } }
        )) {
            Button("Close") {
                if let pending = pendingCloseWarning {
                    viewModel.closeTab(pending.tabId)
                }
                pendingCloseWarning = nil
            }
            Button("Cancel", role: .cancel) {
                pendingCloseWarning = nil
            }
        } message: {
            Text(pendingCloseWarning?.summary ?? "")
        }
    }

    // MARK: - Sidebar Content

    // Internal (not private): consumed by iPadLayout in TabListView+Layouts.
    var sidebarContent: some View {
        VStack(spacing: 0) {
            // Device picker + connection quality always visible in sidebar
            HStack(spacing: 8) {
                DesktopPickerMenu(showPairingSheet: $showPairingSheet)
                Spacer()
                ConnectionQualityView(compact: true)
            }
            .padding(.horizontal, IonSpace.rowInset)
            .padding(.vertical, IonSpace.compactGap)

            List(selection: $selectedTabId) {
                tabSections(selectionStyle: .selection)
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

    /// Section dispatcher: Classic (groups) or Inbox, per the persisted
    /// per-device mode. Both layout roots render THIS, so the switcher
    /// applies to iPhone and iPad alike.
    @ViewBuilder
    func tabSections(selectionStyle: TabSelectionStyle) -> some View {
        if listViewMode == "inbox" {
            inboxControls
                // Ride the same cached crawl the desktop panels use so the
                // hierarchy renders from fresh state the moment the inbox
                // appears, instead of waiting out the snapshot interval.
                .onAppear { viewModel.refreshAllWorktrees() }
            inboxSections(selectionStyle: selectionStyle)
        } else {
            tabGroupSections(selectionStyle: selectionStyle)
        }
    }

    /// Toolbar toggle between the two list modes.
    var viewModeToggle: some View {
        Button {
            listViewMode = listViewMode == "inbox" ? "classic" : "inbox"
            UserDefaults.standard.set(listViewMode, forKey: "tabListViewMode")
            DiagnosticLog.log("tab list view mode switched", tag: "view.tablist", fields: ["mode": listViewMode])
        } label: {
            Image(systemName: listViewMode == "inbox" ? "tray.full" : "tray")
        }
        .accessibilityLabel(listViewMode == "inbox" ? "Switch to Ion Classic view" : "Switch to Inbox view")
    }

    // Internal (not private): both layout roots in TabListView+Layouts render it.
    @ViewBuilder
    func tabGroupSections(selectionStyle: TabSelectionStyle) -> some View {
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
                                )
                                .tag(tab.id)
                            }
                        }
                        // The row fill is a theme token, applied unconditionally.
                        // It used to be applied only for pill-colored rows, so
                        // every other row fell through to the List's default cell
                        // material — a system color no theme pack can reach, and
                        // solid black in dark mode.
                        //
                        // A pill color contributes a 3pt leading edge only. The
                        // full-width 0.12 wash it used to also paint made colored
                        // conversations shout beside neutral ones, so a tinted
                        // idle row outweighed an untinted running one. The edge
                        // still identifies the conversation without competing
                        // with the status dot for attention.
                        .listRowBackground(
                            theme.surfaceSecondary
                                .overlay(alignment: .leading) {
                                    if let color = activePillColor(for: tab) {
                                        color.opacity(0.65).frame(width: 3)
                                    }
                                }
                        )
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
                        let tabs = offsets.map { group.tabs[$0] }
                        for tab in tabs {
                            requestCloseTab(tab)
                        }
                    }
                }
            } header: {
                groupHeader(group)
            }
        }
    }

    /// Close a tab, pausing for confirmation only when its worktree still holds
    /// work the operator should know about.
    ///
    /// Mirrors the desktop's `requestCloseTab`: every close goes through one
    /// place, so the warning cannot be bypassed by a future entry point that
    /// calls `closeTab` directly. Silent for the uneventful case, so the common
    /// swipe-to-close keeps its single-gesture feel. Internal (not private):
    /// the +Inbox extension's "Delete conversation" routes through this same
    /// gate — it used to call `closeTab` directly and skipped the warning.
    func requestCloseTab(_ tab: RemoteTabState) {
        if let summary = WorktreeCloseWarning.summary(for: tab, worktreeStates: viewModel.worktreeStates) {
            DiagnosticLog.log("close held for worktree warning", tag: "tabs", fields: [
                "tab_id": String(tab.id.prefix(8)),
                "directory": tab.workingDirectory,
            ])
            pendingCloseWarning = PendingCloseWarning(tabId: tab.id, summary: summary)
            return
        }
        viewModel.closeTab(tab.id)
    }

    /// Returns the resolved Color for a tab's pill color when the Show Tab Colors
    /// setting is enabled and the tab has a non-empty pillColor string. Returns nil
    /// otherwise, in which case the row renders the plain `surfaceSecondary` fill
    /// with no tint overlaid.
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

// Internal, not private: `tabGroupSections(selectionStyle:)` takes it and is
// called from the layout roots in TabListView+Layouts.swift.
enum TabSelectionStyle {
    case navigation  // iPhone: NavigationLink(value:)
    case selection   // iPad: List(selection:) with .tag()
}
