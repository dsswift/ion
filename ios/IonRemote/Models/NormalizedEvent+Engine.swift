import Foundation

// MARK: - Engine events

// `decodeEngine(type:container:)` was extracted to NormalizedEvent+EngineDecoder.swift
// to keep this file under the 600-line Swift cap. Only `encodeEngine` lives here.

extension RemoteEvent {

    /// Encode engine events. Returns `true` if the receiver was an engine event.
    func encodeEngine(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .engineAgentState(let tabId, let instanceId, let agents, let metadataOmitted):
            try container.encode(TypeKey.engineAgentState, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(agents, forKey: .agents)
            // Only encoded when true, matching the desktop's optional field.
            if metadataOmitted { try container.encode(true, forKey: .metadataOmitted) }
            return true

        case .engineStatus(let tabId, let instanceId, let fields, let metadata):
            try container.encode(TypeKey.engineStatus, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(fields, forKey: .fields)
            try container.encodeIfPresent(metadata, forKey: .metadata)
            return true

        case .engineSessionStatus(let tabId, let instanceId, let sessionStatus, let metadata):
            try container.encode(TypeKey.engineSessionStatus, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(sessionStatus, forKey: .sessionStatus)
            try container.encodeIfPresent(metadata, forKey: .metadata)
            return true

        case .engineWorkingMessage(let tabId, let instanceId, let message, let metadata):
            try container.encode(TypeKey.engineWorkingMessage, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(metadata, forKey: .metadata)
            return true

        case .engineToolStalled(let tabId, let instanceId, let toolId, let toolName, let elapsed):
            try container.encode(TypeKey.engineToolStalled, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolId, forKey: .toolId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(elapsed, forKey: .elapsed)
            return true

        case .engineBackgroundTaskStarted(let tabId, let instanceId, let taskId, let toolId, let command, let startedAt, let notifyOnComplete):
            try container.encode(TypeKey.engineBackgroundTaskStarted, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(
                BackgroundTaskState(taskId: taskId, toolId: toolId, command: command, startedAt: startedAt, notifyOnComplete: notifyOnComplete),
                forKey: .task
            )
            return true

        case .engineBackgroundTaskTerminal(let tabId, let instanceId, let taskId, let status, let exitCode, let elapsedMs, let command, let outputPath, let tail):
            try container.encode(TypeKey.engineBackgroundTaskTerminal, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(taskId, forKey: .taskId)
            try container.encode(status, forKey: .status)
            try container.encodeIfPresent(exitCode, forKey: .exitCode)
            try container.encodeIfPresent(elapsedMs, forKey: .elapsedMs)
            try container.encodeIfPresent(command, forKey: .command)
            try container.encodeIfPresent(outputPath, forKey: .outputPath)
            try container.encodeIfPresent(tail, forKey: .tail)
            return true

        case .engineSessionWorkStopped(let tabId, let instanceId, let scope, let cancelledRunId, let recalledDispatchIds, let stoppedTaskIds, let killedAgentProcessCount):
            try container.encode(TypeKey.engineSessionWorkStopped, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(scope, forKey: .scope)
            try container.encodeIfPresent(cancelledRunId, forKey: .cancelledRunId)
            try container.encodeIfPresent(recalledDispatchIds, forKey: .recalledDispatchIds)
            try container.encode(stoppedTaskIds, forKey: .stoppedBackgroundTaskIds)
            try container.encodeIfPresent(killedAgentProcessCount, forKey: .killedAgentProcessCount)
            return true

        case .engineRunStalled(let tabId, let instanceId, let stalledDuration, let lastActivity):
            try container.encode(TypeKey.engineRunStalled, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(stalledDuration, forKey: .runStalledDuration)
            try container.encodeIfPresent(lastActivity, forKey: .runStalledLastActivity)
            return true

        case .engineSteerInterruptedStream(let tabId, let instanceId, let blocksKept, let queuedSteers):
            try container.encode(TypeKey.engineSteerInterruptedStream, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encodeIfPresent(blocksKept, forKey: .steerInterruptBlocksKept)
            try container.encodeIfPresent(queuedSteers, forKey: .steerQueuedCount)
            return true

        case .engineRewindResult(let tabId, let instanceId, let error):
            // Encoder mirror for engine_rewind_result. iOS never originates
            // this event; the encoder enables round-trip tests. `status` is
            // omitted — the desktop always sends "rejected" (transactional,
            // rejection-only), and the Swift case models only the data a
            // refusal actually carries.
            try container.encode(TypeKey.engineRewindResult, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encodeIfPresent(error, forKey: .error)
            return true

        case .engineToolComplete(let tabId, let instanceId):
            try container.encode(TypeKey.engineToolComplete, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            return true
        case .engineScheduleFired(let tabId, let instanceId):
            try container.encode(TypeKey.engineScheduleFired, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            return true
        case .engineLlmCall(let tabId, let instanceId):
            try container.encode(TypeKey.engineLlmCall, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            return true
        case .engineDispatchStart(let tabId, let instanceId, let agent, let sessionId, let model, let task, let depth, let parentId, let dispatchId):
            try container.encode(TypeKey.engineDispatchStart, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(agent, forKey: .dispatchAgent)
            try container.encode(sessionId, forKey: .dispatchSessionId)
            try container.encode(model, forKey: .dispatchModel)
            try container.encode(task, forKey: .dispatchTask)
            try container.encode(depth, forKey: .dispatchDepth)
            try container.encode(parentId, forKey: .dispatchParentId)
            try container.encode(dispatchId, forKey: .dispatchId)
            return true
        case .engineDispatchEnd(let tabId, let instanceId, let agent, let depth, let parentId, let exitCode, let elapsed, let dispatchId, let conversationId):
            try container.encode(TypeKey.engineDispatchEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(agent, forKey: .dispatchAgent)
            try container.encode(depth, forKey: .dispatchDepth)
            try container.encode(parentId, forKey: .dispatchParentId)
            try container.encode(exitCode, forKey: .dispatchExitCode)
            try container.encode(elapsed, forKey: .dispatchElapsed)
            try container.encode(dispatchId, forKey: .dispatchId)
            try container.encodeIfPresent(conversationId, forKey: .dispatchConversationId)
            return true

        case .engineError(let tabId, let instanceId, let message, let stderrTail):
            try container.encode(TypeKey.engineError, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            if !stderrTail.isEmpty {
                try container.encode(stderrTail, forKey: .stderrTail)
            }
            return true

        case .engineDialog(let tabId, let instanceId, let dialogId, let method, let title, let options, let defaultValue):
            try container.encode(TypeKey.engineDialog, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(dialogId, forKey: .dialogId)
            try container.encode(method, forKey: .method)
            try container.encode(title, forKey: .title)
            try container.encodeIfPresent(options, forKey: .options)
            try container.encodeIfPresent(defaultValue, forKey: .defaultValue)
            return true

        case .engineDialogResolved(let tabId, let instanceId, let dialogId):
            try container.encode(TypeKey.engineDialogResolved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(dialogId, forKey: .dialogId)
            return true

        case .engineMessageEnd(let tabId, let instanceId, let inputTokens, let outputTokens, let contextPercent, let cost, let entryId, let userEntryId):
            try container.encode(TypeKey.engineMessageEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(EngineMessageEndUsage(inputTokens: inputTokens, outputTokens: outputTokens, contextPercent: contextPercent, cost: cost, entryId: entryId, userEntryId: userEntryId), forKey: .usage)
            return true

        case .engineDead(let tabId, let instanceId, let exitCode, let signal, let stderrTail):
            try container.encode(TypeKey.engineDead, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encodeIfPresent(exitCode, forKey: .exitCode)
            try container.encodeIfPresent(signal, forKey: .signal)
            try container.encode(stderrTail, forKey: .stderrTail)
            return true

        case .engineInstanceAdded(let tabId, let instanceId, let label):
            try container.encode(TypeKey.engineInstanceAdded, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(ConversationInstancePayload(id: instanceId, label: label), forKey: .instance)
            return true

        case .engineInstanceRemoved(let tabId, let instanceId):
            try container.encode(TypeKey.engineInstanceRemoved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            return true

        case .engineInstanceMoved(let sourceTabId, let instanceId, let targetTabId):
            try container.encode(TypeKey.engineInstanceMoved, forKey: .type)
            try container.encode(sourceTabId, forKey: .sourceTabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(targetTabId, forKey: .targetTabId)
            return true

        // engineConversationHistory encode arm removed (WI-004 / #259).
        // History is delivered via desktop_conversation_history; there is
        // no engine-side NormalizedEvent case to encode for it.

        case .engineModelOverride(let tabId, let instanceId, let model):
            try container.encode(TypeKey.engineModelOverride, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(model, forKey: .model)
            return true

        case .engineProfiles(let profiles):
            try container.encode(TypeKey.engineProfiles, forKey: .type)
            try container.encode(profiles, forKey: .profiles)
            return true

        case .enginePlanModeChanged(let tabId, let instanceId, let planModeEnabled, let planFilePath, let planSlug):
            try container.encode(TypeKey.enginePlanModeChanged, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(planModeEnabled, forKey: .planModeEnabled)
            try container.encodeIfPresent(planFilePath, forKey: .planFilePath)
            try container.encodeIfPresent(planSlug, forKey: .planSlug)
            return true

        case .enginePlanProposal(let tabId, let instanceId, let kind, let planFilePath, let planSlug):
            try container.encode(TypeKey.enginePlanProposal, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(kind, forKey: .planProposalKind)
            try container.encodeIfPresent(planFilePath, forKey: .planFilePath)
            try container.encodeIfPresent(planSlug, forKey: .planSlug)
            return true

        case .enginePlanModeAutoExit(
            let tabId, let instanceId, let stopReason,
            let planFilePath, let planSlug,
            let reason, let sessionId, let runId
        ):
            // Encoder lives in NormalizedEvent+PlanModeAutoExit.swift to
            // keep this file under the per-file size cap. See ADR-007 and
            // issue #187.
            try encodeEnginePlanModeAutoExit(
                container: &container,
                tabId: tabId, instanceId: instanceId, stopReason: stopReason,
                planFilePath: planFilePath, planSlug: planSlug,
                reason: reason, sessionId: sessionId, runId: runId
            )
            return true

        case .engineEarlyStopDecisionRequest(let tabId, let instanceId, let requestId, let runId, let model, let turnNumber, let stopReason, let cumulativeOutput, let budget, let thresholdPct, let continuationCount, let maxContinuations, let lastContinuationDelta, let wouldContinue, let eligible, let isSubagent):
            // Encoder mirror of the decoder above. iOS never originates
            // this event in practice (the engine emits it, iOS observes),
            // but the encoder must round-trip cleanly so that re-encoded
            // events in tests and diagnostic dumps don't lose fields. We
            // emit every field unconditionally rather than chasing
            // omitempty parity with the Go side; the wire shape on
            // re-encode is a superset of the Go-emitted shape, which is
            // strictly safer for downstream decoders.
            try container.encode(TypeKey.engineEarlyStopDecisionRequest, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(requestId, forKey: .earlyStopRequestId)
            try container.encode(runId, forKey: .earlyStopRunId)
            try container.encode(model, forKey: .earlyStopModel)
            try container.encode(turnNumber, forKey: .earlyStopTurnNumber)
            try container.encode(stopReason, forKey: .earlyStopStopReason)
            try container.encode(cumulativeOutput, forKey: .earlyStopCumulativeOutput)
            try container.encode(budget, forKey: .earlyStopBudget)
            try container.encode(thresholdPct, forKey: .earlyStopThresholdPct)
            try container.encode(continuationCount, forKey: .earlyStopContinuationCount)
            try container.encode(maxContinuations, forKey: .earlyStopMaxContinuations)
            try container.encode(lastContinuationDelta, forKey: .earlyStopLastContinuationDelta)
            try container.encode(wouldContinue, forKey: .earlyStopWouldContinue)
            try container.encode(eligible, forKey: .earlyStopEligible)
            try container.encode(isSubagent, forKey: .earlyStopIsSubagent)
            return true

        case .engineCommandRegistry(let tabId, let instanceId, let commands):
            // Encoder mirror of the decoder above. iOS never originates
            // this event — the engine emits, iOS observes — but the
            // encoder ships so round-trip tests pass and diagnostic
            // dumps lose no information. Always emit the `commands`
            // array even when empty: an empty list is the AUTHORITATIVE
            // "no extension commands" signal per snapshot semantics
            // (see EngineCommandListing struct doc); omitting it would
            // be observationally different.
            try container.encode(TypeKey.engineCommandRegistry, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(commands, forKey: .commands)
            return true

        case .engineCommandResult(let tabId, let instanceId, let message, let command, let commandError):
            // Encoder mirror of the decoder above. Each of the three
            // payload fields is independently optional on the wire, so
            // we use encodeIfPresent so an absent field stays absent
            // on round-trip (rather than appearing as JSON null).
            try container.encode(TypeKey.engineCommandResult, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encodeIfPresent(message, forKey: .message)
            try container.encodeIfPresent(command, forKey: .command)
            try container.encodeIfPresent(commandError, forKey: .commandError)
            return true

        case .engineExport(let tabId, let instanceId, let message, let exportFormat):
            // Encoder mirror of the decoder. The message field is the
            // rendered export payload — non-optional because an empty
            // export would be a no-op the engine wouldn't emit. exportFormat
            // is optional (nil for legacy-engine round-trips).
            try container.encode(TypeKey.engineExport, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(exportFormat, forKey: .exportFormat)
            return true

        case .engineResourceSnapshot(let tabId, let instanceId, let resourceKind, let resourceSubId, let resourceItems, let resourceProducers):
            // Handled by NormalizedEvent+Resource.swift.
            _ = tabId; _ = instanceId; _ = resourceKind; _ = resourceSubId; _ = resourceItems; _ = resourceProducers
            return false

        case .engineResourceDelta(let tabId, let instanceId, let resourceKind, let resourceSubId, let resourceDelta):
            // Handled by NormalizedEvent+Resource.swift.
            _ = tabId; _ = instanceId; _ = resourceKind; _ = resourceSubId; _ = resourceDelta
            return false

        case .engineResourceItem(let tabId, let instanceId, let resourceKind, let resourceItem):
            // Handled by NormalizedEvent+Resource.swift.
            _ = tabId; _ = instanceId; _ = resourceKind; _ = resourceItem
            return false

        case .desktopSettingsSnapshot(let settings, let schema, let groups, let newConversationPolicy, let themePolicy, let canManageEnvironment, let pages):
            try container.encode(TypeKey.desktopSettingsSnapshot, forKey: .type)
            try container.encode(settings, forKey: .settings)
            try container.encode(schema, forKey: .schema)
            try container.encode(groups, forKey: .groups)
            try container.encodeIfPresent(newConversationPolicy, forKey: .newConversationPolicy)
            try container.encodeIfPresent(themePolicy, forKey: .themePolicy)
            try container.encodeIfPresent(canManageEnvironment, forKey: .canManageEnvironment)
            try container.encodeIfPresent(pages, forKey: .pages)
            return true

        case .desktopThemeManifest(let themes, let hash):
            try container.encode(TypeKey.desktopThemeManifest, forKey: .type)
            try container.encode(themes, forKey: .themes)
            try container.encode(hash, forKey: .hash)
            return true

        case .desktopThemeAssetContent(let themeId, let slot, let ok, let sha256, let dataUrl):
            try container.encode(TypeKey.desktopThemeAssetContent, forKey: .type)
            try container.encode(themeId, forKey: .themeId)
            try container.encode(slot, forKey: .slot)
            try container.encode(ok, forKey: .ok)
            try container.encodeIfPresent(sha256, forKey: .sha256)
            try container.encodeIfPresent(dataUrl, forKey: .dataUrl)
            return true

        case .desktopContextBreakdown(let tabId, let instanceId, let breakdown):
            // Encoder mirror for desktop_context_breakdown. iOS never originates
            // this event; the encoder enables round-trip tests.
            try container.encode(TypeKey.desktopContextBreakdown, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(breakdown, forKey: .contextBreakdown)
            return true

        default:
            return false
        }
    }
}

