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

    /// Handle "New Conversation" via the smart routing state machine.
    /// Mirrors `resolveNewConversationAction` from desktop's
    /// new-conversation-routing.ts. All conversation creation paths
    /// (toolbar +, sheet row, group header context menu) funnel here.
    ///
    /// Enterprise-locked state (State 0): `enterpriseNewConversationPolicy` is now
    /// populated from `desktop_settings_snapshot.newConversationPolicy` (#256).
    /// When the desktop projects a locked policy, iOS enforces it here.
    func requestNewConversation(directory: String?, pinToGroupId: String?) {
        // Convert RemoteNewConversationPolicy -> NewConversationDefaultsPolicy for the pure router.
        let policy: NewConversationDefaultsPolicy? = viewModel.enterpriseNewConversationPolicy.map {
            NewConversationDefaultsPolicy(locked: $0.locked, baseDirectory: $0.baseDirectory, profileId: $0.engineProfileId)
        }
        let action = resolveNewConversationAction(
            profiles: viewModel.engineProfiles,
            defaultId: viewModel.defaultEngineProfileId,
            enterprisePolicy: policy
        )
        DiagnosticLog.log("new conv action", tag: "view.tablist", fields: [
            "reason": String(describing: action),
            "path": directory?.prefix(40).description ?? "nil",
            "status": pinToGroupId ?? "nil"
        ])
        switch action {
        case .plain:
            viewModel.createTab(workingDirectory: directory, pinToGroupId: pinToGroupId)
        case .profile(let profileId):
            viewModel.createTab(workingDirectory: directory, pinToGroupId: pinToGroupId, profileId: profileId)
        case .showPicker:
            conversationPickerDirectory = directory
            conversationPickerPinToGroupId = pinToGroupId
        case .locked(let mandatedDir, let profileId):
            // Enterprise-locked: use mandated dir, ignore caller's directory.
            let dir = mandatedDir.isEmpty ? directory : mandatedDir
            if profileId.isEmpty {
                viewModel.createTab(workingDirectory: dir)
            } else {
                viewModel.createTab(workingDirectory: dir, profileId: profileId)
            }
        }
    }

    /// Ordered list of directories: default base directory first, then recent directories (deduplicated).
    var allDirectories: [(label: String, fullPath: String)] {
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

    func directoryLabel(_ path: String) -> String {
        let base = (path as NSString).lastPathComponent
        if base.isEmpty || path == "/" || path == "~" {
            return "Home"
        }
        return base
    }
}
