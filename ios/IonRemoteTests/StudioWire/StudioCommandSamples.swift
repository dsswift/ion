import Foundation
import XCTest
@testable import IonRemote

/// One value of every `RemoteCommand`, so a test can put each through the
/// Studio-wire table. The list is checked for completeness against
/// `RemoteCommand.TypeKey.allCases`, so a command added without a sample here
/// fails rather than going unchecked.
enum StudioCommandSamples {

    private static let samplePatch = QuestionsPatch(
        workflowId: "w", requestId: "r", expectedRevision: 1, actionId: "a", answers: nil, comment: nil)

    private static let sampleAction = QuestionsAction(
        workflowId: "w", requestId: "r", expectedRevision: 1, actionId: "a", kind: "cancel",
        questionId: nil, answers: nil, comment: nil)

    /// The `desktop_*` name of a command, derived from the command itself
    /// rather than from a second table in this file.
    ///
    /// `RemoteCommand` no longer encodes itself — the `desktop_*` wire is gone
    /// and the Studio wire carries actions, not commands — so the name comes
    /// from the case name instead: every `TypeKey` rawValue is
    /// `desktop_` + the snake_case of its case, and its case is spelled the
    /// same as the `RemoteCommand` case it names. Deriving it this way means a
    /// sample cannot be paired with the wrong name.
    static func wireName(of command: RemoteCommand) throws -> String {
        let name = command.kindName
        // The one case whose TypeKey is not the snake_case of its own name:
        // `desktopAuth` is `desktop_auth`, not `desktop_desktop_auth`.
        let snake = name == "desktopAuth" ? "auth" : name.reduce(into: "") { out, char in
            if char.isUppercase {
                out.append("_")
                out.append(Character(char.lowercased()))
            } else {
                out.append(char)
            }
        }
        guard let key = RemoteCommand.TypeKey(rawValue: "desktop_\(snake)") else {
            throw StudioCommandSampleError.noTypeKey(name)
        }
        return key.rawValue
    }

    static let all: [RemoteCommand] = [
        .sync,
        .createTab(workingDirectory: "s", profileId: "s", extensions: ["s"], clientCmdId: "s", useWorktree: true, sourceBranch: "s"),
        .createTerminalTab(workingDirectory: "s", clientCmdId: "s"),
        .closeTab(tabId: "s"),
        .resetTabSession(tabId: "s"),
        .resetEngineSession(tabId: "s", instanceId: "s"),
        .prompt(tabId: "s", text: "s", origin: "s", clientMsgId: "s", attachments: [CommandAttachment(type: "file", name: "n", path: "/p", contentHash: nil)], implementationPhase: true, instanceId: "s"),
        .cancel(tabId: "s", scope: "s"),
        .abortDispatch(tabId: "s", dispatchId: "s"),
        .stopBackgroundTask(tabId: "s", taskId: "s", requestId: "s"),
        .respondPermission(tabId: "s", questionId: "s", optionId: "s"),
        .respondElicitation(tabId: "s", requestId: "s", response: ["k": AnyCodable("s")], cancelled: true, declined: true),
        .setPermissionMode(tabId: "s", mode: .auto),
        .setDraft(tabId: "s", text: "s"),
        .systemMetricsWatch(on: true),
        .setThinkingEffort(tabId: "s", effort: "s"),
        .tabSettle(tabId: "s"),
        .tabDelete(tabId: "s"),
        .tabUnsettle(tabId: "s"),
        .tabSnooze(tabId: "s", untilMs: 1),
        .tabUnsnooze(tabId: "s"),
        .tabResumeAtReset(tabId: "s"),
        .tabSnoozeUntilReset(tabId: "s"),
        .tabQueueSpareQuota(tabId: "s", text: "s"),
        .tabCancelHeldPrompt(tabId: "s"),
        .tabSendHeldPrompt(tabId: "s"),
        .tabMarkUnread(tabId: "s"),
        .tabPin(tabId: "s"),
        .tabUnpin(tabId: "s"),
        .tabReorderPin(assignments: [PinOrderAssignment(tabId: "s", orderKey: "a")]),
        .tabRegenerateTitle(tabId: "s"),
        .requestTranscript(tabId: "s", requestId: "s"),
        .reviewSettledTab(tabId: "s"),
        .loadConversation(tabId: "s", before: "s", pageSize: 1),
        .requestResend(fromSeq: 1, toSeq: 1),
        .terminalInput(tabId: "s", instanceId: "s", data: "s"),
        .terminalResize(tabId: "s", instanceId: "s", cols: 1, rows: 1),
        .terminalAddInstance(tabId: "s"),
        .terminalRemoveInstance(tabId: "s", instanceId: "s"),
        .terminalSelectInstance(tabId: "s", instanceId: "s"),
        .requestTerminalSnapshot(tabId: "s"),
        .openTerminalApplication(tabId: "s", url: "s"),
        .requestAgentState(tabId: "s", instanceId: "s"),
        .requestContextBreakdown(tabId: "s"),
        .renameTab(tabId: "s", customTitle: "s"),
        .renameTerminalInstance(tabId: "s", instanceId: "s", label: "s"),
        .forkFromMessage(tabId: "s", messageId: "s"),
        .engineRewind(tabId: "s", instanceId: "s", messageId: "s", userTurnIndex: 1),
        .unpair,
        .desktopAuth(token: "s"),
        .engineAbort(tabId: "s", instanceId: "s"),
        .engineDialogResponse(tabId: "s", dialogId: "s", value: "s", instanceId: "s"),
        .loadDispatchTranscript(tabId: "s", conversationId: "s", dispatchId: "s", before: nil, pageSize: 1),
        .engineSetModel(tabId: "s", model: "s", instanceId: "s"),
        .setTabModel(tabId: "s", model: "s", providerId: "s"),
        .declarePreferences(preferences: ["aiGeneratedTitles": .bool(true)]),
        .registerPush(token: "s", env: "sandbox"),
        .gitChanges(directory: "s"),
        .gitBranches(directory: "s"),
        .gitGraph(directory: "s", skip: 1, limit: 1),
        .gitDiff(directory: "s", path: "s", staged: true),
        .gitStage(directory: "s", paths: ["s"]),
        .gitUnstage(directory: "s", paths: ["s"]),
        .gitCommit(directory: "s", message: "s"),
        .gitDiscard(directory: "s", paths: ["s"]),
        .gitFetch(directory: "s"),
        .gitPull(directory: "s"),
        .gitPush(directory: "s"),
        .gitCommitFiles(directory: "s", hash: "s"),
        .gitCommitFileDiff(directory: "s", hash: "s", path: "s"),
        .worktreeRefresh(repoPath: "s"),
        .worktreeOpenConversation(worktreePath: "s", newConversation: true),
        .worktreeSync(worktreePath: "s", sourceBranch: "s", repoPath: "s"),
        .worktreeSyncAll(repoPath: "s"),
        .worktreeLandAndRetire(repoPath: "s", worktreePath: "s", worktreeBranch: "s", sourceBranch: "s"),
        .benchOpenConversation(repoPath: "s", sourceBranch: "s"),
        .benchOpenTerminal(repoPath: "s", sourceBranch: "s"),
        .benchAssemble(repoPath: "s", sourceBranch: "s"),
        .benchUpdateMember(repoPath: "s", sourceBranch: "s", worktreePath: "s"),
        .benchUpdateAll(repoPath: "s", sourceBranch: "s"),
        .worktreeSetStage(repoPath: "s", worktreePath: "s", stage: "s"),
        .benchReorderMember(repoPath: "s", sourceBranch: "s", worktreePath: "s", toIndex: 1),
        .benchAddMember(repoPath: "s", sourceBranch: "s", worktreePath: "s", branchName: "s"),
        .benchRemoveMember(repoPath: "s", sourceBranch: "s", worktreePath: "s"),
        .worktreeRetireLanded(repoPath: "s"),
        .worktreeCreate(repoPath: "s", sourceBranch: "s"),
        .worktreeConvertConversation(tabId: "s"),
        .worktreeRename(repoPath: "s", worktreePath: "s", title: "s"),
        .worktreeReprovision(repoPath: "s", worktreePath: "s"),
        .benchRecoverConflict(repoPath: "s", sourceBranch: "s"),
        .benchAnalyseVerification(repoPath: "s", sourceBranch: "s"),
        .benchDiscardMemberRecordings(repoPath: "s", sourceBranch: "s", branchNames: ["s"]),
        .benchDiscardAllRecordings(repoPath: "s", sourceBranch: "s"),
        .worktreeRetire(repoPath: "s", worktreePath: "s", branchName: "s"),
        .worktreeConflictAssist(repoPath: "s", worktreePath: "s"),
        .benchConflictAssist(repoPath: "s", sourceBranch: "s"),
        .worktreePipelineStart(repoPath: "s", sourceBranch: "s"),
        .worktreePipelineConfirmAi(repoPath: "s"),
        .worktreePipelineCancel(repoPath: "s"),
        .worktreePipelineDismiss(repoPath: "s"),
        .fsListDir(directory: "s", includeHidden: true),
        .fsReadFile(filePath: "s"),
        .fsReadImage(filePath: "s"),
        .requestThemeAsset(themeId: "s", slot: "s"),
        .fsWriteFile(filePath: "s", content: "s"),
        .fsRename(oldPath: "s", newPath: "s"),
        .discoverCommands(directory: "s"),
        .uploadAttachment(dataUrl: "s", name: "s", correlationId: "s"),
        .loadAttachments(tabId: "s"),
        .listBranches(tabId: "s"),
        .switchBranch(tabId: "s", leafId: "l"),
        .voiceConfig(enabled: true, mode: "s", systemPrompt: "s"),
        .diagnosticLogsResponse(logs: "s", pairingId: "s", nextSeq: 1, withheldUnstamped: 1, withheldOtherPairing: 1),
        .setRemoteDisplay(customName: "s", customIcon: "s", updatedAt: .init(timeIntervalSince1970: 1)),
        .setDesktopSetting(key: "s", value: AnyCodable("s")),
        .setPillColor(tabId: "s", pillColor: "s"),
        .reportFocus(tabId: "s", interceptEnabled: true),
        .reportMobileAuth(accountUsername: "s", accountName: "s", subject: "s", tenantId: "s", signedInAt: .init(timeIntervalSince1970: 1), clearIdentity: true, accessStatus: "s", accessReason: "s", reportedAt: .init(timeIntervalSince1970: 1)),
        .requestResourceContent(kind: "s", producer: "s", resourceId: "s"),
        .markResourceRead(kind: "s", producer: "s", resourceId: "s"),
        .deleteResource(kind: "s", producer: "s", resourceId: "s"),
        .implementPlan(tabId: "s", questionId: "s", instanceId: "s", clearContext: true),
        .requestPlanContent(tabId: "s", questionId: "s", planFilePath: "s", offset: 1, length: 1),
        .questionsPatch(tabId: "s", patch: samplePatch),
        .questionsAction(tabId: "s", action: sampleAction),
        .questionsRefresh(tabId: "s"),        // A second value of the one command whose branch is chosen by an
        // argument rather than by its case.
        .worktreeOpenConversation(worktreePath: "s", newConversation: false),
    ]
}

enum StudioCommandSampleError: Error {
    /// A sample whose case name does not spell a known `TypeKey`.
    case noTypeKey(String)
}
