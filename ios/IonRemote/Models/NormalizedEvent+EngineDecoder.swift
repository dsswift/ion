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
            return .engineAgentState(tabId: tabId, instanceId: instanceId, agents: agents)

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
            return .engineToolEnd(tabId: tabId, instanceId: instanceId, toolId: toolId, result: result, isError: isError)

        case .engineToolStalled:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let elapsed = try container.decode(Double.self, forKey: .elapsed)
            return .engineToolStalled(tabId: tabId, instanceId: instanceId, toolId: toolId, toolName: toolName, elapsed: elapsed)

        case .engineRunStalled:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let stalledDuration = try container.decodeIfPresent(Double.self, forKey: .runStalledDuration) ?? 0
            let lastActivity = try container.decodeIfPresent(String.self, forKey: .runStalledLastActivity)
            return .engineRunStalled(tabId: tabId, instanceId: instanceId, stalledDuration: stalledDuration, lastActivity: lastActivity)

        case .engineSteerInjected:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let messageLength = try container.decode(Int.self, forKey: .steerMessageLength)
            return .engineSteerInjected(tabId: tabId, instanceId: instanceId, messageLength: messageLength)

        case .engineToolUpdate, .engineToolComplete, .engineScheduleFired, .engineLlmCall, .engineDispatchStart:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            switch type {
            case .engineToolUpdate: return .engineToolUpdate(tabId: tabId, instanceId: instanceId)
            case .engineToolComplete: return .engineToolComplete(tabId: tabId, instanceId: instanceId)
            case .engineScheduleFired: return .engineScheduleFired(tabId: tabId, instanceId: instanceId)
            case .engineLlmCall: return .engineLlmCall(tabId: tabId, instanceId: instanceId)
            case .engineDispatchStart: return .engineDispatchStart(tabId: tabId, instanceId: instanceId)
            default: return nil
            }

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

        case .engineExport:
            // Engine has rendered a /export payload. iOS surfaces it
            // via a share sheet (see SessionViewModel handler). The
            // engine reports the resolved format on `exportFormat`
            // (markdown by default) so the share sheet can attach a
            // correctly-typed file; nil when the engine predates the field.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decode(String.self, forKey: .message)
            let exportFormat = try container.decodeIfPresent(String.self, forKey: .exportFormat)
            return .engineExport(
                tabId: tabId,
                instanceId: instanceId,
                message: message,
                exportFormat: exportFormat
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

        case .engineIntercept:
            // Intercept event routed from the desktop after it has applied
            // its own focus-checking and redirect-orchestration logic.
            // iOS renders an inline banner in the engine conversation.
            // Fields match the desktop RemoteEvent wire shape exactly:
            // tabId (required), level, title, message, source?, metadata?.
            // `level` and `title` default to empty strings on missing values
            // (older desktops should never omit them, but be safe).
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let level = try container.decodeIfPresent(String.self, forKey: .level) ?? "banner"
            let title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let source = try container.decodeIfPresent(String.self, forKey: .source)
            let metadata = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata)
            return .engineIntercept(
                tabId: tabId,
                instanceId: instanceId,
                level: level,
                title: title,
                message: message,
                source: source,
                metadata: metadata
            )

        default:
            return nil
        }
    }

}
