import SwiftUI

// Presentation modifiers for TabListView, extracted from its `body`.
//
// WHY THIS FILE EXISTS
//
// TabListView.body was one chain of seventeen top-level modifiers — sheets,
// confirmation dialogs, alerts, and observers — applied to a single Group.
// SwiftUI modifiers are generic, so each one wraps the previous view in
// another layer of type: the chain's static type grew with every link until
// the Swift type checker gave up on it entirely and the build failed with
// "unable to type-check this expression in reasonable time" at the `body`
// declaration.
//
// The fix is to break the chain into named groups, each returning `some View`.
// An opaque return type is a type-checking barrier: the compiler solves one
// group, erases the result to `some View`, and starts the next group fresh
// rather than carrying the accumulated generic type forward. Three groups keep
// each solvable, and the split is along real seams rather than arbitrary
// counts — inbox surfaces, lifecycle observers, and conversation creation.
//
// Behavior is unchanged: the groups are applied in the same order the chain
// had, so presentation precedence and modifier semantics are identical.
extension TabListView {
    /// Settings, notifications, and every inbox-triggered surface: the delete
    /// confirmation, the snooze preset picker, inline rename, and the settled
    /// history shelf.
    @ViewBuilder
    func inboxSurfaces<V: View>(_ content: V) -> some View {
        content
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .sheet(isPresented: $showNotifications) {
                NotificationsView(resourceStore: viewModel.resourceStore, viewModel: viewModel)
            }
            .confirmationDialog(
                "Delete conversation?",
                isPresented: Binding(
                    get: { pendingInboxDeleteTab != nil },
                    set: { if !$0 { pendingInboxDeleteTab = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let tab = pendingInboxDeleteTab,
                   tab.inboxState != "settled",
                   !viewModel.settlingIsPermanent(tab) {
                    Button("Settle Conversation") {
                        DiagnosticLog.log("conversation delete replaced with settlement", tag: "inbox", level: .info, fields: ["tab_id": tab.id])
                        viewModel.settleTab(tabId: tab.id)
                        pendingInboxDeleteTab = nil
                    }
                }
                if let tab = pendingInboxDeleteTab {
                    Button("Delete Conversation", role: .destructive) {
                        DiagnosticLog.log("conversation permanent deletion confirmed", tag: "inbox", level: .info, fields: ["tab_id": tab.id])
                        viewModel.deleteTab(tabId: tab.id)
                        pendingInboxDeleteTab = nil
                    }
                }
                Button("Cancel", role: .cancel) {
                    if let tab = pendingInboxDeleteTab {
                        DiagnosticLog.log("conversation permanent deletion cancelled", tag: "inbox", level: .info, fields: ["tab_id": tab.id])
                    }
                    pendingInboxDeleteTab = nil
                }
            } message: {
                Text("This permanently deletes the stored conversation. Settle keeps it in history so you can return to it later.")
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
    }

    /// Persistence of inbox expansion state, git-info refresh triggers, and the
    /// pairing sheet. Observers rather than presentations, apart from pairing.
    @ViewBuilder
    func listLifecycle<V: View>(_ content: V) -> some View {
        content
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
    }

    /// The new-conversation flow: the new-tab sheet plus every dialog it can
    /// route into (branch picker, profile picker), and the two conversation
    /// alerts that close it out (rename, close warning).
    @ViewBuilder
    func conversationCreation<V: View>(_ content: V) -> some View {
        content
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
                    onCreateWorktreeConversation: { repoPath, sourceBranch in
                        viewModel.createTab(workingDirectory: repoPath, useWorktree: true, sourceBranch: sourceBranch)
                    },
                    onCreateTerminalTab: { dir in
                        viewModel.createTerminalTab(workingDirectory: dir)
                    }
                )
            }
            .confirmationDialog(
                "Choose source branch",
                isPresented: Binding(get: { viewModel.pendingBranchPickerRepo != nil }, set: { if !$0 { viewModel.pendingBranchPickerRepo = nil } }),
                titleVisibility: .visible
            ) {
                if let repo = viewModel.pendingBranchPickerRepo,
                   let branches = viewModel.gitBranches[repo]?.branches {
                    ForEach(branches, id: \.self) { branch in
                        Button(branch) {
                            viewModel.pendingBranchPickerRepo = nil
                            viewModel.createTab(workingDirectory: repo, useWorktree: true, sourceBranch: branch)
                        }
                    }
                }
                Button("Cancel", role: .cancel) { viewModel.pendingBranchPickerRepo = nil }
            }
            // returns `.showPicker` — i.e. multiple profiles exist and no default is set.
            // Includes "Plain conversation" at top (matches desktop picker behaviour).
            .confirmationDialog(
                "New Conversation",
                isPresented: Binding(
                    get: { conversationPickerDirectory != nil },
                    set: { if !$0 {
                        conversationPickerDirectory = nil
                        conversationPickerPinToGroupId = nil
                        conversationPickerUseWorktree = nil
                        conversationPickerSourceBranch = nil
                    } }
                ),
                titleVisibility: .visible
            ) {
                // Plain conversation option — always first (mirrors desktop picker).
                Button("Plain conversation") {
                    let dir = conversationPickerDirectory
                    let pin = conversationPickerPinToGroupId
                    let useWorktree = conversationPickerUseWorktree
                    let sourceBranch = conversationPickerSourceBranch
                    conversationPickerDirectory = nil
                    conversationPickerPinToGroupId = nil
                    conversationPickerUseWorktree = nil
                    conversationPickerSourceBranch = nil
                    DiagnosticLog.log("new conv picker selected plain", tag: "view.tablist", fields: [
                        "path": dir?.prefix(40).description ?? "nil"
                    ])
                    viewModel.createTab(workingDirectory: dir, pinToGroupId: pin, useWorktree: useWorktree, sourceBranch: sourceBranch)
                }
                // Engine profiles.
                ForEach(viewModel.engineProfiles) { profile in
                    Button(profile.name) {
                        let dir = conversationPickerDirectory
                        let pin = conversationPickerPinToGroupId
                        let useWorktree = conversationPickerUseWorktree
                        let sourceBranch = conversationPickerSourceBranch
                        conversationPickerDirectory = nil
                        conversationPickerPinToGroupId = nil
                        conversationPickerUseWorktree = nil
                        conversationPickerSourceBranch = nil
                        DiagnosticLog.log("new conv picker selected profile", tag: "view.tablist", fields: [
                            "reason": String(profile.id.prefix(8)),
                            "path": dir?.prefix(40).description ?? "nil"
                        ])
                        viewModel.createTab(workingDirectory: dir, pinToGroupId: pin, profileId: profile.id, useWorktree: useWorktree, sourceBranch: sourceBranch)
                    }
                }
                Button("Cancel", role: .cancel) {
                    conversationPickerDirectory = nil
                    conversationPickerPinToGroupId = nil
                    conversationPickerUseWorktree = nil
                    conversationPickerSourceBranch = nil
                }
            }
    }

    /// The two alerts that close out a conversation row: rename, and the
    /// close-confirmation raised only when a worktree conversation still holds
    /// work. Split from `conversationCreation` because the creation flow plus
    /// these alerts together re-crossed the type checker's limit.
    @ViewBuilder
    func conversationAlerts<V: View>(_ content: V) -> some View {
        content
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
}
