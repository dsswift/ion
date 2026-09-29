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
                toolId: payload.toolId,
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

        case .engineToolComplete, .engineScheduleFired, .engineLlmCall:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            switch type {
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

        case .engineError:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let stderrTail = try container.decodeIfPresent([String].self, forKey: .stderrTail) ?? []
            return .engineError(tabId: tabId, instanceId: instanceId, message: message, stderrTail: stderrTail)

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

        case .engineMessageEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            // Usage is a nested object: { inputTokens, outputTokens,
            // contextPercent, cost, entryId?, userEntryId? }. The canonical
            // entry ids ride inside usage on the wire (Go MessageEndUsage);
            // they surface as top-level associated values on the Swift case.
            let usage = try container.decodeIfPresent(EngineMessageEndUsage.self, forKey: .usage)
            return .engineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, contextPercent: usage?.contextPercent ?? 0, cost: usage?.cost ?? 0, entryId: usage?.entryId, userEntryId: usage?.userEntryId)

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
            let eligible = try container.decodeIfPresent(Bool.self, forKey: .earlyStopEligible) ?? false
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
                eligible: eligible,
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
