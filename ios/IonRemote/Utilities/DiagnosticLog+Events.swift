import Foundation

// MARK: - Centralized Event Logging

extension DiagnosticLog {

    /// Log a structured one-liner for any inbound RemoteEvent.
    /// Called from `handleEvent()` to replace the old `print("[Ion] handleEvent:")`.
    /// Heartbeats are skipped (too noisy).
    static func logEvent(_ event: RemoteEvent) {
        switch event {
        case .heartbeat:
            return // skip — fires every few seconds

        case .snapshot(let tabs, let dirs, let groupMode, _, _, _):
            log("EVENT: snapshot tabs=\(tabs.count) dirs=\(dirs.count) groupMode=\(groupMode ?? "nil")")

        case .tabCreated(let tab):
            log("EVENT: tabCreated id=\(tab.id.prefix(8)) title=\(tab.title.prefix(30))")

        case .tabClosed(let tabId):
            log("EVENT: tabClosed id=\(tabId.prefix(8))")

        case .tabStatus(let tabId, let status):
            log("EVENT: tabStatus id=\(tabId.prefix(8)) status=\(status.rawValue)")

        case .textChunk(let tabId, let text):
            log("EVENT: textChunk tabId=\(tabId.prefix(8)) len=\(text.count)")

        case .toolCall(let tabId, let toolName, let toolId):
            log("EVENT: toolCall tabId=\(tabId.prefix(8)) tool=\(toolName) toolId=\(toolId.prefix(8))")

        case .toolResult(let tabId, let toolId, let content, let isError):
            log("EVENT: toolResult tabId=\(tabId.prefix(8)) toolId=\(toolId.prefix(8)) err=\(isError) len=\(content.count)")

        case .taskComplete(let tabId, _, let costUsd):
            log("EVENT: taskComplete tabId=\(tabId.prefix(8)) cost=\(costUsd)")

        case .permissionRequest(let tabId, let qId, let toolName, _, let options):
            log("EVENT: permissionRequest tabId=\(tabId.prefix(8)) qId=\(qId.prefix(8)) tool=\(toolName) opts=\(options.count)")

        case .permissionResolved(let tabId, let qId):
            log("EVENT: permissionResolved tabId=\(tabId.prefix(8)) qId=\(qId.prefix(8))")

        case .conversationHistory(let tabId, let msgs, let hasMore, _):
            log("EVENT: conversationHistory tabId=\(tabId.prefix(8)) msgs=\(msgs.count) hasMore=\(hasMore)")

        case .messageAdded(let tabId, let msg):
            log("EVENT: messageAdded tabId=\(tabId.prefix(8)) role=\(msg.role.rawValue) len=\(msg.content.count)")

        case .messageUpdated(let tabId, let msgId, _, let toolStatus, _):
            log("EVENT: messageUpdated tabId=\(tabId.prefix(8)) msgId=\(msgId.prefix(8)) toolStatus=\(toolStatus?.rawValue ?? "nil")")

        case .queueUpdate(let tabId, let prompts):
            log("EVENT: queueUpdate tabId=\(tabId.prefix(8)) queued=\(prompts.count)")

        case .error(let tabId, let message):
            log("ERR: event tabId=\(tabId.prefix(8)) msg=\(message.prefix(80))")

        case .unpair:
            log("EVENT: unpair")

        case .relayConfig:
            log("EVENT: relayConfig")

        case .peerDisconnected:
            log("EVENT: peerDisconnected")

        case .transportReconnecting:
            log("EVENT: transportReconnecting")

        case .inputPrefill(let tabId, let text, let switchTo):
            log("EVENT: inputPrefill tabId=\(tabId.prefix(8)) len=\(text.count) switchTo=\(switchTo)")

        case .terminalOutput(let tabId, let instId, let data):
            log("EVENT: terminalOutput tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) len=\(data.count)")

        case .terminalExit(let tabId, let instId, let exitCode):
            log("EVENT: terminalExit tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) code=\(exitCode)")

        case .terminalInstanceAdded(let tabId, let inst):
            log("EVENT: terminalInstanceAdded tabId=\(tabId.prefix(8)) inst=\(inst.id.prefix(8))")

        case .terminalInstanceRemoved(let tabId, let instId):
            log("EVENT: terminalInstanceRemoved tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))")

        case .terminalSnapshot(let tabId, let insts, _, _):
            log("EVENT: terminalSnapshot tabId=\(tabId.prefix(8)) instances=\(insts.count)")

        case .engineAgentState(let tabId, let instId, let agents):
            log("EVENT: engineAgentState tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") agents=\(agents.count)")

        case .engineStatus(let tabId, let instId, _):
            log("EVENT: engineStatus tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")")

        case .engineWorkingMessage(let tabId, let instId, _):
            log("EVENT: engineWorkingMessage tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")")

        case .engineToolStart(let tabId, let instId, let toolName, let toolId):
            log("EVENT: engineToolStart tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tool=\(toolName) toolId=\(toolId.prefix(8))")

        case .engineToolEnd(let tabId, let instId, let toolId, _, let isError):
            log("EVENT: engineToolEnd tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") toolId=\(toolId.prefix(8)) err=\(isError)")

        case .engineToolStalled(let tabId, let instId, let toolId, let toolName, _):
            log("EVENT: engineToolStalled tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tool=\(toolName) toolId=\(toolId.prefix(8))")

        case .engineError(let tabId, let instId, let msg):
            log("ERR: engine tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") msg=\(msg.prefix(80))")

        case .engineNotify(let tabId, let instId, let msg, let level):
            log("EVENT: engineNotify tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") level=\(level) msg=\(msg.prefix(60))")

        case .engineDialog(let tabId, let instId, let dId, let method, _, _, _):
            log("EVENT: engineDialog tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") dId=\(dId.prefix(8)) method=\(method)")

        case .engineDialogResolved(let tabId, let instId, let dId):
            log("EVENT: engineDialogResolved tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") dId=\(dId.prefix(8))")

        case .engineTextDelta(let tabId, let instId, let text):
            log("EVENT: engineTextDelta tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") len=\(text.count)")

        case .engineMessageEnd(let tabId, let instId, let inTok, _, let ctxPct, _):
            log("EVENT: engineMessageEnd tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tokens=\(inTok) ctx=\(String(format: "%.0f", ctxPct))%")

        case .engineDead(let tabId, let instId, let exitCode, let signal, _):
            log("EVENT: engineDead tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") exit=\(exitCode ?? -1) sig=\(signal ?? "nil")")

        case .engineInstanceAdded(let tabId, let instId, let label):
            log("EVENT: engineInstanceAdded tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) label=\(label)")

        case .engineInstanceRemoved(let tabId, let instId):
            log("EVENT: engineInstanceRemoved tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))")

        case .engineHarnessMessage(let tabId, let instId, let msg, _):
            log("EVENT: engineHarnessMessage tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") len=\(msg.count)")

        case .engineConversationHistory(let tabId, let instId, let msgs):
            log("EVENT: engineConvHistory tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") msgs=\(msgs.count)")

        case .engineModelOverride(let tabId, let instId, let model):
            log("EVENT: engineModelOverride tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") model=\(model)")

        case .engineProfiles(let profiles):
            log("EVENT: engineProfiles count=\(profiles.count)")

        case .gitChangesResponse(let dir, _):
            log("EVENT: gitChangesResponse dir=\(dir.suffix(30))")

        case .gitGraphResponse(let dir, _):
            log("EVENT: gitGraphResponse dir=\(dir.suffix(30))")

        case .gitDiffResponse:
            log("EVENT: gitDiffResponse")

        case .gitCommitResult(let result):
            log("EVENT: gitCommitResult ok=\(result.ok) err=\(result.error ?? "nil")")

        case .gitStageResult(let result):
            log("EVENT: gitStageResult ok=\(result.ok) err=\(result.error ?? "nil")")

        case .gitUnstageResult(let result):
            log("EVENT: gitUnstageResult ok=\(result.ok) err=\(result.error ?? "nil")")

        case .gitCommitFilesResponse(let response):
            log("EVENT: gitCommitFilesResponse hash=\(response.hash.prefix(8)) files=\(response.files.count)")

        case .gitCommitFileDiffResponse(let response):
            log("EVENT: gitCommitFileDiffResponse hash=\(response.hash.prefix(8)) path=\(response.path.suffix(30))")

        case .fsDirListing(let dir, _):
            log("EVENT: fsDirListing dir=\(dir.suffix(30))")

        case .fsFileContent(let path, _):
            log("EVENT: fsFileContent path=\(path.suffix(40))")

        case .fsImageContent(let path, _, let error):
            log("EVENT: fsImageContent path=\(path.suffix(40)) err=\(error ?? "nil")")

        case .fsWriteResult(let path, _):
            log("EVENT: fsWriteResult path=\(path.suffix(40))")

        case .discoverCommandsResponse(let dir, let cmds):
            log("EVENT: discoverCommandsResponse dir=\(dir.suffix(30)) cmds=\(cmds.count)")

        case .uploadAttachmentResult(let id, let name, _, _, let error):
            log("EVENT: uploadAttachmentResult id=\(id.prefix(8)) name=\(name) err=\(error ?? "nil")")

        case .requestDiagnosticLogs:
            log("EVENT: requestDiagnosticLogs")
        }
    }
}
