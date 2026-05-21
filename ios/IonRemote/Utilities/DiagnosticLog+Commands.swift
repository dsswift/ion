import Foundation

// MARK: - Centralized Command Logging

extension DiagnosticLog {

    /// Log a structured one-liner for any outbound RemoteCommand.
    /// Called from `send()` before the command is dispatched to transport.
    static func logCommand(_ command: RemoteCommand) {
        switch command {
        case .sync:
            log("CMD: sync")

        case .createTab(let dir):
            log("CMD: createTab dir=\(dir?.suffix(30) ?? "nil")")

        case .createTerminalTab(let dir):
            log("CMD: createTerminalTab dir=\(dir?.suffix(30) ?? "nil")")

        case .closeTab(let tabId):
            log("CMD: closeTab tabId=\(tabId.prefix(8))")

        case .prompt(let tabId, let text, _, let clientMsgId, let attachments):
            log("CMD: prompt tabId=\(tabId.prefix(8)) len=\(text.count) msgId=\(clientMsgId?.prefix(8) ?? "nil") att=\(attachments?.count ?? 0)")

        case .cancel(let tabId):
            log("CMD: cancel tabId=\(tabId.prefix(8))")

        case .respondPermission(let tabId, let qId, let optId):
            log("CMD: respondPermission tabId=\(tabId.prefix(8)) qId=\(qId.prefix(8)) opt=\(optId)")

        case .setPermissionMode(let tabId, let mode):
            log("CMD: setPermissionMode tabId=\(tabId.prefix(8)) mode=\(mode.rawValue)")

        case .loadConversation(let tabId, let before):
            log("CMD: loadConversation tabId=\(tabId.prefix(8)) before=\(before?.prefix(8) ?? "nil")")

        case .terminalInput(let tabId, let instId, let data):
            log("CMD: terminalInput tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) len=\(data.count)")

        case .terminalResize(let tabId, let instId, let cols, let rows):
            log("CMD: terminalResize tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) \(cols)x\(rows)")

        case .terminalAddInstance(let tabId):
            log("CMD: terminalAddInstance tabId=\(tabId.prefix(8))")

        case .terminalRemoveInstance(let tabId, let instId):
            log("CMD: terminalRemoveInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))")

        case .terminalSelectInstance(let tabId, let instId):
            log("CMD: terminalSelectInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))")

        case .requestTerminalSnapshot(let tabId):
            log("CMD: requestTerminalSnapshot tabId=\(tabId.prefix(8))")

        case .renameTab(let tabId, let title):
            log("CMD: renameTab tabId=\(tabId.prefix(8)) title=\(title?.prefix(20) ?? "nil")")

        case .renameTerminalInstance(let tabId, let instId, let label):
            log("CMD: renameTerminalInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) label=\(label)")

        case .rewind(let tabId, let msgId):
            log("CMD: rewind tabId=\(tabId.prefix(8)) msgId=\(msgId.prefix(8))")

        case .forkFromMessage(let tabId, let msgId):
            log("CMD: forkFromMessage tabId=\(tabId.prefix(8)) msgId=\(msgId.prefix(8))")

        case .unpair:
            log("CMD: unpair")

        case .createEngineTab(let dir, let profileId):
            log("CMD: createEngineTab dir=\(dir?.suffix(30) ?? "nil") profile=\(profileId ?? "nil")")

        case .enginePrompt(let tabId, let text, let instId, let attachments):
            log("CMD: enginePrompt tabId=\(tabId.prefix(8)) len=\(text.count) inst=\(instId?.prefix(8) ?? "nil") att=\(attachments?.count ?? 0)")

        case .engineAbort(let tabId, let instId):
            log("CMD: engineAbort tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")")

        case .engineDialogResponse(let tabId, let dId, _, let instId):
            log("CMD: engineDialogResponse tabId=\(tabId.prefix(8)) dId=\(dId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")")

        case .engineAddInstance(let tabId):
            log("CMD: engineAddInstance tabId=\(tabId.prefix(8))")

        case .engineRemoveInstance(let tabId, let instId):
            log("CMD: engineRemoveInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))")

        case .engineRenameInstance(let tabId, let instId, let label):
            log("CMD: engineRenameInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) label=\(label)")

        case .engineSelectInstance(let tabId, let instId):
            log("CMD: engineSelectInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))")

        case .engineMoveInstance(let srcTabId, let instId, let tgtTabId):
            log("CMD: engineMoveInstance src=\(srcTabId.prefix(8)) inst=\(instId.prefix(8)) tgt=\(tgtTabId.prefix(8))")

        case .loadEngineConversation(let tabId, let instId):
            log("CMD: loadEngineConversation tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")")

        case .setTabGroupMode(let mode):
            log("CMD: setTabGroupMode mode=\(mode)")

        case .moveTabToGroup(let tabId, let gId):
            log("CMD: moveTabToGroup tabId=\(tabId.prefix(8)) group=\(gId.prefix(8))")

        case .engineSetModel(let tabId, let model, let instId):
            log("CMD: engineSetModel tabId=\(tabId.prefix(8)) model=\(model) inst=\(instId?.prefix(8) ?? "nil")")

        case .setTabModel(let tabId, let model):
            log("CMD: setTabModel tabId=\(tabId.prefix(8)) model=\(model)")

        case .setPreferredModel(let model):
            log("CMD: setPreferredModel model=\(model)")

        case .setEngineDefaultModel(let model):
            log("CMD: setEngineDefaultModel model=\(model)")

        case .gitChanges(let dir):
            log("CMD: gitChanges dir=\(dir.suffix(30))")

        case .gitGraph(let dir, _, _):
            log("CMD: gitGraph dir=\(dir.suffix(30))")

        case .gitDiff(let dir, let path, let staged):
            log("CMD: gitDiff dir=\(dir.suffix(30)) path=\(path.suffix(30)) staged=\(staged)")

        case .gitStage(let dir, let paths):
            log("CMD: gitStage dir=\(dir.suffix(30)) paths=\(paths.count)")

        case .gitUnstage(let dir, let paths):
            log("CMD: gitUnstage dir=\(dir.suffix(30)) paths=\(paths.count)")

        case .gitCommit(let dir, let msg):
            log("CMD: gitCommit dir=\(dir.suffix(30)) msg=\(msg.prefix(40))")

        case .gitDiscard(let dir, let paths):
            log("CMD: gitDiscard dir=\(dir.suffix(30)) paths=\(paths.count)")

        case .gitFetch(let dir):
            log("CMD: gitFetch dir=\(dir.suffix(30))")

        case .gitPull(let dir):
            log("CMD: gitPull dir=\(dir.suffix(30))")

        case .gitPush(let dir):
            log("CMD: gitPush dir=\(dir.suffix(30))")

        case .gitCommitFiles(let dir, let hash):
            log("CMD: gitCommitFiles dir=\(dir.suffix(30)) hash=\(hash.prefix(8))")

        case .gitCommitFileDiff(let dir, let hash, let path):
            log("CMD: gitCommitFileDiff dir=\(dir.suffix(30)) hash=\(hash.prefix(8)) path=\(path.suffix(30))")

        case .fsListDir(let dir, let hidden):
            log("CMD: fsListDir dir=\(dir.suffix(30)) hidden=\(hidden)")

        case .fsReadFile(let path):
            log("CMD: fsReadFile path=\(path.suffix(40))")

        case .fsReadImage(let path):
            log("CMD: fsReadImage path=\(path.suffix(40))")

        case .fsWriteFile(let path, let content):
            log("CMD: fsWriteFile path=\(path.suffix(40)) len=\(content.count)")

        case .discoverCommands(let dir):
            log("CMD: discoverCommands dir=\(dir.suffix(30))")

        case .uploadAttachment(_, let name, let corrId):
            log("CMD: uploadAttachment name=\(name) corrId=\(corrId.prefix(8))")

        case .loadAttachments(let tabId):
            log("CMD: loadAttachments tab=\(tabId.prefix(8))")

        case .voiceConfig(let enabled, let mode, _):
            log("CMD: voiceConfig enabled=\(enabled) mode=\(mode)")

        case .diagnosticLogsResponse(let logs, _, _):
            log("CMD: diagnosticLogsResponse len=\(logs.count)")

        case .reorderTabGroups(let orderedIds):
            log("CMD: reorderTabGroups count=\(orderedIds.count)")
        }
    }
}
