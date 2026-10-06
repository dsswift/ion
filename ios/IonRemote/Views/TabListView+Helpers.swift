import SwiftUI

// TabListView helpers extracted to keep TabListView.swift under the Swift
// 600-line cap (see ios/AGENTS.md → file-architecture rules). These are the
// new-conversation routing and directory-list helpers — moved verbatim from
// TabListView. The `@State` properties they read (conversationPicker*)
// are declared internal (not private) on TabListView so this same-module
// extension can reach them.
extension TabListView {
    /// Create a conversation from a desktop-owned project.
    ///
    /// The project action is authoritative. iOS does not apply a local default
    /// directory or profile preference before it sends the create command.
    func requestNewConversation(project: RemoteProject, useWorktree: Bool? = nil, sourceBranch: String? = nil) {
        let action = resolveNewConversationAction(for: project)
        DiagnosticLog.log("new conversation project action", tag: "view.tablist", fields: [
            "directory": project.directory,
            "action": project.profileAction,
            "managed": String(project.managed)
        ])
        switch action {
        case .plain:
            viewModel.createTab(workingDirectory: project.directory, useWorktree: useWorktree, sourceBranch: sourceBranch)
        case .profile(let profileId):
            viewModel.createTab(workingDirectory: project.directory, profileId: profileId, useWorktree: useWorktree, sourceBranch: sourceBranch)
        case .showPicker:
            conversationPickerProject = project
            conversationPickerUseWorktree = useWorktree
            conversationPickerSourceBranch = sourceBranch
        case .locked:
            // Project actions are desktop-resolved. This branch cannot occur.
            return
        }
    }

    /// Where a worktree conversation for `projectDirectory` is cut: the
    /// enterprise-locked base directory when policy sets one, else the project.
    func worktreeRepoPath(for projectDirectory: String) -> String {
        if let policy = viewModel.enterpriseNewConversationPolicy, policy.locked, !policy.baseDirectory.isEmpty {
            return policy.baseDirectory
        }
        return projectDirectory
    }

    /// Open the worktree branch chooser for `repoPath` and ask for its branches.
    func chooseWorktreeBranch(repoPath: String) {
        DiagnosticLog.log("worktree branch chooser opened", tag: "view.inbox", fields: ["repo_path": repoPath])
        viewModel.pendingBranchPickerRepo = repoPath
        viewModel.requestGitBranches(directory: repoPath)
    }

    /// Lookup bridge for inbox entry points that still identify a project by
    /// directory. They never synthesize a local directory default.
    func requestNewConversation(directory: String) {
        guard let project = viewModel.projects.first(where: { $0.directory == directory }) else {
            DiagnosticLog.log("new conversation project unavailable", tag: "view.tablist", level: .warn, fields: [
                "directory": directory
            ])
            return
        }
        requestNewConversation(project: project)
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

    /// The connected server, for New Project: the conversation it opens has
    /// to land on the server the app is showing.
    var newProjectAdminSession: ServerAdminSession? {
        guard let device = viewModel.activeDevice else { return nil }
        return viewModel.adminSession(for: device)
    }
}
