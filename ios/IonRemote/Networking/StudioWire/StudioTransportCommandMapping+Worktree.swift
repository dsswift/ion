import Foundation

/// The worktree and integration-bench replies.
///
/// Every verb publishes the refreshed state on its own, so the only thing
/// synthesized here is the per-operation outcome the older wire delivered as
/// `desktop_worktree_op_result` — which is what tells a refusal (dirty tree,
/// conflicts) apart from a failure.
extension StudioTransportCommandMapping {

    /// Nil means this command is not a worktree or bench command.
    // swiftlint:disable:next cyclomatic_complexity
    static func worktreeEvents(for command: RemoteCommand, call: StudioActionCall, result: JSONValue) -> [RemoteEvent]? {
        switch command {
        case .worktreeRefresh:
            guard let state = decode(result, as: RemoteWorktreeState.self, what: "worktree state") else { return [] }
            return [.worktreeState(states: [state])]

        // Verbs that answer `{ok, error, ...}`.
        case .worktreeSync:
            return opResult("sync", from: result)
        case .worktreeLandAndRetire:
            return opResult("land_and_retire", from: result)
        case .worktreeCreate:
            return opResult("create", from: result)
        case .worktreeConvertConversation:
            return opResult("convert", from: result)
        case .worktreeRename:
            return opResult("rename", from: result)
        case .worktreeReprovision:
            return opResult("reprovision", from: result)
        case .worktreeRetire, .worktreeRetireLanded:
            return opResult("retire", from: result)
        case .benchAssemble:
            return opResult("assemble", from: result)
        case .benchUpdateMember:
            return opResult("update", from: result)
        case .benchUpdateAll:
            return opResult("update_all", from: result)
        case .benchDiscardMemberRecordings:
            return opResult("discard_recordings", from: result)
        case .benchDiscardAllRecordings:
            guard call.action == "benchRerereDiscardAll" else { return [] }
            return opResult("discard_recordings", ok: true)

        // Verbs that answer a tab id, or null when they opened nothing.
        case .worktreeOpenConversation, .worktreeConflictAssist, .benchOpenConversation, .benchOpenTerminal,
             .benchAnalyseVerification:
            return opened(command, result)
        case .benchConflictAssist:
            // The first call recovers the bench and answers its path; the
            // conversation is opened by the call that follows it.
            guard call.action == "openConflictAssist" else {
                return result.isNull ? opResult("conflict_assist", ok: false, error: "There is no conflicted bench to resolve") : []
            }
            return opened(command, result)
        case .benchRecoverConflict:
            return opResult("recover_conflict", ok: !result.isNull)

        // Verbs whose whole outcome is the refreshed state the server publishes.
        case .worktreeSyncAll, .worktreeSetStage, .benchReorderMember, .benchAddMember, .benchRemoveMember,
             .worktreePipelineStart, .worktreePipelineConfirmAi, .worktreePipelineCancel, .worktreePipelineDismiss:
            return []

        default:
            return nil
        }
    }

    /// A worktree verb that failed reads as a refusal of that same operation,
    /// so one panel renders both without knowing which wire it is on.
    static func worktreeFailureEvents(for command: RemoteCommand, message: String) -> [RemoteEvent]? {
        switch command {
        case .worktreeSync: return opResult("sync", ok: false, error: message)
        case .worktreeLandAndRetire: return opResult("land_and_retire", ok: false, error: message)
        case .worktreeCreate: return opResult("create", ok: false, error: message)
        case .worktreeConvertConversation: return opResult("convert", ok: false, error: message)
        case .worktreeRename: return opResult("rename", ok: false, error: message)
        case .worktreeReprovision: return opResult("reprovision", ok: false, error: message)
        case .worktreeRetire, .worktreeRetireLanded: return opResult("retire", ok: false, error: message)
        case .worktreeSetStage, .benchReorderMember, .benchAddMember, .benchRemoveMember, .benchUpdateMember:
            return opResult("update", ok: false, error: message)
        case .benchAssemble: return opResult("assemble", ok: false, error: message)
        case .benchUpdateAll: return opResult("update_all", ok: false, error: message)
        case .benchDiscardMemberRecordings, .benchDiscardAllRecordings:
            return opResult("discard_recordings", ok: false, error: message)
        case .worktreeOpenConversation, .worktreeConflictAssist, .benchOpenConversation, .benchOpenTerminal,
             .benchAnalyseVerification, .benchConflictAssist:
            return opResult(operationName(command), ok: false, error: message)
        case .benchRecoverConflict: return opResult("recover_conflict", ok: false, error: message)
        case .worktreePipelineStart: return opResult("pipeline_start", ok: false, error: message)
        case .worktreeSyncAll: return opResult("sync_all", ok: false, error: message)
        default: return nil
        }
    }

    // MARK: - Building the outcome

    /// Which operation a verb that opens something reports as.
    private static func operationName(_ command: RemoteCommand) -> String {
        switch command {
        case .worktreeConflictAssist, .benchConflictAssist: return "conflict_assist"
        case .benchAnalyseVerification: return "analyse_verification"
        default: return "open"
        }
    }

    /// A verb that opened a conversation: the value is its tab id, or null when
    /// nothing was opened.
    private static func opened(_ command: RemoteCommand, _ result: JSONValue) -> [RemoteEvent] {
        let operation = operationName(command)
        guard let tabId = result.stringValue else { return opResult(operation, ok: false) }
        return opResult(operation, ok: true, tabId: tabId)
    }

    /// The outcome the verb reported, with every member it carries.
    private static func opResult(_ operation: String, from value: JSONValue) -> [RemoteEvent] {
        var fields: [String: JSONValue] = value.objectValue ?? [:]
        fields["operation"] = .string(operation)
        fields["ok"] = .bool(value["ok"]?.boolValue ?? false)
        return event(fields, operation: operation)
    }

    private static func opResult(_ operation: String, ok: Bool, error: String? = nil, tabId: String? = nil) -> [RemoteEvent] {
        var fields: [String: JSONValue] = ["operation": .string(operation), "ok": .bool(ok)]
        if let error { fields["error"] = .string(error) }
        if let tabId { fields["tabId"] = .string(tabId) }
        return event(fields, operation: operation)
    }

    /// The op-result event, built by decoding so a member this build does not
    /// read yet still travels. An operation name the client cannot decode is a
    /// wire drift: `decode` logs it at error level, and no event is made.
    private static func event(_ fields: [String: JSONValue], operation: String) -> [RemoteEvent] {
        guard let result = decode(.object(fields), as: RemoteWorktreeOpResult.self, what: "worktree op result \(operation)") else {
            return []
        }
        return [.worktreeOpResult(result: result)]
    }
}
