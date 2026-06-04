import Foundation

// MARK: - Engine events

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
            return .engineAgentState(tabId: tabId, instanceId: instanceId, agents: agents)

        case .engineStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let fields = try container.decode(StatusFields.self, forKey: .fields)
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineStatus(tabId: tabId, instanceId: instanceId, fields: fields, metadata: metadata)

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
            return .engineToolEnd(tabId: tabId, instanceId: instanceId, toolId: toolId, result: result, isError: isError)

        case .engineToolStalled:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let elapsed = try container.decode(Double.self, forKey: .elapsed)
            return .engineToolStalled(tabId: tabId, instanceId: instanceId, toolId: toolId, toolName: toolName, elapsed: elapsed)

        case .engineSteerInjected:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let messageLength = try container.decode(Int.self, forKey: .steerMessageLength)
            return .engineSteerInjected(tabId: tabId, instanceId: instanceId, messageLength: messageLength)

        case .engineError:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            return .engineError(tabId: tabId, instanceId: instanceId, message: message)

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

        case .engineMessageEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            // Usage is a nested object: { inputTokens, outputTokens, contextPercent, cost }
            let usage = try container.decodeIfPresent(EngineMessageEndUsage.self, forKey: .usage)
            return .engineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, contextPercent: usage?.contextPercent ?? 0, cost: usage?.cost ?? 0)

        case .engineDead:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
            let signal = try container.decodeIfPresent(String.self, forKey: .signal)
            let stderrTail = try container.decodeIfPresent([String].self, forKey: .stderrTail) ?? []
            return .engineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        case .engineInstanceAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instance = try container.decode(EngineInstancePayload.self, forKey: .instance)
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
            // `metadata` is an opaque hint map (e.g. dedupKey) the harness
            // sets via ctx.emit and the engine forwards verbatim. Decoded
            // as [String: AnyCodable] so future iOS-side handlers can read
            // typed values without a contract change. iOS does not yet
            // honor any specific key — desktop is the only consumer today.
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineHarnessMessage(tabId: tabId, instanceId: instanceId, message: message, source: source, metadata: metadata)

        case .engineConversationHistory:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let messages = try Message.decodeEngineArray(from: container, forKey: .messages)
            return .engineConversationHistory(tabId: tabId, instanceId: instanceId, messages: messages)

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

        case .engineCommandRegistry:
            // Slash-command registry snapshot. Snapshot semantics —
            // REPLACE the cached set wholesale; never merge. Empty
            // `commands` is the authoritative "no extension commands"
            // signal, not a no-op. iOS does not yet act on this — the
            // desktop's prompt pipeline owns the routing-hint cache —
            // but we decode cleanly so the wire stays uniform.
            // Field correlation: tabId/instanceId are session
            // correlators; `commands` is the full snapshot payload.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let commands = try container.decodeIfPresent([EngineCommandListing].self, forKey: .commands) ?? []
            return .engineCommandRegistry(
                tabId: tabId,
                instanceId: instanceId,
                commands: commands
            )

        case .engineCommandResult:
            // Result of an engine SendCommand dispatch. The three
            // payload fields are independently optional:
            //   - `message` may be empty when the dispatch produced no
            //     human-readable note (most success cases).
            //   - `command` may be empty for the catch-all unknown-
            //     command emit before the engine resolved the name.
            //   - `commandError` is set only on failure (extension
            //     error or "unknown_command").
            // The desktop's prompt pipeline awaits this event to decide
            // dispatch success vs fallback; iOS does not act on it
            // today.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message)
            let command = try container.decodeIfPresent(String.self, forKey: .command)
            let commandError = try container.decodeIfPresent(String.self, forKey: .commandError)
            return .engineCommandResult(
                tabId: tabId,
                instanceId: instanceId,
                message: message,
                command: command,
                commandError: commandError
            )

        case .desktopSettingsSnapshot:
            // Per-desktop user-preferences projection. The whole payload
            // is wholesale-replace: SessionViewModel discards its
            // previous snapshot and adopts this one verbatim. iOS does
            // not merge values across snapshots — same semantics as
            // engine_agent_state. See DesktopSettingsModel.swift for
            // the higher-level state struct the view binds to.
            let settings = try container.decode([String: AnyCodable].self, forKey: .settings)
            let schema = try container.decode([DesktopSettingSchemaEntry].self, forKey: .schema)
            let groups = try container.decode([DesktopSettingGroupDescriptor].self, forKey: .groups)
            return .desktopSettingsSnapshot(settings: settings, schema: schema, groups: groups)

        default:
            return nil
        }
    }

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

        case .engineSteerInjected(let tabId, let instanceId, let messageLength):
            try container.encode(TypeKey.engineSteerInjected, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(messageLength, forKey: .steerMessageLength)
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
            try container.encode(EngineInstancePayload(id: instanceId, label: label), forKey: .instance)
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

        case .desktopSettingsSnapshot(let settings, let schema, let groups):
            try container.encode(TypeKey.desktopSettingsSnapshot, forKey: .type)
            try container.encode(settings, forKey: .settings)
            try container.encode(schema, forKey: .schema)
            try container.encode(groups, forKey: .groups)
            return true

        default:
            return false
        }
    }
}

