import Foundation

// MARK: - Centralized Event Logging

extension DiagnosticLog {

    /// Log a structured one-liner for any inbound RemoteEvent.
    /// Called from `handleEvent()` to replace the old `print("[Ion] handleEvent:")`.
    /// Heartbeats are skipped (too noisy).
    static func logEvent(_ event: RemoteEvent) {
        switch event {
        case .heartbeat(let senderTs, let buffered):
            // Heartbeat is now logged here at DEBUG level so it appears in the
            // diagnostic stream for latency analysis. The per-frame logging in
            // TransportManager+Receive.swift also logs heartbeat with fields;
            // this call captures the event-handling level for completeness.
            log("EVENT: heartbeat senderTs=\(Int(senderTs)) buffered=\(buffered)", tag: "session", level: .debug)

        case .resendUnavailable(let fromSeq):
            log("EVENT: resendUnavailable fromSeq=\(fromSeq)", tag: "session", level: .info)

        case .snapshot(let tabs, let dirs, let groupMode, _, _, _, _, _, _, _, _):
            log("EVENT: snapshot tabs=\(tabs.count) dirs=\(dirs.count) groupMode=\(groupMode ?? "nil")", tag: "session", level: .info)

        case .tabCreated(let tab, _):
            log("EVENT: tabCreated id=\(tab.id.prefix(8)) title=\(tab.title.prefix(30))", tag: "session", level: .info)

        case .tabClosed(let tabId):
            log("EVENT: tabClosed id=\(tabId.prefix(8))", tag: "session", level: .info)

        case .tabStatus(let tabId, let status):
            log("EVENT: tabStatus id=\(tabId.prefix(8)) status=\(status.rawValue)", tag: "session", level: .info)

        case .tabMeta(let tabId, let title, let totalCostUsd, let groupId):
            log("EVENT: tabMeta id=\(tabId.prefix(8)) title=\(title?.prefix(20) ?? "-") runCostUsd=\(totalCostUsd.map { String(format: "%.4f", $0) } ?? "-") group=\(groupId ?? "-")",
                tag: "session", level: .debug)

        case .textChunk(let tabId, let text):
            log("EVENT: textChunk tabId=\(tabId.prefix(8)) len=\(text.count)", tag: "session", level: .debug)

        case .toolCall(let tabId, let toolName, let toolId):
            log("EVENT: toolCall tabId=\(tabId.prefix(8)) tool=\(toolName) toolId=\(toolId.prefix(8))", tag: "session", level: .info)

        case .toolResult(let tabId, let toolId, let content, let isError):
            log("EVENT: toolResult tabId=\(tabId.prefix(8)) toolId=\(toolId.prefix(8)) err=\(isError) len=\(content.count)", tag: "session", level: .info)

        case .taskComplete(let tabId, _, let costUsd):
            log("EVENT: taskComplete tabId=\(tabId.prefix(8)) cost=\(costUsd)", tag: "session", level: .info)

        case .permissionRequest(let tabId, let instanceId, let qId, let toolName, _, let options):
            log("EVENT: permissionRequest tabId=\(tabId.prefix(8)) instanceId=\(instanceId?.prefix(8) ?? "nil") qId=\(qId.prefix(8)) tool=\(toolName) opts=\(options.count)", tag: "session", level: .info)

        case .permissionResolved(let tabId, let qId):
            log("EVENT: permissionResolved tabId=\(tabId.prefix(8)) qId=\(qId.prefix(8))", tag: "session", level: .info)

        case .conversationHistory(let tabId, let msgs, let hasMore, _, let before):
            log("EVENT: conversationHistory tabId=\(tabId.prefix(8)) msgs=\(msgs.count) hasMore=\(hasMore) before=\(before?.prefix(8) ?? "nil")", tag: "session", level: .info)

        case .messageAdded(let tabId, let msg):
            log("EVENT: messageAdded tabId=\(tabId.prefix(8)) role=\(msg.role.rawValue) len=\(msg.content.count)", tag: "session", level: .info)

        case .messageUpdated(let tabId, let msgId, _, let toolStatus, _):
            log("EVENT: messageUpdated tabId=\(tabId.prefix(8)) msgId=\(msgId.prefix(8)) toolStatus=\(toolStatus?.rawValue ?? "nil")", tag: "session", level: .info)

        case .queueUpdate(let tabId, let prompts):
            log("EVENT: queueUpdate tabId=\(tabId.prefix(8)) queued=\(prompts.count)", tag: "session", level: .info)

        case .error(let tabId, let message):
            log("ERR: event tabId=\(tabId.prefix(8)) msg=\(message.prefix(80))", tag: "session", level: .warn)

        case .unpair:
            log("EVENT: unpair", tag: "session", level: .info)

        case .relayConfig:
            log("EVENT: relayConfig", tag: "session", level: .info)

        case .remoteDisplay(let customName, let customIcon, let updatedAt):
            let ms = Int(updatedAt.timeIntervalSince1970 * 1000)
            log("EVENT: remoteDisplay name=\(customName == nil ? "cleared" : "set") icon=\(customIcon ?? "cleared") ts=\(ms)", tag: "session", level: .info)

        case .peerDisconnected:
            log("EVENT: peerDisconnected", tag: "session", level: .info)

        case .transportReconnecting:
            log("EVENT: transportReconnecting", tag: "session", level: .info)

        case .lanAuthRejected:
            log("EVENT: lanAuthRejected", tag: "session", level: .warn)

        case .inputPrefill(let tabId, let text, let switchTo, let instanceId):
            log("EVENT: inputPrefill tabId=\(tabId.prefix(8)) len=\(text.count) switchTo=\(switchTo) instance=\(instanceId?.prefix(8) ?? "nil")", tag: "session", level: .info)

        case .terminalOutput(let tabId, let instId, let data):
            log("EVENT: terminalOutput tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) len=\(data.count)", tag: "session", level: .debug)

        case .terminalExit(let tabId, let instId, let exitCode):
            log("EVENT: terminalExit tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) code=\(exitCode)", tag: "session", level: .info)

        case .terminalInstanceAdded(let tabId, let inst):
            log("EVENT: terminalInstanceAdded tabId=\(tabId.prefix(8)) inst=\(inst.id.prefix(8))", tag: "session", level: .info)

        case .terminalInstanceRemoved(let tabId, let instId):
            log("EVENT: terminalInstanceRemoved tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))", tag: "session", level: .info)

        case .terminalSnapshot(let tabId, let insts, _, _):
            log("EVENT: terminalSnapshot tabId=\(tabId.prefix(8)) instances=\(insts.count)", tag: "session", level: .info)

        case .engineAgentState(let tabId, let instId, let agents):
            log("EVENT: engineAgentState tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") agents=\(agents.count)", tag: "session", level: .info)

        case .engineStatus(let tabId, let instId, _, _):
            log("EVENT: engineStatus tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)

        case .engineSessionStatus(let tabId, let instId, let ss, _):
            log("EVENT: engineSessionStatus tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") state=\(ss.state) inflight=\(ss.hasInflightRun ?? false)", tag: "session", level: .info)

        case .engineWorkingMessage(let tabId, let instId, _, _):
            log("EVENT: engineWorkingMessage tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)

        case .engineToolStart(let tabId, let instId, let toolName, let toolId):
            log("EVENT: engineToolStart tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tool=\(toolName) toolId=\(toolId.prefix(8))", tag: "session", level: .info)

        case .engineToolEnd(let tabId, let instId, let toolId, _, let isError):
            log("EVENT: engineToolEnd tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") toolId=\(toolId.prefix(8)) err=\(isError)", tag: "session", level: .info)

        case .engineToolStalled(let tabId, let instId, let toolId, let toolName, _):
            log("EVENT: engineToolStalled tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tool=\(toolName) toolId=\(toolId.prefix(8))", tag: "session", level: .info)
        case .engineRunStalled(let tabId, let instId, let stalledDuration, let lastActivity):
            log("EVENT: engineRunStalled tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") stalledFor=\(Int(stalledDuration))s lastActivity=\(lastActivity ?? "nil")", tag: "session", level: .info)
        case .engineSteerInjected(let tabId, let instId, let messageLength):
            log("EVENT: engineSteerInjected tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") messageLength=\(messageLength)", tag: "session", level: .info)

        case .enginePromptInjected(let tabId, let instId, let prompt, let origin, let kind):
            log("EVENT: enginePromptInjected tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") len=\(prompt.count) origin=\(origin ?? "") kind=\(kind ?? "")", tag: "session", level: .info)

        // Extended-thinking events (issue #158). A thinking block is OPTIONAL
        // per turn; the delta may be suppressed by the desktop's low-bandwidth
        // streamThinkingToRemote toggle, leaving start+end only. Log all three
        // boundaries so the reasoning lifecycle is reconstructable from logs.
        case .engineThinkingBlockStart(let tabId, let instId):
            log("EVENT: engineThinkingBlockStart tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)
        case .engineThinkingDelta(let tabId, let instId, let thinkingText):
            log("EVENT: engineThinkingDelta tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") len=\(thinkingText.count)", tag: "session", level: .debug)
        case .engineThinkingBlockEnd(let tabId, let instId, let totalTokens, let elapsedSeconds, let redacted):
            log("EVENT: engineThinkingBlockEnd tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tokens=\(totalTokens.map(String.init) ?? "nil") elapsed=\(elapsedSeconds.map { String(format: "%.1f", $0) } ?? "nil") redacted=\(redacted ?? false)", tag: "session", level: .info)

        case .engineToolUpdate(let tabId, let instId):
            log("EVENT: engineToolUpdate tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)
        case .engineToolComplete(let tabId, let instId):
            log("EVENT: engineToolComplete tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)
        case .engineScheduleFired(let tabId, let instId):
            log("EVENT: engineScheduleFired tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)
        case .engineLlmCall(let tabId, let instId):
            log("EVENT: engineLlmCall tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)
        case .engineImageContent(let tabId, let instId, let path, _, let source, let toolId):
            log("EVENT: engineImageContent tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") source=\(source) toolId=\(toolId?.prefix(8) ?? "nil") file=\((path as NSString).lastPathComponent)", tag: "session", level: .info)
        case .engineDispatchStart(let tabId, let instId, let agent, _, _, _, let depth, let parentId, let dispatchId):
            log("EVENT: engineDispatchStart tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") agent=\(agent) depth=\(depth) parentId=\(parentId.prefix(16)) id=\(dispatchId.prefix(16))", tag: "session", level: .info)
        case .engineDispatchEnd(let tabId, let instId, let agent, let depth, let parentId, let exitCode, let elapsed, let dispatchId, _):
            log("EVENT: engineDispatchEnd tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") agent=\(agent) depth=\(depth) parentId=\(parentId.prefix(16)) exit=\(exitCode) elapsed=\(String(format: "%.2f", elapsed))s id=\(dispatchId.prefix(16))", tag: "session", level: .info)
        case .engineDispatchActivity(let tabId, _, let agentId, let convId, let kind, let seq, _, let toolId, _, _, _):
            log("EVENT: engineDispatchActivity tab=\(tabId.prefix(8)) agent=\(agentId.prefix(16)) conv=\(convId.prefix(8)) kind=\(kind) seq=\(seq) toolId=\(toolId ?? "")", tag: "session", level: .info)

        case .engineError(let tabId, let instId, let msg):
            log("ERR: engine tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") msg=\(msg.prefix(80))", tag: "session", level: .warn)

        case .engineNotify(let tabId, let instId, let msg, let level, _):
            log("EVENT: engineNotify tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") level=\(level) msg=\(msg.prefix(60))", tag: "session", level: .info)

        case .engineDialog(let tabId, let instId, let dId, let method, _, _, _):
            log("EVENT: engineDialog tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") dId=\(dId.prefix(8)) method=\(method)", tag: "session", level: .info)

        case .engineDialogResolved(let tabId, let instId, let dId):
            log("EVENT: engineDialogResolved tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") dId=\(dId.prefix(8))", tag: "session", level: .info)

        case .engineTextDelta(let tabId, let instId, let text):
            log("EVENT: engineTextDelta tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") len=\(text.count)", tag: "session", level: .debug)

        case .engineStreamReset(let tabId, let instId):
            log("EVENT: engineStreamReset tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "session", level: .info)

        case .engineMessageEnd(let tabId, let instId, let inTok, _, let ctxPct, _, let entryId, _):
            log("EVENT: engineMessageEnd tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") tokens=\(inTok) ctx=\(String(format: "%.0f", ctxPct))% entryId=\(entryId?.prefix(12) ?? "nil")", tag: "session", level: .info)

        case .engineUserTurnPersisted(let tabId, let instId, let entryId):
            log("EVENT: engineUserTurnPersisted tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") entryId=\(entryId.prefix(12))", tag: "session", level: .info)

        case .engineDead(let tabId, let instId, let exitCode, let signal, _):
            log("EVENT: engineDead tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") exit=\(exitCode ?? -1) sig=\(signal ?? "nil")", tag: "session", level: .info)

        case .engineInstanceAdded(let tabId, let instId, let label):
            log("EVENT: engineInstanceAdded tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) label=\(label)", tag: "session", level: .info)

        case .engineInstanceRemoved(let tabId, let instId):
            log("EVENT: engineInstanceRemoved tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))", tag: "session", level: .info)

        case .engineInstanceMoved(let srcTabId, let instId, let tgtTabId):
            log("EVENT: engineInstanceMoved src=\(srcTabId.prefix(8)) inst=\(instId.prefix(8)) tgt=\(tgtTabId.prefix(8))", tag: "session", level: .info)

        case .engineHarnessMessage(let tabId, let instId, let msg, _, _, _, _):
            log("EVENT: engineHarnessMessage tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") len=\(msg.count)", tag: "session", level: .info)

        // engineConversationHistory log arm removed (WI-004 / #259).
        // History arrives via .conversationHistory (desktop_conversation_history),
        // logged by handleConversationHistory in SessionViewModel+PermissionMessageEvents.

        case .agentConversationHistory(let agentName, let convId, let msgs):
            log("EVENT: agentConvHistory agent=\(agentName) convId=\(convId ?? "nil") msgs=\(msgs.count)", tag: "session", level: .info)

        case .engineModelOverride(let tabId, let instId, let model):
            log("EVENT: engineModelOverride tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") model=\(model)", tag: "session", level: .info)

        case .engineProfiles(let profiles):
            log("EVENT: engineProfiles count=\(profiles.count)", tag: "session", level: .info)

        case .enginePlanModeChanged(let tabId, let instId, let enabled, let path, let slug):
            log("EVENT: enginePlanModeChanged tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") enabled=\(enabled) path=\(path?.suffix(40) ?? "nil") slug=\(slug ?? "nil")", tag: "session", level: .info)
        case .enginePlanFileWritten(let tabId, let instId, let op, let path, let slug):
            log("EVENT: enginePlanFileWritten tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") op=\(op) path=\(path?.suffix(40) ?? "nil") slug=\(slug ?? "nil")", tag: "session", level: .info)

        case .enginePlanProposal(let tabId, let instId, let kind, let path, _):
            // Workflow event from the engine — iOS does not act on this
            // (the desktop is the authoritative consumer for plan-proposal
            // approval UI), but log it so the wire-protocol flow is fully
            // observable in the diagnostic stream alongside other engine
            // events.
            log("EVENT: enginePlanProposal tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") kind=\(kind) path=\(path?.suffix(40) ?? "nil")", tag: "session", level: .info)

        case .enginePlanModeAutoExit(let tabId, let instId, let stopReason, let path, _, _, _, let runId):
            // Engine-synthesized ExitPlanMode safety net (issue #187).
            // iOS does not act on this; the desktop is the authoritative
            // consumer that renders the approval card. Log the runId
            // and stopReason so the diagnostic stream can correlate the
            // synthesis with the engine.log entry that produced it.
            log("EVENT: enginePlanModeAutoExit tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") runId=\(runId?.prefix(12) ?? "nil") stopReason=\(stopReason) path=\(path?.suffix(40) ?? "nil")", tag: "session", level: .info)

        case .engineEarlyStopDecisionRequest(let tabId, let instId, let reqId, _, _, let turn, _, let cumOut, let budget, let pct, _, _, _, let would, _):
            // Engine ↔ harness wire-protocol request. The desktop is the
            // authoritative responder; iOS only observes for diagnostic
            // visibility. Log the most useful correlation fields (request
            // ID, turn, percent-of-budget) so a developer triaging
            // continuation issues can pair the iOS-side log line with the
            // engine's `earlyStop: ...` lines and the desktop's
            // `early-stop-policy` lines.
            log("EVENT: engineEarlyStopDecisionRequest tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") reqId=\(reqId.prefix(8)) turn=\(turn) tokens=\(cumOut)/\(budget) thr=\(pct)% would=\(would)", tag: "session", level: .info)

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
            log("EVENT: engineCommandRegistry tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") count=\(commands.count) names=[\(names)]", tag: "session", level: .info)

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
            log("EVENT: engineCommandResult tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") command=\(cmd) error=\(err) msg=\"\(msgPreview)\"", tag: "session", level: .info)

        case .engineExport(let tabId, let instId, let message, let exportFormat):
            // Engine has rendered a /export payload. Logged at byte-count
            // granularity only — the full payload may be many KB of the
            // conversation's content and the log file would grow
            // pathologically. The share sheet pickup is logged
            // separately at the view layer.
            log("EVENT: engineExport tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") format=\(exportFormat ?? "nil") bytes=\(message.count)", tag: "session", level: .info)

        case .desktopSettingsSnapshot(let settings, let schema, let groups, let newConversationPolicy):
            // Snapshot of the desktop's projectable user preferences.
            // Logged with counts only — the actual values can be
            // sensitive and the wire payload is small enough that a
            // future diagnostic dump can capture the full record if
            // needed.
            _ = newConversationPolicy // logged at assignment site in EventHandlers
            log("EVENT: desktopSettingsSnapshot values=\(settings.count) schema=\(schema.count) groups=\(groups.count)", tag: "session", level: .info)

        case .gitChangesResponse(let dir, _):
            log("EVENT: gitChangesResponse dir=\(dir.suffix(30))", tag: "session", level: .info)

        case .gitGraphResponse(let dir, _):
            log("EVENT: gitGraphResponse dir=\(dir.suffix(30))", tag: "session", level: .info)

        case .gitDiffResponse:
            log("EVENT: gitDiffResponse", tag: "session", level: .info)

        case .gitCommitResult(let result):
            log("EVENT: gitCommitResult ok=\(result.ok) err=\(result.error ?? "nil")", tag: "session", level: .info)

        case .gitStageResult(let result):
            log("EVENT: gitStageResult ok=\(result.ok) err=\(result.error ?? "nil")", tag: "session", level: .info)

        case .gitUnstageResult(let result):
            log("EVENT: gitUnstageResult ok=\(result.ok) err=\(result.error ?? "nil")", tag: "session", level: .info)

        case .gitCommitFilesResponse(let response):
            log("EVENT: gitCommitFilesResponse hash=\(response.hash.prefix(8)) files=\(response.files.count)", tag: "session", level: .info)

        case .gitCommitFileDiffResponse(let response):
            log("EVENT: gitCommitFileDiffResponse hash=\(response.hash.prefix(8)) path=\(response.path.suffix(30))", tag: "session", level: .info)

        case .fsDirListing(let dir, _):
            log("EVENT: fsDirListing dir=\(dir.suffix(30))", tag: "session", level: .info)

        case .fsFileContent(let path, _):
            log("EVENT: fsFileContent path=\(path.suffix(40))", tag: "session", level: .info)

        case .fsImageContent(let path, _, let error):
            log("EVENT: fsImageContent path=\(path.suffix(40)) err=\(error ?? "nil")", tag: "session", level: .info)

        case .fsWriteResult(let path, _):
            log("EVENT: fsWriteResult path=\(path.suffix(40))", tag: "session", level: .info)

        case .fsRenameResult(let oldPath, let newPath, let response):
            log("EVENT: fsRenameResult old=\(oldPath.suffix(40)) new=\(newPath.suffix(40)) ok=\(response.ok) err=\(response.error ?? "nil")", tag: "session", level: .info)

        case .discoverCommandsResponse(let dir, let cmds):
            log("EVENT: discoverCommandsResponse dir=\(dir.suffix(30)) cmds=\(cmds.count)", tag: "session", level: .info)

        case .uploadAttachmentResult(let id, let name, _, _, let error):
            log("EVENT: uploadAttachmentResult id=\(id.prefix(8)) name=\(name) err=\(error ?? "nil")", tag: "session", level: .info)

        case .tabAttachments(let tabId, let attachments):
            log("EVENT: tabAttachments tab=\(tabId.prefix(8)) count=\(attachments.count)", tag: "session", level: .info)

        case .requestDiagnosticLogs:
            log("EVENT: requestDiagnosticLogs", tag: "session", level: .info)

        case .engineResourceSnapshot(let tabId, _, let kind, let subId, let items):
            log("EVENT: engineResourceSnapshot tab=\(tabId.prefix(8)) kind=\(kind) sub=\(subId.prefix(8)) items=\(items.count)", tag: "session", level: .info)

        case .engineResourceDelta(let tabId, _, let kind, let subId, _):
            log("EVENT: engineResourceDelta tab=\(tabId.prefix(8)) kind=\(kind) sub=\(subId.prefix(8))", tag: "session", level: .debug)

        case .engineNotification(let tabId, _, let kind, let title, _, _, _):
            log("EVENT: engineNotification tab=\(tabId.prefix(8)) kind=\(kind) title=\(title)", tag: "session", level: .info)

        case .engineIntercept(let tabId, let instId, let level, let title, _, _, _):
            log("EVENT: engineIntercept tab=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil") level=\(level) title=\(title.prefix(60))", tag: "session", level: .info)

        case .resourceContent(let resourceId, let kind, let content):
            log("EVENT: resourceContent resourceId=\(resourceId.prefix(12)) kind=\(kind) contentLen=\(content.count)", tag: "session", level: .info)

        case .planContent(let questionId, let planFilePath, let offset, let content, let totalBytes, let hasMore):
            log("EVENT: planContent qId=\(questionId.prefix(12)) path=\(planFilePath.suffix(30)) offset=\(offset) contentLen=\(content.count) totalBytes=\(totalBytes) hasMore=\(hasMore)", tag: "session", level: .info)

        case .desktopContextBreakdown(let tabId, let instanceId, let payload):
            // Context-breakdown diagnostics: log category count, total token sum, and
            // whether this is a post-reconciliation update (apiReportedTotal present).
            let reconciled = payload.apiReportedTotal != nil ? "reconciled" : "pre"
            let unaccounted = payload.unaccounted.map { " unaccounted=\($0)" } ?? ""
            log("EVENT: desktopContextBreakdown tab=\(tabId.prefix(8)) inst=\(instanceId?.prefix(8) ?? "nil") cats=\(payload.categories.count) total=\(payload.totalTokens)/\(payload.contextWindow) \(reconciled)\(unaccounted)", tag: "session", level: .info)
        }
    }
}
