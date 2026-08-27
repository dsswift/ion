import SwiftUI

// TabListView helpers extracted to keep TabListView.swift under the Swift
// 600-line cap (see ios/AGENTS.md → file-architecture rules). These are the
// search-filter, collapsed-group persistence, new-conversation routing, and
// directory-list helpers — moved verbatim from TabListView. The `@State`
// properties they read (searchText, collapsedGroupIds, conversationPicker*)
// are declared internal (not private) on TabListView so this same-module
// extension can reach them.
extension TabListView {
    var filteredDisplayGroups: [(label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return viewModel.displayGroups }

        return viewModel.displayGroups.compactMap { group in
            let matchingTabs = group.tabs.filter { tab in
                return TabSearchHelper.matches(
                    tab: tab,
                    query: query,
                    messages: viewModel.conversationMessages(tab.id),
                    attachments: viewModel.tabAttachmentCache[tab.id]
                )
            }
            guard !matchingTabs.isEmpty else { return nil }
            return (label: group.label, id: group.id, icon: group.icon, directory: group.directory, tabs: matchingTabs)
        }
    }

    /// Toggle a group's collapsed state and persist to UserDefaults.
    func toggleGroupCollapsed(_ groupId: String) {
        if collapsedGroupIds.contains(groupId) {
            collapsedGroupIds.remove(groupId)
        } else {
            collapsedGroupIds.insert(groupId)
        }
        persistCollapsedGroups()
    }

    func persistCollapsedGroups() {
        UserDefaults.standard.set(Array(collapsedGroupIds), forKey: "collapsedGroupIds")
    }

    /// Create a conversation from a desktop-owned project.
    ///
    /// The project action is authoritative. iOS does not apply a local default
    /// directory or profile preference before it sends the create command.
    func requestNewConversation(project: RemoteProject, pinToGroupId: String?, useWorktree: Bool? = nil, sourceBranch: String? = nil) {
        let action = resolveNewConversationAction(for: project)
        DiagnosticLog.log("new conversation project action", tag: "view.tablist", fields: [
            "directory": project.directory,
            "action": project.profileAction,
            "managed": String(project.managed)
        ])
        switch action {
        case .plain:
            viewModel.createTab(workingDirectory: project.directory, pinToGroupId: pinToGroupId, useWorktree: useWorktree, sourceBranch: sourceBranch)
        case .profile(let profileId):
            viewModel.createTab(workingDirectory: project.directory, pinToGroupId: pinToGroupId, profileId: profileId, useWorktree: useWorktree, sourceBranch: sourceBranch)
        case .showPicker:
            conversationPickerProject = project
            conversationPickerPinToGroupId = pinToGroupId
            conversationPickerUseWorktree = useWorktree
            conversationPickerSourceBranch = sourceBranch
        case .locked:
            // Project actions are desktop-resolved. This branch cannot occur.
            return
        }
    }

    /// Lookup bridge for group and inbox entry points that still identify a
    /// project by directory. They never synthesize a local directory default.
    func requestNewConversation(directory: String, pinToGroupId: String?) {
        guard let project = viewModel.projects.first(where: { $0.directory == directory }) else {
            DiagnosticLog.log("new conversation project unavailable", tag: "view.tablist", level: .warn, fields: [
                "directory": directory
            ])
            return
        }
        requestNewConversation(project: project, pinToGroupId: pinToGroupId)
    }

    /// The default desktop project, if the snapshot names one.
    var defaultProject: RemoteProject? {
        viewModel.projects.first(where: \.isDefault)
    }

    func directoryLabel(_ path: String) -> String {
        let base = (path as NSString).lastPathComponent
        if base.isEmpty || path == "/" || path == "~" {
            return "Home"
        }
        return base
    }
}
