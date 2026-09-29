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
    // Pending new-conversation request from TabListNewTabSheet. Stored here
    // so `requestNewConversation` fires in `onDismiss` — after the sheet
    // animation completes — rather than mid-animation. SwiftUI silently drops
    // a confirmationDialog that is presented while a sheet is still animating
    // out, which caused the "Plain conversation" tap to appear to do nothing.
    // Internal (not private): the sheet and its onDismiss drain live in
    // TabListView+Presentation.swift.
    @State var pendingNewConversationProject: RemoteProject? = nil
    // Internal (not private): the ServerPickerMenu in TabListView+Layouts'
    // toolbars binds to it.
    @State var showPairingSheet = false
    // When non-nil, the new-conversation profile picker is shown.
    // Holds the target project for tab creation.
    // These three are read by the TabListView+Helpers.swift extension, so they
    // are internal (not private — private is file-scoped and the extension
    // lives in another file).
    @State var conversationPickerProject: RemoteProject? = nil
    @State var conversationPickerUseWorktree: Bool? = nil
    @State var conversationPickerSourceBranch: String? = nil
    // Internal: the Rename Tab alert lives in the conversation-creation
    // presentation group (TabListView+Presentation.swift).
    @State var renamingTabId: String?
    @State var renameText: String = ""
    /// A close held for confirmation because the tab's worktree still holds work.
    /// Nil for every uneventful close, which proceeds without a prompt.
    /// Internal so the +Inbox extension's requestCloseTab path shares the gate.
    @State var pendingCloseWarning: PendingCloseWarning?
    @State var searchText: String = ""

    // Inbox shelf UI state (internal: the +Inbox extension reads these).
    @State var activeInboxExpansion: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "inboxActiveExpansion") ?? [])
    @State var snoozedInboxExpansion: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "inboxSnoozedExpansion") ?? [])
    @State var settledShelfCollapsed = UserDefaults.standard.object(forKey: "inboxSettledShelfCollapsed") as? Bool ?? true
    @State var settledShown = 15
    @State var inboxProjectFilter = UserDefaults.standard.string(forKey: "inboxProjectFilter") ?? "all"
    @State var inboxSort = InboxNavigator.Sort(rawValue: UserDefaults.standard.string(forKey: "inboxSort") ?? "recent") ?? .recent
    @State var showSettledHistory = false
    /// Inbox conversation awaiting the settle/delete/cancel safety choice.
    @State var pendingInboxDeleteTab: RemoteTabState?
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

    // The presentation modifiers live in TabListView+Presentation.swift, applied
    // here in three groups. Splitting them is not cosmetic: as one chain they
    // exceeded what the Swift type checker would solve and the build failed at
    // this declaration. Each group returns `some View`, which erases the
    // accumulated generic type and lets the next group start fresh. Order is
    // preserved from the original chain, so presentation behavior is unchanged.
    var body: some View {
        conversationAlerts(
            conversationCreation(
                listLifecycle(
                    inboxSurfaces(
                        Group {
                            if sizeClass == .regular {
                                iPadLayout
                            } else {
                                iPhoneLayout
                            }
                        }
                    )
                )
            )
        )
    }

    // MARK: - Sidebar Content

    // Internal (not private): consumed by iPadLayout in TabListView+Layouts.
    var sidebarContent: some View {
        VStack(spacing: 0) {
            // Device picker + connection quality always visible in sidebar
            HStack(spacing: 8) {
                ServerPickerMenu(showPairingSheet: $showPairingSheet)
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

    // MARK: - Sections

    /// The Inbox is the one conversation list. Both layout roots render THIS.
    @ViewBuilder
    func tabSections(selectionStyle: TabSelectionStyle) -> some View {
        inboxControls
            // Ride the same cached crawl the desktop panels use so the
            // hierarchy renders from fresh state the moment the inbox
            // appears, instead of waiting out the snapshot interval.
            .onAppear { viewModel.refreshAllWorktrees() }
        inboxSections(selectionStyle: selectionStyle)
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

    // newTabSheet was extracted to TabListNewTabSheet.swift, and the
    // new-conversation routing and directory-list helpers to
    // TabListView+Helpers.swift, to keep this file under the Swift 600-line cap.
}

// MARK: - Tab Selection Style

// Internal, not private: `tabSections(selectionStyle:)` takes it and is
// called from the layout roots in TabListView+Layouts.swift.
enum TabSelectionStyle {
    case navigation  // iPhone: NavigationLink(value:)
    case selection   // iPad: List(selection:) with .tag()
}
