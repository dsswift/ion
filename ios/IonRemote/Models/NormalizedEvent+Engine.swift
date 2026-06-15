import Foundation

// MARK: - Engine events

// `decodeEngine(type:container:)` was extracted to NormalizedEvent+EngineDecoder.swift
// to keep this file under the 600-line Swift cap. Only `encodeEngine` lives here.

extension RemoteEvent {

    /// Encode engine events. Returns `true` if the receiver was an engine event.
    func encodeEngine(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .engineAgentState(let tabId, let instanceId, let agents):
            try container.encode(TypeKey.engineAgentState, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(agents, forKey: .agents)
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

        case .engineToolStart(let tabId, let instanceId, let toolName, let toolId):
            try container.encode(TypeKey.engineToolStart, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(toolId, forKey: .toolId)
            return true

        case .engineToolEnd(let tabId, let instanceId, let toolId, let result, let isError):
            try container.encode(TypeKey.engineToolEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolId, forKey: .toolId)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encode(isError, forKey: .isError)
            return true

        case .engineToolStalled(let tabId, let instanceId, let toolId, let toolName, let elapsed):
            try container.encode(TypeKey.engineToolStalled, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolId, forKey: .toolId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(elapsed, forKey: .elapsed)
            return true

        case .engineRunStalled(let tabId, let instanceId, let stalledDuration, let lastActivity):
            try container.encode(TypeKey.engineRunStalled, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(stalledDuration, forKey: .runStalledDuration)
            try container.encodeIfPresent(lastActivity, forKey: .runStalledLastActivity)
            return true

        case .engineSteerInjected(let tabId, let instanceId, let messageLength):
            try container.encode(TypeKey.engineSteerInjected, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(messageLength, forKey: .steerMessageLength)
            return true

        case .engineToolUpdate(let tabId, let instanceId):
            try container.encode(TypeKey.engineToolUpdate, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
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
        case .engineDispatchStart(let tabId, let instanceId):
            try container.encode(TypeKey.engineDispatchStart, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            return true

        case .engineError(let tabId, let instanceId, let message):
            try container.encode(TypeKey.engineError, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            return true

        case .engineNotify(let tabId, let instanceId, let message, let level, let metadata):
            try container.encode(TypeKey.engineNotify, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            try container.encode(level, forKey: .level)
            try container.encodeIfPresent(metadata, forKey: .metadata)
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

        case .engineTextDelta(let tabId, let instanceId, let text):
            try container.encode(TypeKey.engineTextDelta, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(text, forKey: .text)
            return true

        case .engineMessageEnd(let tabId, let instanceId, let inputTokens, let outputTokens, let contextPercent, let cost):
            try container.encode(TypeKey.engineMessageEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(EngineMessageEndUsage(inputTokens: inputTokens, outputTokens: outputTokens, contextPercent: contextPercent, cost: cost), forKey: .usage)
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

        case .engineHarnessMessage(let tabId, let instanceId, let message, let source, let metadata):
            try container.encode(TypeKey.engineHarnessMessage, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(source, forKey: .source)
            try container.encodeIfPresent(metadata, forKey: .metadata)
            return true

        case .engineConversationHistory(let tabId, let instanceId, let messages):
            try container.encode(TypeKey.engineConversationHistory, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(messages, forKey: .messages)
            return true

        case .agentConversationHistory(let agentName, let conversationId, let messages):
            try container.encode(TypeKey.agentConversationHistory, forKey: .type)
            try container.encode(agentName, forKey: .agentName)
            try container.encodeIfPresent(conversationId, forKey: .conversationId)
            try container.encode(messages, forKey: .messages)
            return true

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

        case .engineEarlyStopDecisionRequest(let tabId, let instanceId, let requestId, let runId, let model, let turnNumber, let stopReason, let cumulativeOutput, let budget, let thresholdPct, let continuationCount, let maxContinuations, let lastContinuationDelta, let wouldContinue, let isSubagent):
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

        case .engineResourceSnapshot(let tabId, let instanceId, let resourceKind, let resourceSubId, let resourceItems):
            // Handled by NormalizedEvent+Resource.swift.
            _ = tabId; _ = instanceId; _ = resourceKind; _ = resourceSubId; _ = resourceItems
            return false

        case .engineResourceDelta(let tabId, let instanceId, let resourceKind, let resourceSubId, let resourceDelta):
            // Handled by NormalizedEvent+Resource.swift.
            _ = tabId; _ = instanceId; _ = resourceKind; _ = resourceSubId; _ = resourceDelta
            return false

        case .desktopSettingsSnapshot(let settings, let schema, let groups):
            try container.encode(TypeKey.desktopSettingsSnapshot, forKey: .type)
            try container.encode(settings, forKey: .settings)
            try container.encode(schema, forKey: .schema)
            try container.encode(groups, forKey: .groups)
            return true

        case .engineIntercept(let tabId, let instanceId, let level, let title, let message, let source, let metadata):
            // Encoder mirror of the decoder above. iOS never originates
            // this event (the engine+desktop emit it), but the encoder
            // must round-trip cleanly for tests and diagnostic dumps.
            try container.encode(TypeKey.engineIntercept, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(level, forKey: .level)
            try container.encode(title, forKey: .title)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(source, forKey: .source)
            try container.encodeIfPresent(metadata, forKey: .metadata)
            return true

        default:
            return false
        }
    }
}

