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

        case .snapshot(let tabs, let dirs, let groupMode, _, _, _, _, _, _, _):
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

        case .remoteDisplay(let customName, let customIcon, let updatedAt):
            let ms = Int(updatedAt.timeIntervalSince1970 * 1000)
            log("EVENT: remoteDisplay name=\(customName == nil ? "cleared" : "set") icon=\(customIcon ?? "cleared") ts=\(ms)")

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

        case .engineStatus(let tabId, let instId, _, _):
            log("EVENT: engineStatus tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")")

        case .engineWorkingMessage(let tabId, let instId, _, _):
            log("EVENT: engineWorkingMessage tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")")

        case .engineToolStart(let tabId, let instId, let toolName, let toolId):
            log("EVENT: engineToolStart tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tool=\(toolName) toolId=\(toolId.prefix(8))")

        case .engineToolEnd(let tabId, let instId, let toolId, _, let isError):
            log("EVENT: engineToolEnd tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") toolId=\(toolId.prefix(8)) err=\(isError)")

        case .engineToolStalled(let tabId, let instId, let toolId, let toolName, _):
            log("EVENT: engineToolStalled tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tool=\(toolName) toolId=\(toolId.prefix(8))")
        case .engineSteerInjected(let tabId, let instId, let messageLength):
            log("EVENT: engineSteerInjected tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") messageLength=\(messageLength)")

        case .engineError(let tabId, let instId, let msg):
            log("ERR: engine tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") msg=\(msg.prefix(80))")

        case .engineNotify(let tabId, let instId, let msg, let level, _):
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

        case .engineInstanceMoved(let srcTabId, let instId, let tgtTabId):
            log("EVENT: engineInstanceMoved src=\(srcTabId.prefix(8)) inst=\(instId.prefix(8)) tgt=\(tgtTabId.prefix(8))")

        case .engineHarnessMessage(let tabId, let instId, let msg, _, _):
            log("EVENT: engineHarnessMessage tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") len=\(msg.count)")

        case .engineConversationHistory(let tabId, let instId, let msgs):
            log("EVENT: engineConvHistory tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") msgs=\(msgs.count)")

        case .agentConversationHistory(let agentName, let convId, let msgs):
            log("EVENT: agentConvHistory agent=\(agentName) convId=\(convId ?? "nil") msgs=\(msgs.count)")

        case .engineModelOverride(let tabId, let instId, let model):
            log("EVENT: engineModelOverride tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") model=\(model)")

        case .engineProfiles(let profiles):
            log("EVENT: engineProfiles count=\(profiles.count)")

        case .enginePlanModeChanged(let tabId, let instId, let enabled, let path, let slug):
            log("EVENT: enginePlanModeChanged tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") enabled=\(enabled) path=\(path?.suffix(40) ?? "nil") slug=\(slug ?? "nil")")

        case .enginePlanProposal(let tabId, let instId, let kind, let path, _):
            // Workflow event from the engine — iOS does not act on this
            // (the desktop is the authoritative consumer for plan-proposal
            // approval UI), but log it so the wire-protocol flow is fully
            // observable in the diagnostic stream alongside other engine
            // events.
            log("EVENT: enginePlanProposal tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") kind=\(kind) path=\(path?.suffix(40) ?? "nil")")

        case .engineEarlyStopDecisionRequest(let tabId, let instId, let reqId, _, _, let turn, _, let cumOut, let budget, let pct, _, _, _, let would, _):
            // Engine ↔ harness wire-protocol request. The desktop is the
            // authoritative responder; iOS only observes for diagnostic
            // visibility. Log the most useful correlation fields (request
            // ID, turn, percent-of-budget) so a developer triaging
            // continuation issues can pair the iOS-side log line with the
            // engine's `earlyStop: ...` lines and the desktop's
            // `early-stop-policy` lines.
            log("EVENT: engineEarlyStopDecisionRequest tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") reqId=\(reqId.prefix(8)) turn=\(turn) tokens=\(cumOut)/\(budget) thr=\(pct)% would=\(would)")

        case .engineCommandRegistry(let tabId, let instId, let commands):
            // Complete snapshot of session-scoped slash commands. Log
            // the count + names so a developer can pair this line with
            // the engine's `emitCommandRegistry: key=... count=...`
            // line and the desktop's
            // `engine_command_registry: cached key=... names=[...]`
            // line during slash-pipeline triage. Empty list is the
            // authoritative "no extension commands" signal — log it
            // explicitly rather than skipping the line so the absence
            // of commands surfaces in the trail.
            let names = commands.map { $0.name }.joined(separator: ",")
            log("EVENT: engineCommandRegistry tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") count=\(commands.count) names=[\(names)]")

        case .engineCommandResult(let tabId, let instId, let message, let command, let commandError):
            // Result of an engine SendCommand dispatch. Three branches
            // worth distinguishing in the log: success (no error),
            // extension failure (error present), unknown-command
            // disclaim (error == "unknown_command"). The desktop reads
            // these to decide between "dispatch landed" and "fall
            // through"; iOS only observes.
            let cmd = command ?? "<none>"
            let err = commandError ?? "<none>"
            let msgPreview = message?.prefix(60) ?? ""
            log("EVENT: engineCommandResult tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") command=\(cmd) error=\(err) msg=\"\(msgPreview)\"")

        case .desktopSettingsSnapshot(let settings, let schema, let groups):
            // Snapshot of the desktop's projectable user preferences.
            // Logged with counts only — the actual values can be
            // sensitive and the wire payload is small enough that a
            // future diagnostic dump can capture the full record if
            // needed.
            log("EVENT: desktopSettingsSnapshot values=\(settings.count) schema=\(schema.count) groups=\(groups.count)")

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

        case .fsRenameResult(let oldPath, let newPath, let response):
            log("EVENT: fsRenameResult old=\(oldPath.suffix(40)) new=\(newPath.suffix(40)) ok=\(response.ok) err=\(response.error ?? "nil")")

        case .discoverCommandsResponse(let dir, let cmds):
            log("EVENT: discoverCommandsResponse dir=\(dir.suffix(30)) cmds=\(cmds.count)")

        case .uploadAttachmentResult(let id, let name, _, _, let error):
            log("EVENT: uploadAttachmentResult id=\(id.prefix(8)) name=\(name) err=\(error ?? "nil")")

        case .tabAttachments(let tabId, let attachments):
            log("EVENT: tabAttachments tab=\(tabId.prefix(8)) count=\(attachments.count)")

        case .requestDiagnosticLogs:
            log("EVENT: requestDiagnosticLogs")
        }
    }
}
