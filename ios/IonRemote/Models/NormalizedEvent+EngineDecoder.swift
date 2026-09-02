import Foundation

// MARK: - Engine event decode

// Extracted from NormalizedEvent+Engine.swift to keep that file under the
// 600-line Swift cap. `encodeEngine` stays in NormalizedEvent+Engine.swift.
// Both functions are members of the same `extension RemoteEvent` so there
// is no access-control boundary between them.

extension RemoteEvent {

    /// Decode structured engine events from the desktop runtime.
    static func decodeEngine(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .engineAgentState:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let agents = try container.decode([AgentStateUpdate].self, forKey: .agents)
            // Absent on a full roster; only a degraded payload sets it.
            let metadataOmitted = try container.decodeIfPresent(Bool.self, forKey: .metadataOmitted) ?? false
            return .engineAgentState(tabId: tabId, instanceId: instanceId, agents: agents, metadataOmitted: metadataOmitted)

        case .engineStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let fields = try container.decode(StatusFields.self, forKey: .fields)
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineStatus(tabId: tabId, instanceId: instanceId, fields: fields, metadata: metadata)

        case .engineSessionStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let sessionStatus = try container.decode(SessionStatus.self, forKey: .sessionStatus)
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineSessionStatus(tabId: tabId, instanceId: instanceId, sessionStatus: sessionStatus, metadata: metadata)

        case .engineWorkingMessage:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineWorkingMessage(tabId: tabId, instanceId: instanceId, message: message, metadata: metadata)

        case .engineToolStart:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let toolId = try container.decode(String.self, forKey: .toolId)
            return .engineToolStart(tabId: tabId, instanceId: instanceId, toolName: toolName, toolId: toolId)

        case .engineToolEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let result = try container.decodeIfPresent(String.self, forKey: .result)
            let isError = try container.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            let bgTaskId = try container.decodeIfPresent(String.self, forKey: .backgroundTaskId)
            return .engineToolEnd(tabId: tabId, instanceId: instanceId, toolId: toolId, result: result, isError: isError, backgroundTaskId: bgTaskId)

        case .engineToolStalled:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let elapsed = try container.decode(Double.self, forKey: .elapsed)
            return .engineToolStalled(tabId: tabId, instanceId: instanceId, toolId: toolId, toolName: toolName, elapsed: elapsed)

        case .engineBackgroundTaskStarted:
            let payload = try container.decode(BackgroundTaskState.self, forKey: .task)
            return .engineBackgroundTaskStarted(
                tabId: try container.decode(String.self, forKey: .tabId),
                instanceId: try container.decodeIfPresent(String.self, forKey: .instanceId),
                taskId: payload.taskId,
                command: payload.command,
                startedAt: payload.startedAt,
                notifyOnComplete: payload.notifyOnComplete
            )

        case .engineBackgroundTaskTerminal:
            return .engineBackgroundTaskTerminal(
                tabId: try container.decode(String.self, forKey: .tabId),
                instanceId: try container.decodeIfPresent(String.self, forKey: .instanceId),
                taskId: try container.decode(String.self, forKey: .taskId),
                status: try container.decode(String.self, forKey: .status),
                exitCode: try container.decodeIfPresent(Int.self, forKey: .exitCode),
                elapsedMs: try container.decodeIfPresent(Int.self, forKey: .elapsedMs),
                command: try container.decodeIfPresent(String.self, forKey: .command),
                outputPath: try container.decodeIfPresent(String.self, forKey: .outputPath),
                tail: try container.decodeIfPresent(String.self, forKey: .tail)
            )

        case .engineSessionWorkStopped:
            return .engineSessionWorkStopped(
                tabId: try container.decode(String.self, forKey: .tabId),
                instanceId: try container.decodeIfPresent(String.self, forKey: .instanceId),
                scope: try container.decode(String.self, forKey: .scope),
                cancelledRunId: try container.decodeIfPresent(String.self, forKey: .cancelledRunId),
                recalledDispatchIds: try container.decodeIfPresent([String].self, forKey: .recalledDispatchIds),
                stoppedBackgroundTaskIds: try container.decodeIfPresent([String].self, forKey: .stoppedBackgroundTaskIds) ?? [],
                killedAgentProcessCount: try container.decodeIfPresent(Int.self, forKey: .killedAgentProcessCount)
            )

        case .engineRunStalled:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let stalledDuration = try container.decodeIfPresent(Double.self, forKey: .runStalledDuration) ?? 0
            let lastActivity = try container.decodeIfPresent(String.self, forKey: .runStalledLastActivity)
            return .engineRunStalled(tabId: tabId, instanceId: instanceId, stalledDuration: stalledDuration, lastActivity: lastActivity)

        case .engineRunRecovery:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let recoveryId = try container.decode(String.self, forKey: .runRecoveryId)
            let phase = try container.decode(String.self, forKey: .runRecoveryPhase)
            let attempt = try container.decodeIfPresent(Int.self, forKey: .runRecoveryAttempt)
            let maxAttempts = try container.decodeIfPresent(Int.self, forKey: .runRecoveryMaxAttempts)
            let reason = try container.decodeIfPresent(String.self, forKey: .runRecoveryReason)
            return .engineRunRecovery(tabId: tabId, instanceId: instanceId, recoveryId: recoveryId, phase: phase, attempt: attempt, maxAttempts: maxAttempts, reason: reason)

        case .engineSteerInjected:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let messageLength = try container.decode(Int.self, forKey: .steerMessageLength)
            // steerClientMessageId/steerEntryId are the RAW engine field
            // names, forwarded verbatim by the desktop's generic engine-event
            // spread projector (event-wiring-wire-projection.ts) rather than
            // a renamed desktop-internal shape — decoding under any other key
            // silently drops these bytes even though they are present on the
            // wire.
            let clientMessageId = try container.decodeIfPresent(String.self, forKey: .steerClientMessageId)
            let entryId = try container.decodeIfPresent(String.self, forKey: .steerEntryId)
            let kind = try container.decodeIfPresent(String.self, forKey: .steerKind)
            let machineAuthored = try container.decodeIfPresent(Bool.self, forKey: .steerMachineAuthored)
            return .engineSteerInjected(tabId: tabId, instanceId: instanceId, messageLength: messageLength, clientMessageId: clientMessageId, entryId: entryId, kind: kind, machineAuthored: machineAuthored)

        case .engineSteerDegraded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let messageLength = try container.decode(Int.self, forKey: .steerDegradedMessageLength)
            let kind = try container.decodeIfPresent(String.self, forKey: .steerKind)
            let machineAuthored = try container.decodeIfPresent(Bool.self, forKey: .steerMachineAuthored)
            return .engineSteerDegraded(tabId: tabId, instanceId: instanceId, messageLength: messageLength, kind: kind, machineAuthored: machineAuthored)

        case .engineSteerInterruptedStream:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            // Both counts are omitempty on the wire: the engine drops a zero,
            // so decodeIfPresent is required. A missing value means zero, not a
            // malformed frame — decoding these as non-optional would throw and
            // silently drop the whole event.
            let blocksKept = try container.decodeIfPresent(Int.self, forKey: .steerInterruptBlocksKept)
            let queuedSteers = try container.decodeIfPresent(Int.self, forKey: .steerQueuedCount)
            return .engineSteerInterruptedStream(tabId: tabId, instanceId: instanceId, blocksKept: blocksKept, queuedSteers: queuedSteers)

        case .engineRewindResult:
            // Transactional rejection-only notice. `status` is always
            // "rejected" on the wire (no success frame is ever sent), so it
            // is not surfaced as a Swift field — decoding `error` is the only
            // information a refusal carries.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            return .engineRewindResult(tabId: tabId, instanceId: instanceId, error: error)

        case .enginePromptInjected:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let prompt = try container.decodeIfPresent(String.self, forKey: .injectedPrompt) ?? ""
            let origin = try container.decodeIfPresent(String.self, forKey: .injectedPromptOrigin)
            let kind = try container.decodeIfPresent(String.self, forKey: .injectedPromptKind)
            let machineAuthored = try container.decodeIfPresent(Bool.self, forKey: .injectedPromptMachineAuthored)
            return .enginePromptInjected(tabId: tabId, instanceId: instanceId, prompt: prompt, origin: origin, kind: kind, machineAuthored: machineAuthored)

        case .engineToolUpdate, .engineToolComplete, .engineScheduleFired, .engineLlmCall:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            switch type {
            case .engineToolUpdate:
                let toolId = try container.decodeIfPresent(String.self, forKey: .toolId) ?? ""
                let partialInput = try container.decodeIfPresent(String.self, forKey: .partialInput) ?? ""
                return .engineToolUpdate(tabId: tabId, instanceId: instanceId, toolId: toolId, partialInput: partialInput)
            case .engineToolComplete: return .engineToolComplete(tabId: tabId, instanceId: instanceId)
            case .engineScheduleFired: return .engineScheduleFired(tabId: tabId, instanceId: instanceId)
            case .engineLlmCall: return .engineLlmCall(tabId: tabId, instanceId: instanceId)
            default: return nil
            }

        case .engineDispatchStart:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let agent = try container.decodeIfPresent(String.self, forKey: .dispatchAgent) ?? ""
            let sessionId = try container.decodeIfPresent(String.self, forKey: .dispatchSessionId) ?? ""
            let model = try container.decodeIfPresent(String.self, forKey: .dispatchModel) ?? ""
            let task = try container.decodeIfPresent(String.self, forKey: .dispatchTask) ?? ""
            let depth = try container.decodeIfPresent(Int.self, forKey: .dispatchDepth) ?? 0
            let parentId = try container.decodeIfPresent(String.self, forKey: .dispatchParentId) ?? ""
            let dispatchId = try container.decodeIfPresent(String.self, forKey: .dispatchId) ?? ""
            return .engineDispatchStart(tabId: tabId, instanceId: instanceId, dispatchAgent: agent, dispatchSessionId: sessionId, dispatchModel: model, dispatchTask: task, dispatchDepth: depth, dispatchParentId: parentId, dispatchId: dispatchId)

        case .engineDispatchEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let agent = try container.decodeIfPresent(String.self, forKey: .dispatchAgent) ?? ""
            let depth = try container.decodeIfPresent(Int.self, forKey: .dispatchDepth) ?? 0
            let parentId = try container.decodeIfPresent(String.self, forKey: .dispatchParentId) ?? ""
            let exitCode = try container.decodeIfPresent(Int.self, forKey: .dispatchExitCode) ?? 0
            let elapsed = try container.decodeIfPresent(Double.self, forKey: .dispatchElapsed) ?? 0
            let dispatchId = try container.decodeIfPresent(String.self, forKey: .dispatchId) ?? ""
            let conversationId = try container.decodeIfPresent(String.self, forKey: .dispatchConversationId)
            return .engineDispatchEnd(tabId: tabId, instanceId: instanceId, dispatchAgent: agent, dispatchDepth: depth, dispatchParentId: parentId, exitCode: exitCode, elapsed: elapsed, dispatchId: dispatchId, conversationId: conversationId)

        case .engineDispatchActivity:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let agentId = try container.decodeIfPresent(String.self, forKey: .dispatchAgentId) ?? ""
            let conversationId = try container.decodeIfPresent(String.self, forKey: .dispatchConversationId) ?? ""
            let kind = try container.decodeIfPresent(String.self, forKey: .dispatchActivityKind) ?? ""
            let seq = try container.decodeIfPresent(Int.self, forKey: .dispatchSeq) ?? 0
            let toolName = try container.decodeIfPresent(String.self, forKey: .toolName)
            let toolId = try container.decodeIfPresent(String.self, forKey: .toolId)
            let textDelta = try container.decodeIfPresent(String.self, forKey: .dispatchTextDelta)
            let isError = try container.decodeIfPresent(Bool.self, forKey: .dispatchToolIsError) ?? false
            // Emit timestamp (unix millis). Decoded so the iOS mirror carries
            // the full wire shape (Go engine_event.go + desktop both send it);
            // tolerant-absent so legacy payloads without it still decode.
            let ts = try container.decodeIfPresent(Int64.self, forKey: .dispatchActivityTs)
            return .engineDispatchActivity(tabId: tabId, instanceId: instanceId, agentId: agentId, conversationId: conversationId, kind: kind, seq: seq, toolName: toolName, toolId: toolId, textDelta: textDelta, isError: isError, ts: ts)

        case .engineError:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let stderrTail = try container.decodeIfPresent([String].self, forKey: .stderrTail) ?? []
            return .engineError(tabId: tabId, instanceId: instanceId, message: message, stderrTail: stderrTail)

        case .engineNotify:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let level = try container.decodeIfPresent(String.self, forKey: .level) ?? "info"
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineNotify(tabId: tabId, instanceId: instanceId, message: message, level: level, metadata: metadata)

        case .engineDialog:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            let method = try container.decode(String.self, forKey: .method)
            let title = try container.decode(String.self, forKey: .title)
            let options = try container.decodeIfPresent([String].self, forKey: .options)
            let defaultValue = try container.decodeIfPresent(String.self, forKey: .defaultValue)
            return .engineDialog(tabId: tabId, instanceId: instanceId, dialogId: dialogId, method: method, title: title, options: options, defaultValue: defaultValue)

        case .engineDialogResolved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            return .engineDialogResolved(tabId: tabId, instanceId: instanceId, dialogId: dialogId)

        case .engineTextDelta:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
            return .engineTextDelta(tabId: tabId, instanceId: instanceId, text: text)

        case .engineStreamReset:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            return .engineStreamReset(tabId: tabId, instanceId: instanceId)

        case .engineMessageEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            // Usage is a nested object: { inputTokens, outputTokens,
            // contextPercent, cost, entryId?, userEntryId? }. The canonical
            // entry ids ride inside usage on the wire (Go MessageEndUsage);
            // they surface as top-level associated values on the Swift case.
            let usage = try container.decodeIfPresent(EngineMessageEndUsage.self, forKey: .usage)
            return .engineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, contextPercent: usage?.contextPercent ?? 0, cost: usage?.cost ?? 0, entryId: usage?.entryId, userEntryId: usage?.userEntryId)

        case .engineUserTurnPersisted:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let entryId = try container.decodeIfPresent(String.self, forKey: .userTurnEntryId) ?? ""
            let slashModelAlias = try container.decodeIfPresent(String.self, forKey: .userTurnSlashModelAlias)
            let slashModelEffective = try container.decodeIfPresent(String.self, forKey: .userTurnSlashModelEffective)
            let slashFrontmatter = try container.decodeIfPresent([String: AnyCodable].self, forKey: .userTurnSlashFrontmatter)
            return .engineUserTurnPersisted(tabId: tabId, instanceId: instanceId, entryId: entryId, slashModelAlias: slashModelAlias, slashModelEffective: slashModelEffective, slashFrontmatter: slashFrontmatter)

        case .engineDead:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
            let signal = try container.decodeIfPresent(String.self, forKey: .signal)
            let stderrTail = try container.decodeIfPresent([String].self, forKey: .stderrTail) ?? []
            return .engineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        case .engineInstanceAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instance = try container.decode(ConversationInstancePayload.self, forKey: .instance)
            return .engineInstanceAdded(tabId: tabId, instanceId: instance.id, label: instance.label)

        case .engineInstanceRemoved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            return .engineInstanceRemoved(tabId: tabId, instanceId: instanceId)

        case .engineInstanceMoved:
            let sourceTabId = try container.decode(String.self, forKey: .sourceTabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let targetTabId = try container.decode(String.self, forKey: .targetTabId)
            return .engineInstanceMoved(sourceTabId: sourceTabId, instanceId: instanceId, targetTabId: targetTabId)

        case .engineHarnessMessage:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let source = try container.decodeIfPresent(String.self, forKey: .source)
            // `metadata` is an opaque hint map the harness sets via ctx.emit and
            // the engine forwards verbatim. Decoded as [String: AnyCodable] for
            // completeness so future iOS-side handlers can read typed values.
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            // `dedupKey` / `dedupMode` are promoted to top-level wire fields by the
            // desktop relay (engine_harness_message event spread) and on history
            // replay. Mirrors Go's HarnessMessageEvent json tags.
            let dedupKey = try container.decodeIfPresent(String.self, forKey: .dedupKey)
            let dedupMode = try container.decodeIfPresent(String.self, forKey: .dedupMode)
            return .engineHarnessMessage(tabId: tabId, instanceId: instanceId, message: message, source: source, metadata: metadata, dedupKey: dedupKey, dedupMode: dedupMode)

        // engineConversationHistory decode arm removed (WI-004 / #259).
        // History for every tab arrives via desktop_conversation_history
        // (TypeKey.conversationHistory), decoded in NormalizedEvent+Stream.swift.

        case .agentConversationHistory:
            let agentName = try container.decode(String.self, forKey: .agentName)
            let convId = try container.decodeIfPresent(String.self, forKey: .conversationId)
            let messages = try Message.decodeEngineArray(from: container, forKey: .messages)
            return .agentConversationHistory(agentName: agentName, conversationId: convId, messages: messages)

        case .engineModelOverride:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let model = try container.decode(String.self, forKey: .model)
            return .engineModelOverride(tabId: tabId, instanceId: instanceId, model: model)

        case .engineProfiles:
            let profiles = try container.decode([EngineProfile].self, forKey: .profiles)
            return .engineProfiles(profiles: profiles)

        case .enginePlanModeChanged:
            // State event: the engine session has entered or exited plan mode.
            // iOS uses planModeEnabled=true to insert a "Plan created" lifecycle
            // divider into engineMessages. planModeEnabled=false is a proposal
            // (ExitPlanMode) — the actual exit is gated by the desktop's
            // user-approval chokepoint. Fields mirror the Go-side
            // PlanModeChangedEvent: planModeEnabled, planFilePath, planSlug.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let planModeEnabled = try container.decodeIfPresent(Bool.self, forKey: .planModeEnabled) ?? false
            let planFilePath = try container.decodeIfPresent(String.self, forKey: .planFilePath)
            let planSlug = try container.decodeIfPresent(String.self, forKey: .planSlug)
            return .enginePlanModeChanged(tabId: tabId, instanceId: instanceId, planModeEnabled: planModeEnabled, planFilePath: planFilePath, planSlug: planSlug)

        case .enginePlanFileWritten:
            // State event: a Write/Edit landed on the canonical plan file. iOS
            // inserts the plan-lifecycle divider from THIS event (the actual
            // write), not from plan-mode entry — so the marker is correctly
            // positioned and its link resolves. operation discriminates
            // "created" vs "updated"; planFilePath/planSlug mirror the Go event.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let operation = try container.decodeIfPresent(String.self, forKey: .planWriteOperation) ?? "created"
            let planFilePath = try container.decodeIfPresent(String.self, forKey: .planFilePath)
            let planSlug = try container.decodeIfPresent(String.self, forKey: .planSlug)
            return .enginePlanFileWritten(tabId: tabId, instanceId: instanceId, operation: operation, planFilePath: planFilePath, planSlug: planSlug)

        case .enginePlanProposal:
            // Workflow event: the model has proposed a plan-mode transition.
            // iOS does not act on this event — the desktop is the authoritative
            // consumer — but the wire protocol stays uniform by decoding it
            // cleanly here. tabId / instanceId follow the standard engine
            // event shape; kind / planFilePath / planSlug match the Go-side
            // PlanProposalEvent struct one-to-one.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let kind = try container.decodeIfPresent(String.self, forKey: .planProposalKind) ?? ""
            let planFilePath = try container.decodeIfPresent(String.self, forKey: .planFilePath)
            let planSlug = try container.decodeIfPresent(String.self, forKey: .planSlug)
            return .enginePlanProposal(tabId: tabId, instanceId: instanceId, kind: kind, planFilePath: planFilePath, planSlug: planSlug)

        case .enginePlanModeAutoExit:
            // Decoder lives in NormalizedEvent+PlanModeAutoExit.swift to
            // keep this file under the per-file size cap. See ADR-007 and
            // issue #187.
            return try decodeEnginePlanModeAutoExit(container: container)

        case .engineEarlyStopDecisionRequest:
            // Engine ↔ harness wire-protocol request. iOS does not act on
            // this event — the desktop's early-stop-policy.ts is the
            // authoritative responder via the early_stop_decision_response
            // command. Decoding here keeps the wire protocol uniform across
            // consumers; observing the event is purely diagnostic on iOS.
            //
            // Every field is optional on the wire (Go side ships `omitempty`
            // throughout) so we default missing values to zero/empty rather
            // than failing the decode. The full payload reaches iOS even
            // when most fields are zero so future iOS work can read the
            // complete record without contract changes.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let requestId = try container.decodeIfPresent(String.self, forKey: .earlyStopRequestId) ?? ""
            let runId = try container.decodeIfPresent(String.self, forKey: .earlyStopRunId) ?? ""
            let model = try container.decodeIfPresent(String.self, forKey: .earlyStopModel) ?? ""
            let turnNumber = try container.decodeIfPresent(Int.self, forKey: .earlyStopTurnNumber) ?? 0
            let stopReason = try container.decodeIfPresent(String.self, forKey: .earlyStopStopReason) ?? ""
            let cumulativeOutput = try container.decodeIfPresent(Int.self, forKey: .earlyStopCumulativeOutput) ?? 0
            let budget = try container.decodeIfPresent(Int.self, forKey: .earlyStopBudget) ?? 0
            let thresholdPct = try container.decodeIfPresent(Int.self, forKey: .earlyStopThresholdPct) ?? 0
            let continuationCount = try container.decodeIfPresent(Int.self, forKey: .earlyStopContinuationCount) ?? 0
            let maxContinuations = try container.decodeIfPresent(Int.self, forKey: .earlyStopMaxContinuations) ?? 0
            let lastContinuationDelta = try container.decodeIfPresent(Int.self, forKey: .earlyStopLastContinuationDelta) ?? 0
            let wouldContinue = try container.decodeIfPresent(Bool.self, forKey: .earlyStopWouldContinue) ?? false
            let isSubagent = try container.decodeIfPresent(Bool.self, forKey: .earlyStopIsSubagent) ?? false
            return .engineEarlyStopDecisionRequest(
                tabId: tabId,
                instanceId: instanceId,
                requestId: requestId,
                runId: runId,
                model: model,
                turnNumber: turnNumber,
                stopReason: stopReason,
                cumulativeOutput: cumulativeOutput,
                budget: budget,
                thresholdPct: thresholdPct,
                continuationCount: continuationCount,
                maxContinuations: maxContinuations,
                lastContinuationDelta: lastContinuationDelta,
                wouldContinue: wouldContinue,
                isSubagent: isSubagent
            )

        default:
            // Not one of this file's arms: hand off to the tail decoder,
            // which owns the registry/command-result/export/intercept/image
            // group. Only when BOTH decline is the type genuinely unknown.
            return try decodeEngineTail(type: type, container: container)
        }
    }

}
